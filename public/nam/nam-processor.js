/* =============================================================================
   nam-processor.js — runs a Neural Amp Modeler capture on the audio thread
   -----------------------------------------------------------------------------
   Loaded as a *classic* script by AudioWorklet.addModule(), after
   nam-glue.js, which puts `createNamModule` in the worklet's global scope (every
   script added to one AudioContext shares that global).

   The .wasm binary is handed over from the main thread: an AudioWorklet scope
   has neither fetch nor XMLHttpRequest, so Emscripten cannot go and get it
   itself. It receives `wasmBinary` ready-made.

   Real-time constraint: nothing is allocated in process(). The buffers into
   WASM memory are reserved once, at initialisation.
   ========================================================================== */

class NamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.mod = null;          // Emscripten module
    this.id = -1;             // NAM instance handle
    this.ready = false;
    this.loaded = false;
    this.inPtr = 0;
    this.outPtr = 0;
    this.cap = 0;             // buffer capacity, in samples
    this.pendingModel = null; // a model that arrived before init finished
    this.bypass = false;
    this.silence = new Float32Array(128);

    this.port.onmessage = (e) => this.onMessage(e.data);

    const bin = options && options.processorOptions && options.processorOptions.wasmBinary;
    if (bin) this.init(bin);
    else this.port.postMessage({ type: 'error', message: 'the WASM binary is missing' });
  }

  async init(wasmBinary) {
    try {
      /* addModule() evaluates its scripts as ES modules, so nam-glue.js's
         top-level `var`s do not leak into this scope. The factory is picked up
         from globalThis, where the glue publishes it explicitly (see
         scripts/vendor-nam.mjs). */
      const create = globalThis.createNamModule;
      if (typeof create !== 'function')
        throw new Error('createNamModule is missing: nam/nam-glue.js must be ' +
          'added by addModule() before nam/nam-processor.js');

      const mod = await create({ wasmBinary });
      mod._nam_setSampleRate(sampleRate);
      mod._nam_setMaxBufferSize(512);
      this.id = mod._nam_createInstance();
      this.mod = mod;
      this.alloc(512);
      this.ready = true;
      this.port.postMessage({ type: 'ready', sampleRate });
      if (this.pendingModel) { const m = this.pendingModel; this.pendingModel = null; this.loadModel(m); }
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
  }

  alloc(frames) {
    const mod = this.mod;
    if (this.inPtr) { mod._free(this.inPtr); mod._free(this.outPtr); }
    this.inPtr = mod._malloc(frames * 4);
    this.outPtr = mod._malloc(frames * 4);
    this.cap = frames;
  }

  onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'model') {
      if (!this.ready) { this.pendingModel = msg; return; }
      this.loadModel(msg);
    } else if (msg.type === 'bypass') {
      this.bypass = !!msg.value;
    } else if (msg.type === 'reset') {
      if (this.ready && this.loaded) this.mod._nam_reset(this.id);
    }
  }

  loadModel(msg) {
    const mod = this.mod;
    try {
      const json = msg.json;
      const len = mod.lengthBytesUTF8(json) + 1;
      const ptr = mod._malloc(len);
      mod.stringToUTF8(json, ptr, len);
      const ok = mod._nam_loadModel(this.id, ptr);
      mod._free(ptr);
      this.loaded = ok && !!mod._nam_hasModel(this.id);
      if (this.loaded) mod._nam_reset(this.id);
      this.port.postMessage({
        type: 'modelLoaded',
        name: msg.name,
        file: msg.file,
        ok: this.loaded,
        // Some captures carry their own loudness, most do not. The main thread
        // uses it to line the models up against each other.
        loudness: mod._nam_hasModelLoudness(this.id) ? mod._nam_getModelLoudness(this.id) : null
      });
    } catch (err) {
      this.loaded = false;
      this.port.postMessage({ type: 'modelLoaded', name: msg.name, file: msg.file, ok: false, message: String(err) });
    }
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const n = out.length;
    const inp = (inputs[0] && inputs[0][0]) || this.silence;

    if (!this.ready || !this.loaded || this.bypass) {
      out.set(inp.subarray(0, n));       // pass the signal through untouched
      return true;
    }
    if (n > this.cap) this.alloc(n);

    const mod = this.mod;
    const H = mod.HEAPF32;               // can move if WASM memory grows
    H.set(inp.subarray(0, n), this.inPtr >> 2);
    mod._nam_process(this.id, this.inPtr, this.outPtr, n);
    out.set(mod.HEAPF32.subarray(this.outPtr >> 2, (this.outPtr >> 2) + n));
    return true;
  }
}

registerProcessor('nam', NamProcessor);
