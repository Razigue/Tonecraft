/* =============================================================================
   chain-core.js — the chain, as JavaScript sees it
   -----------------------------------------------------------------------------
   One binding to public/dsp/chain.wasm, shared by everything JavaScript that
   runs the chain: the AudioWorklet (chain-processor.js) and every Node script
   that measures, benchmarks or calibrates it. The native engine has its own,
   in Rust (service/src/chain.rs), and it is deliberately as thin as this one:
   hosts move samples and forward calls, they do not know what the chain does.

   The module is standalone, so it asks its host for a few WASI and Emscripten
   imports. None of them is on the audio path: they exist for what libc might
   do on an error path (write a message, exit) and to announce memory growth.

   An ES module with no dependency: a worklet scope imports it as is.
   ========================================================================== */

/** The ABI this binding was written against (schema/chain.ts). */
export const ABI_VERSION = 1;

/** Only these may be called by name from outside: the chain's own exports. */
const CALLABLE = /^tc_[a-z0-9_]+$/;

function importsFor(module, state) {
  const view = () => new DataView(state.memory.buffer);
  const known = {
    'wasi_snapshot_preview1.proc_exit': (code) => { throw new Error(`the chain exited (${code})`); },
    'wasi_snapshot_preview1.fd_write': (fd, iovs, count, written) => {
      // Nothing the chain writes is shown anywhere; the byte count keeps libc happy.
      const v = view();
      let total = 0;
      for (let i = 0; i < count; i++) total += v.getUint32(iovs + i * 8 + 4, true);
      v.setUint32(written, total, true);
      return 0;
    },
    'wasi_snapshot_preview1.fd_close': () => 0,
    'wasi_snapshot_preview1.fd_seek': () => 70,
    'wasi_snapshot_preview1.fd_read': () => 8,
    'wasi_snapshot_preview1.environ_sizes_get': (count, size) => {
      const v = view();
      v.setUint32(count, 0, true);
      v.setUint32(size, 0, true);
      return 0;
    },
    'wasi_snapshot_preview1.environ_get': () => 0,
    'wasi_snapshot_preview1.clock_time_get': (id, precision, out) => {
      view().setBigUint64(out, 0n, true);
      return 0;
    },
    'env.emscripten_notify_memory_growth': () => { state.grown = true; },
  };
  const imports = {};
  for (const { module: mod, name } of WebAssembly.Module.imports(module)) {
    const fn = known[`${mod}.${name}`]
      ?? (() => { throw new Error(`the chain called ${mod}.${name}, which no host provides`); });
    (imports[mod] ??= {})[name] = fn;
  }
  return imports;
}

/** Compiles and instantiates the chain from its bytes. */
export async function instantiateChain(bytes) {
  const module = await WebAssembly.compile(bytes);
  const state = { memory: null, grown: false };
  const instance = await WebAssembly.instantiate(module, importsFor(module, state));
  state.memory = instance.exports.memory;
  return new ChainCore(instance, state);
}

export class ChainCore {
  constructor(instance, state) {
    this.exports = instance.exports;
    this.state = state;
    if (typeof this.exports._initialize === 'function') this.exports._initialize();
    const abi = this.exports.tc_abi_version();
    if (abi !== ABI_VERSION) {
      throw new Error(`chain.wasm speaks ABI ${abi}, this host speaks ${ABI_VERSION}`);
    }
    this.buffer = null;
    this.maxFrames = 0;
    this.inputs = [];
    this.output = null;
    this.tuner = null;
    this.meters = null;
  }

  /** Builds the chain for one rate and a host block of at most maxFrames. */
  init(sampleRate, maxFrames) {
    this.exports.tc_init(sampleRate, maxFrames);
    this.maxFrames = maxFrames;
    this.buffer = null;
    this.refresh();
  }

  /**
   * Views into linear memory. Re-made only when memory has grown — which a
   * capture, an impulse or a take can cause — so the audio path allocates
   * nothing in the steady state.
   */
  refresh() {
    const buffer = this.state.memory.buffer;
    if (buffer === this.buffer) return;
    const e = this.exports;
    const n = this.maxFrames;
    this.buffer = buffer;
    this.inputs = [
      new Float32Array(buffer, e.tc_input_ptr(0), n),
      new Float32Array(buffer, e.tc_input_ptr(1), n),
    ];
    this.output = new Float32Array(buffer, e.tc_output_ptr(), n);
    this.tuner = new Float32Array(buffer, e.tc_tuner_ptr(), n);
    this.meters = new Float32Array(buffer, e.tc_meters_ptr(), e.tc_meters_len());
  }

  /**
   * Runs `frames` samples already written to `inputs`. Returns true when a
   * new meter frame is waiting in `meters`.
   */
  process(frames, inChannels) {
    const ready = this.exports.tc_process(frames, inChannels) !== 0;
    this.refresh();
    return ready;
  }

  /**
   * Calls a chain export by name. With `data`, the bytes are copied into the
   * chain's memory and the call becomes fn(pointer, byteLength, ...args) —
   * the convention every payload-taking export follows.
   */
  call(fn, args = [], data = null) {
    const e = this.exports;
    if (!CALLABLE.test(fn) || typeof e[fn] !== 'function') throw new Error(`no chain export named ${fn}`);
    let result;
    if (data === null || data === undefined) {
      result = e[fn](...args);
    } else {
      const bytes = data instanceof Uint8Array ? data
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      const ptr = e.tc_alloc(bytes.byteLength);
      new Uint8Array(this.state.memory.buffer, ptr, bytes.byteLength).set(bytes);
      try {
        result = e[fn](ptr, bytes.byteLength, ...args);
        // Read exports write into the supplied payload, using the same ABI.
        if (fn.startsWith('tc_read_')) bytes.set(new Uint8Array(this.state.memory.buffer, ptr, bytes.byteLength));
      } finally {
        e.tc_free(ptr);
      }
    }
    this.refresh();
    return typeof result === 'number' ? result : 0;
  }

  /** The chain's last error message, for a failed capture load. */
  lastError() {
    const ptr = this.exports.tc_last_error();
    const bytes = new Uint8Array(this.state.memory.buffer, ptr);
    // Byte by byte: an AudioWorkletGlobalScope has no TextDecoder. The
    // messages are libc's and nlohmann's, which are ASCII.
    let text = '';
    for (let i = 0; i < bytes.length && bytes[i] !== 0 && i < 1024; i++) text += String.fromCharCode(bytes[i]);
    return text;
  }
}
