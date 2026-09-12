//! The chain, as the native engine sees it: `public/dsp/chain.wasm` under
//! wasmtime.
//!
//! The Rust twin of `public/dsp/chain-core.js`, and as thin: it moves samples
//! in and out and calls exports by name. What the chain does is not written
//! here, which is why the browser and the engine cannot disagree about it.
//!
//! Real time: after `Chain::new`, `process` and the samples views allocate
//! nothing. Calls allocate only inside the chain, when it loads content —
//! exactly as they do in the browser's worklet.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use wasmtime::{
    Caller, Config, Engine, Extern, ExternType, Func, Linker, Memory, Module, OptLevel, Store,
    TypedFunc, Val, ValType,
};

/// The ABI this host was written against (`schema/chain.ts`).
pub const ABI_VERSION: i32 = 1;

/// The most arguments any export takes, payload pointer and length included.
pub const MAX_ARGS: usize = 10;

/// What the standalone module may import. None of these is on the audio
/// path: they are what libc does on an error path, and memory growth.
const KNOWN_IMPORTS: &[(&str, &str)] = &[
    ("env", "emscripten_notify_memory_growth"),
    ("wasi_snapshot_preview1", "fd_close"),
    ("wasi_snapshot_preview1", "fd_write"),
    ("wasi_snapshot_preview1", "fd_seek"),
    ("wasi_snapshot_preview1", "fd_read"),
    ("wasi_snapshot_preview1", "environ_sizes_get"),
    ("wasi_snapshot_preview1", "environ_get"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    I32,
    F32,
}

/// A callable export: its name and what it takes.
#[derive(Clone, Debug)]
pub struct Export {
    pub name: String,
    pub params: Vec<Kind>,
    pub result: Option<Kind>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The `^tc_[a-z0-9_]+$` rule, without a regex dependency.
fn callable(name: &str) -> bool {
    name.len() > 3
        && name.starts_with("tc_")
        && name[3..]
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}

/// Compiles the chain, once per distinct file. A page reconnecting after a
/// reload uploads the same bytes again; recompiling them would cost a second
/// of Cranelift for nothing.
pub struct Compiler {
    engine: Engine,
    cached: Option<(u64, Module)>,
}

impl Compiler {
    pub fn new() -> Result<Self, String> {
        let mut config = Config::new();
        config.cranelift_opt_level(OptLevel::Speed);
        config.wasm_simd(true);
        // The standard exception-handling proposal: a malformed capture is a
        // refused load inside the chain, not a trap that kills it.
        config.wasm_exceptions(true);
        // The wasm stack lives on whichever thread calls in, and on ASIO that
        // is the driver's own thread, whose stack we do not choose. The chain's
        // deep stack (JSON parsing) is in linear memory; its native frames are
        // shallow. A modest limit keeps wasmtime's overflow check honest.
        config.max_wasm_stack(256 * 1024);
        Ok(Self {
            engine: Engine::new(&config).map_err(err)?,
            cached: None,
        })
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    pub fn module(&self) -> Option<&Module> {
        self.cached.as_ref().map(|(_, m)| m)
    }

    pub fn compile(&mut self, bytes: &[u8]) -> Result<Module, String> {
        let mut hasher = DefaultHasher::new();
        bytes.hash(&mut hasher);
        let key = hasher.finish();
        if let Some((k, module)) = &self.cached
            && *k == key
        {
            return Ok(module.clone());
        }
        let module = Module::new(&self.engine, bytes).map_err(err)?;
        for import in module.imports() {
            if !KNOWN_IMPORTS.contains(&(import.module(), import.name())) {
                return Err(format!(
                    "the chain imports {}.{}, which this engine does not provide: update Tonecraft Engine",
                    import.module(),
                    import.name()
                ));
            }
        }
        self.cached = Some((key, module.clone()));
        Ok(module)
    }
}

fn linker(engine: &Engine) -> Result<Linker<()>, String> {
    let mut l: Linker<()> = Linker::new(engine);
    l.func_wrap("env", "emscripten_notify_memory_growth", |_: i32| {})
        .map_err(err)?;
    l.func_wrap("wasi_snapshot_preview1", "fd_close", |_: i32| -> i32 { 0 })
        .map_err(err)?;
    // ESPIPE: nothing here is seekable.
    l.func_wrap(
        "wasi_snapshot_preview1",
        "fd_seek",
        |_: i32, _: i64, _: i32, _: i32| -> i32 { 70 },
    )
    .map_err(err)?;
    // EBADF: there is nothing to read.
    l.func_wrap(
        "wasi_snapshot_preview1",
        "fd_read",
        |_: i32, _: i32, _: i32, _: i32| -> i32 { 8 },
    )
    .map_err(err)?;
    // Whatever libc writes is discarded; the byte count keeps it satisfied.
    l.func_wrap(
        "wasi_snapshot_preview1",
        "fd_write",
        |mut caller: Caller<'_, ()>, _fd: i32, iovs: i32, count: i32, written: i32| -> i32 {
            let Some(memory) = caller.get_export("memory").and_then(Extern::into_memory) else {
                return 8;
            };
            let data = memory.data_mut(&mut caller);
            let read_u32 = |data: &[u8], at: usize| -> u32 {
                data.get(at..at + 4)
                    .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                    .unwrap_or(0)
            };
            let mut total = 0u32;
            for i in 0..count.max(0) as usize {
                total = total.wrapping_add(read_u32(data, iovs as usize + i * 8 + 4));
            }
            if let Some(slot) = data.get_mut(written as usize..written as usize + 4) {
                slot.copy_from_slice(&total.to_le_bytes());
            }
            0
        },
    )
    .map_err(err)?;
    for name in ["environ_sizes_get", "environ_get"] {
        l.func_wrap(
            "wasi_snapshot_preview1",
            name,
            move |mut caller: Caller<'_, ()>, a: i32, b: i32| -> i32 {
                if name == "environ_sizes_get"
                    && let Some(memory) = caller.get_export("memory").and_then(Extern::into_memory)
                {
                    let data = memory.data_mut(&mut caller);
                    for at in [a as usize, b as usize] {
                        if let Some(slot) = data.get_mut(at..at + 4) {
                            slot.copy_from_slice(&0u32.to_le_bytes());
                        }
                    }
                }
                0
            },
        )
        .map_err(err)?;
    }
    Ok(l)
}

/// One running chain: an instance, initialised for one rate and block size.
pub struct Chain {
    store: Store<()>,
    memory: Memory,
    process: TypedFunc<(i32, i32), i32>,
    alloc: TypedFunc<i32, i32>,
    free: TypedFunc<i32, ()>,
    last_error: TypedFunc<(), i32>,
    funcs: Vec<Func>,
    exports: Vec<Export>,
    inputs: [usize; 2],
    output: usize,
    tuner: usize,
    meters: usize,
    meters_len: usize,
    max_frames: usize,
    dead: bool,
}

impl Chain {
    pub fn new(
        engine: &Engine,
        module: &Module,
        sample_rate: f32,
        max_frames: usize,
    ) -> Result<Self, String> {
        let mut store = Store::new(engine, ());
        let instance = linker(engine)?
            .instantiate(&mut store, module)
            .map_err(err)?;
        if let Ok(init) = instance.get_typed_func::<(), ()>(&mut store, "_initialize") {
            init.call(&mut store, ()).map_err(err)?;
        }
        let typed_i = |store: &mut Store<()>, name: &str| {
            instance
                .get_typed_func::<i32, i32>(&mut *store, name)
                .map_err(|e| format!("{name}: {e}"))
        };

        let abi = instance
            .get_typed_func::<(), i32>(&mut store, "tc_abi_version")
            .map_err(|e| format!("tc_abi_version: {e}"))?
            .call(&mut store, ())
            .map_err(err)?;
        if abi != ABI_VERSION {
            return Err(format!(
                "chain.wasm speaks ABI {abi}, this engine speaks {ABI_VERSION}: update Tonecraft Engine"
            ));
        }
        let init = instance
            .get_typed_func::<(f32, i32), i32>(&mut store, "tc_init")
            .map_err(|e| format!("tc_init: {e}"))?;
        if init
            .call(&mut store, (sample_rate, max_frames as i32))
            .map_err(err)?
            == 0
        {
            return Err("tc_init refused".into());
        }

        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or("the chain exports no memory")?;
        let input_ptr = typed_i(&mut store, "tc_input_ptr")?;
        let ptr0 = |store: &mut Store<()>, name: &str| -> Result<usize, String> {
            let f = instance
                .get_typed_func::<(), i32>(&mut *store, name)
                .map_err(|e| format!("{name}: {e}"))?;
            Ok(f.call(&mut *store, ()).map_err(err)? as u32 as usize)
        };
        let inputs = [
            input_ptr.call(&mut store, 0).map_err(err)? as u32 as usize,
            input_ptr.call(&mut store, 1).map_err(err)? as u32 as usize,
        ];
        let output = ptr0(&mut store, "tc_output_ptr")?;
        let tuner = ptr0(&mut store, "tc_tuner_ptr")?;
        let meters = ptr0(&mut store, "tc_meters_ptr")?;
        let meters_len = ptr0(&mut store, "tc_meters_len")?;

        let mut funcs = Vec::new();
        let mut exports = Vec::new();
        for export in module.exports() {
            let ExternType::Func(ty) = export.ty() else {
                continue;
            };
            if !callable(export.name()) {
                continue;
            }
            let kind = |t: ValType| match t {
                ValType::I32 => Some(Kind::I32),
                ValType::F32 => Some(Kind::F32),
                _ => None,
            };
            let params: Option<Vec<Kind>> = ty.params().map(kind).collect();
            let mut results = ty.results();
            let result = match (results.next(), results.next()) {
                (None, _) => None,
                (Some(t), None) => match kind(t) {
                    Some(k) => Some(k),
                    None => continue,
                },
                _ => continue,
            };
            let Some(params) = params else { continue };
            if params.len() > MAX_ARGS {
                continue;
            }
            let Some(func) = instance.get_func(&mut store, export.name()) else {
                continue;
            };
            funcs.push(func);
            exports.push(Export {
                name: export.name().to_string(),
                params,
                result,
            });
        }

        Ok(Self {
            process: instance
                .get_typed_func::<(i32, i32), i32>(&mut store, "tc_process")
                .map_err(|e| format!("tc_process: {e}"))?,
            alloc: typed_i(&mut store, "tc_alloc")?,
            free: instance
                .get_typed_func::<i32, ()>(&mut store, "tc_free")
                .map_err(|e| format!("tc_free: {e}"))?,
            last_error: instance
                .get_typed_func::<(), i32>(&mut store, "tc_last_error")
                .map_err(|e| format!("tc_last_error: {e}"))?,
            store,
            memory,
            funcs,
            exports,
            inputs,
            output,
            tuner,
            meters,
            meters_len,
            max_frames,
            dead: false,
        })
    }

    pub fn exports(&self) -> &[Export] {
        &self.exports
    }

    pub fn export_index(&self, name: &str) -> Option<usize> {
        self.exports.iter().position(|e| e.name == name)
    }

    pub fn max_frames(&self) -> usize {
        self.max_frames
    }

    /// True once the chain has trapped. It stays silent from then on rather
    /// than calling into an instance in an unknown state.
    pub fn dead(&self) -> bool {
        self.dead
    }

    /// Calls export `index`. With a payload, the bytes are copied into the
    /// chain and the call is `fn(pointer, byteLength, ...args)`. Arguments
    /// are converted to the export's own types, as a JavaScript host does.
    /// The caller has checked the count; this only refuses what would trap.
    pub fn call(
        &mut self,
        index: usize,
        args: &[f64],
        mut payload: Option<&mut [u8]>,
    ) -> Result<f64, &'static str> {
        if self.dead {
            return Err("the chain has stopped");
        }
        let export = self.exports.get(index).ok_or("no such export")?;
        let skip = if payload.is_some() { 2 } else { 0 };
        if export.params.len() != args.len() + skip {
            return Err("wrong argument count");
        }
        let mut params = [Val::I32(0); MAX_ARGS];
        for (i, (&a, &kind)) in args.iter().zip(&export.params[skip..]).enumerate() {
            params[skip + i] = match kind {
                Kind::I32 => Val::I32(a as i64 as i32),
                Kind::F32 => Val::F32((a as f32).to_bits()),
            };
        }
        let n = export.params.len();
        let r = usize::from(export.result.is_some());
        let mut ptr = 0;
        let readback = export.name.starts_with("tc_read_");
        if let Some(bytes) = payload.as_deref() {
            if bytes.len() > i32::MAX as usize {
                return Err("payload too large");
            }
            ptr = self
                .alloc
                .call(&mut self.store, bytes.len() as i32)
                .map_err(|_| self.trap())? as u32 as usize;
            if ptr == 0 {
                return Err("the chain is out of memory");
            }
            let data = self.memory.data_mut(&mut self.store);
            data.get_mut(ptr..ptr + bytes.len())
                .ok_or("payload out of bounds")?
                .copy_from_slice(bytes);
            params[0] = Val::I32(ptr as i32);
            params[1] = Val::I32(bytes.len() as i32);
        }
        let mut results = [Val::I32(0)];
        let outcome = self.funcs[index].call(&mut self.store, &params[..n], &mut results[..r]);
        if outcome.is_ok() && readback {
            if let Some(bytes) = payload.as_deref_mut() {
                bytes.copy_from_slice(&self.memory.data(&self.store)[ptr..ptr + bytes.len()]);
            }
        }
        if payload.is_some() {
            let _ = self.free.call(&mut self.store, ptr as i32);
        }
        outcome.map_err(|_| self.trap())?;
        Ok(match results[0] {
            _ if r == 0 => 0.0,
            Val::I32(v) => v as f64,
            Val::F32(bits) => f32::from_bits(bits) as f64,
            _ => 0.0,
        })
    }

    fn trap(&mut self) -> &'static str {
        self.dead = true;
        "the chain trapped"
    }

    /// Runs `frames` samples already written to the inputs. Returns true when
    /// a new meter frame is waiting.
    pub fn process(&mut self, frames: usize, in_channels: usize) -> bool {
        if self.dead {
            return false;
        }
        match self.process.call(
            &mut self.store,
            (frames.min(self.max_frames) as i32, in_channels as i32),
        ) {
            Ok(ready) => ready != 0,
            Err(_) => {
                self.dead = true;
                false
            }
        }
    }

    fn view(&self, at: usize, n: usize) -> &[f32] {
        let bytes = &self.memory.data(&self.store)[at..at + n * 4];
        // SAFETY: the chain's buffers are malloc'd, so 4-byte aligned in a
        // page-aligned memory; wasm is little-endian, as every target here is.
        unsafe { std::slice::from_raw_parts(bytes.as_ptr().cast::<f32>(), n) }
    }

    /// Both input channels, to be filled before `process`.
    pub fn inputs_mut(&mut self) -> (&mut [f32], &mut [f32]) {
        let n = self.max_frames;
        let [a, b] = self.inputs;
        let data = self.memory.data_mut(&mut self.store);
        assert!(
            a + n * 4 <= data.len()
                && b + n * 4 <= data.len()
                && (a + n * 4 <= b || b + n * 4 <= a)
        );
        let base = data.as_mut_ptr();
        // SAFETY: bounds and disjointness asserted above; alignment as in `view`.
        unsafe {
            (
                std::slice::from_raw_parts_mut(base.add(a).cast::<f32>(), n),
                std::slice::from_raw_parts_mut(base.add(b).cast::<f32>(), n),
            )
        }
    }

    pub fn output(&self) -> &[f32] {
        self.view(self.output, self.max_frames)
    }

    pub fn tuner(&self) -> &[f32] {
        self.view(self.tuner, self.max_frames)
    }

    pub fn meters(&self) -> &[f32] {
        self.view(self.meters, self.meters_len)
    }

    /// The chain's last error message, after a failed capture load.
    pub fn last_error(&mut self) -> String {
        let Ok(ptr) = self.last_error.call(&mut self.store, ()) else {
            return String::new();
        };
        let data = self.memory.data(&self.store);
        let start = ptr as u32 as usize;
        let end = data[start..]
            .iter()
            .take(1024)
            .position(|&c| c == 0)
            .map_or(start, |n| start + n);
        String::from_utf8_lossy(&data[start..end]).into_owned()
    }
}
