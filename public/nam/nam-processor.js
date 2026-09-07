/* =============================================================================
   nam-processor.js — runs a Neural Amp Modeler capture on the audio thread
   -----------------------------------------------------------------------------
   Loaded as a single script by AudioWorklet.addModule(). There is no glue file
   and no Emscripten runtime: `wavenet.wasm` is a standalone module built by
   dsp/build.sh, and this file instantiates it directly from the bytes the main
   thread hands over — an AudioWorklet scope has neither fetch nor
   XMLHttpRequest, so nothing here can go and get anything itself.

   The module has no malloc. Its input, output and model buffers are static and
   exported as pointers, memory never grows, and so the one Float32Array view
   taken over `memory.buffer` at init stays valid for the life of the worklet.

   Real-time constraint: nothing is allocated in process().
   ========================================================================== */

/* tonecraft::ModelStatus, from dsp/model/wavenet.h. A blob that does not
   describe a model this kernel can run is refused by name — a shape read
   wrongly does not fall silent, it plays a different amplifier. */
const STATUS = [
  'ok',
  'the blob is shorter than its own header',
  'the blob is not a .tcnm (bad magic)',
  'the blob is a .tcnm of a version this engine does not read',
  'the model is larger than the engine is sized for',
  'the model\'s layer arrays do not fit together',
  'the weight count does not match the declared shape',
  'the model needs more history than the pool holds',
  'the model was trained at a sample rate this chain does not run at',
];

class NamProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.wasm = null;         // the module's exports
    this.heap = null;         // Float32Array over its memory
    this.bytes = null;        // Uint8Array over its memory
    this.inAt = 0;            // index into heap, not a byte offset
    this.outAt = 0;
    this.cap = 0;             // frames the module's block buffers hold
    this.ready = false;
    this.loaded = false;
    this.pendingModel = null; // a model that arrived before init finished
    this.silence = new Float32Array(128);

    this.port.onmessage = (e) => this.onMessage(e.data);

    const bin = options && options.processorOptions && options.processorOptions.wasmBinary;
    if (bin) this.init(bin);
    else this.port.postMessage({ type: 'error', message: 'the WASM binary is missing' });
  }

  async init(wasmBinary) {
    try {
      /* No imports at all: the module is -sSTANDALONE_WASM with no runtime, no
         syscalls and no environment. If that ever stops being true,
         instantiation throws here rather than failing later and quietly. */
      const { instance } = await WebAssembly.instantiate(wasmBinary, {});
      const e = instance.exports;
      if (typeof e.process !== 'function') {
        throw new Error('wavenet.wasm does not export process(); dsp/build.sh has not run');
      }
      this.wasm = e;
      this.heap = new Float32Array(e.memory.buffer);
      this.bytes = new Uint8Array(e.memory.buffer);
      e.init();
      this.inAt = e.in_ptr() >> 2;
      this.outAt = e.out_ptr() >> 2;
      this.cap = e.block_frames();
      this.ready = true;
      this.port.postMessage({ type: 'ready', sampleRate });
      if (this.pendingModel) { const m = this.pendingModel; this.pendingModel = null; this.loadModel(m); }
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
  }

  onMessage(msg) {
    if (!msg) return;
    if (msg.type === 'model') {
      if (!this.ready) { this.pendingModel = msg; return; }
      this.loadModel(msg);
    } else if (msg.type === 'reset') {
      if (this.ready && this.loaded) this.wasm.reset();
    }
  }

  loadModel(msg) {
    const e = this.wasm;
    try {
      const blob = new Uint8Array(msg.blob);
      if (blob.length > e.blob_capacity()) {
        throw new Error(`the model is ${blob.length} bytes and the engine holds ${e.blob_capacity()}`);
      }
      this.bytes.set(blob, e.blob_ptr());
      const status = e.load(blob.length);
      this.loaded = status === 0 && !!e.loaded();

      /* reset() is not a formality. The biases are not zero, so a network fed
         silence still takes its receptive field — 85 ms for a Standard model —
         to reach the output it holds at rest, and skipping this puts that
         transient at the front of the first block as an audible thump. */
      if (this.loaded) e.reset();

      this.port.postMessage({
        type: 'modelLoaded',
        name: msg.name,
        file: msg.file,
        ok: this.loaded,
        message: this.loaded ? undefined : (STATUS[status] || `status ${status}`),
        // Some captures carry their own loudness, most do not. The main thread
        // uses it to line the models up against each other.
        loudness: this.loaded && e.has_loudness() ? e.loudness_db() : null,
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

    /* No bypass. Bypassing a capture is about 18 dB *louder*, not quieter: a
       saturated capture compresses hard and a dry note does not. */
    if (!this.ready || !this.loaded || n > this.cap) {
      out.set(inp.subarray(0, n));       // pass the signal through untouched
      return true;
    }

    const heap = this.heap;
    heap.set(inp.subarray(0, n), this.inAt);
    this.wasm.process(n);
    out.set(heap.subarray(this.outAt, this.outAt + n));
    return true;
  }
}

registerProcessor('nam', NamProcessor);
