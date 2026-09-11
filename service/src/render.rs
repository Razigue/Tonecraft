//! `tonecraft-engine render`: runs a signal through the chain offline, through
//! exactly the code the live engine uses (`chain::Chain`), for the cross-host
//! parity test — the same `chain.wasm` under V8 and under wasmtime must agree.
//!
//! Also prints how long each block took, which is the number the CPU budget
//! is about.

use std::path::PathBuf;
use std::time::Instant;

use serde::Deserialize;

use crate::b64;
use crate::chain::{Chain, Compiler};

#[derive(Deserialize)]
struct CallSpec {
    #[serde(rename = "fn")]
    name: String,
    #[serde(default)]
    args: Vec<f64>,
    #[serde(default)]
    data: Option<String>,
}

pub fn main(args: &[String]) -> Result<(), String> {
    let mut wasm = None;
    let mut rate = 48_000.0f32;
    let mut block = 128usize;
    let mut channels = 1usize;
    let mut input = None;
    let mut calls = None;
    let mut output = None;
    let mut i = 0;
    while i < args.len() {
        let value = args
            .get(i + 1)
            .ok_or_else(|| format!("{} needs a value", args[i]))?;
        match args[i].as_str() {
            "--wasm" => wasm = Some(PathBuf::from(value)),
            "--rate" => rate = value.parse().map_err(|_| "--rate needs a number")?,
            "--block" => block = value.parse().map_err(|_| "--block needs a number")?,
            "--channels" => channels = value.parse().map_err(|_| "--channels needs a number")?,
            "--input" => input = Some(PathBuf::from(value)),
            "--calls" => calls = Some(PathBuf::from(value)),
            "--output" => output = Some(PathBuf::from(value)),
            other => return Err(format!("unknown argument {other}")),
        }
        i += 2;
    }
    let read = |p: &Option<PathBuf>, what: &str| -> Result<Vec<u8>, String> {
        let p = p.as_ref().ok_or_else(|| format!("--{what} is required"))?;
        std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))
    };
    if !(1..=2).contains(&channels) || block == 0 {
        return Err("--channels must be 1 or 2, --block above 0".into());
    }

    let bytes = read(&wasm, "wasm")?;
    let mut compiler = Compiler::new()?;
    let t0 = Instant::now();
    let module = compiler.compile(&bytes)?;
    let compile_ms = t0.elapsed().as_secs_f64() * 1e3;
    let mut chain = Chain::new(compiler.engine(), &module, rate, block)?;

    let specs: Vec<CallSpec> = match &calls {
        Some(_) => serde_json::from_slice(&read(&calls, "calls")?).map_err(|e| e.to_string())?,
        None => Vec::new(),
    };
    for spec in &specs {
        let index = chain
            .export_index(&spec.name)
            .ok_or_else(|| format!("no chain export named {}", spec.name))?;
        let payload = spec.data.as_deref().map(b64::decode).transpose()?;
        let value = chain
            .call(index, &spec.args, payload.as_deref())
            .map_err(|e| format!("{}: {e}", spec.name))?;
        if spec.name == "tc_load_model" && value == 0.0 {
            return Err(format!("tc_load_model: {}", chain.last_error()));
        }
    }

    let raw = read(&input, "input")?;
    let samples: Vec<f32> = raw
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let frames = samples.len() / channels;
    let mut out = Vec::with_capacity(frames * 4);
    let mut times = Vec::with_capacity(frames / block + 1);
    let mut at = 0;
    while at < frames {
        let n = block.min(frames - at);
        {
            let (a, b) = chain.inputs_mut();
            a[..n].copy_from_slice(&samples[at..at + n]);
            if channels == 2 {
                b[..n].copy_from_slice(&samples[frames + at..frames + at + n]);
            }
        }
        let t = Instant::now();
        chain.process(n, channels);
        times.push(t.elapsed().as_secs_f64() * 1e6);
        for v in &chain.output()[..n] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        at += n;
    }
    if chain.dead() {
        return Err("the chain trapped".into());
    }
    let path = output.as_ref().ok_or("--output is required")?;
    std::fs::write(path, out).map_err(|e| format!("{}: {e}", path.display()))?;

    // The first blocks carry one-off costs (page faults, first calls); the
    // steady state is what decides dropouts.
    let steady: &mut [f64] = if times.len() > 100 {
        &mut times[100..]
    } else {
        &mut times[..]
    };
    steady.sort_by(|a, b| a.total_cmp(b));
    if !steady.is_empty() {
        let median = steady[steady.len() / 2];
        let p99 = steady[(steady.len() * 99 / 100).min(steady.len() - 1)];
        let budget = block as f64 / rate as f64 * 1e6;
        eprintln!(
            "compile {compile_ms:.0} ms; per {block}-frame block: median {median:.1} us, p99 {p99:.1} us \
             ({:.1}% of one core at the median)",
            100.0 * median / budget
        );
    }
    Ok(())
}
