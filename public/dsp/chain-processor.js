/* =============================================================================
   chain-processor.js — the one AudioWorkletProcessor (AD-1)
   -----------------------------------------------------------------------------
   The browser host of public/dsp/chain.wasm. It moves the input quantum into
   the chain, the output back out, and forwards calls from engine/engine.ts
   without knowing what they do. The native engine (service/) is the other
   host and does exactly the same with cpal and wasmtime; neither carries a
   line of DSP.

   What stays here is what only this host can see: dropouts. `currentTime`
   advances by exactly one quantum per call when the graph keeps up, and a jump
   is a block the audio thread did not render in time (AD-12).

   Real time: after the first quantum nothing here allocates. Views onto the
   chain's memory are cached and re-made only when that memory grows, which
   only a load between blocks can cause.
   ========================================================================== */

import { instantiateChain } from './chain-core.js';

/* The render quantum is 128 frames everywhere today. The headroom is for a
   `renderSizeHint` future, so that it does not need a rebuild of the chain. */
const MAX_FRAMES = 4096;

class ChainProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.core = null;
    this.pending = [];
    this.dropouts = 0;
    this.lastTime = -1;
    this.quantum = 128 / sampleRate;
    this.frames = 0;
    this.buffer = null;
    this.outView = null;
    this.tunerView = null;

    this.port.onmessage = (event) => this.onMessage(event.data);

    const bytes = options && options.processorOptions && options.processorOptions.wasmBinary;
    if (!bytes) {
      this.port.postMessage({ type: 'error', message: 'the WASM binary is missing' });
      return;
    }
    // The bytes are handed over by the main thread: a worklet scope has no fetch.
    instantiateChain(bytes).then((core) => {
      core.init(sampleRate, MAX_FRAMES);
      this.core = core;
      this.port.postMessage({ type: 'ready', sampleRate });
      for (const message of this.pending.splice(0)) this.run(message);
    }).catch((err) => {
      this.port.postMessage({ type: 'error', message: String((err && err.message) || err) });
    });
  }

  onMessage(message) {
    if (!message || message.type !== 'call') return;
    if (this.core === null) this.pending.push(message);
    else this.run(message);
  }

  /* A call from the main thread, run between two quanta. */
  run(message) {
    let value = 0;
    let error;
    try {
      value = this.core.call(message.fn, message.args, message.data ?? null);
      if (value === 0 && message.fn === 'tc_load_model') error = this.core.lastError();
    } catch (err) {
      error = String((err && err.message) || err);
    }
    if (message.id !== undefined) this.port.postMessage({ type: 'result', id: message.id, value, error });
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const tuner = outputs[1] && outputs[1][0];
    const n = out.length;

    // A gap larger than a quantum and a half is a block the graph did not
    // render in time. Half a quantum of slack absorbs float jitter.
    if (this.lastTime >= 0 && currentTime - this.lastTime > this.quantum * 1.5) this.dropouts++;
    this.lastTime = currentTime;

    const core = this.core;
    if (core === null || n > MAX_FRAMES) {
      out.fill(0);
      if (tuner) tuner.fill(0);
      return true;
    }

    /* Chrome hands over an empty input array whenever everything upstream is
       silent. That is silence, not an absence of news: the chain still runs,
       so its gate, filters and meters keep settling. */
    const chans = inputs[0];
    const count = chans ? Math.min(chans.length, 2) : 0;
    for (let c = 0; c < count; c++) core.inputs[c].set(chans[c]);

    const ready = core.process(n, count);
    if (core.buffer !== this.buffer || n !== this.frames) {
      this.buffer = core.buffer;
      this.frames = n;
      this.outView = core.output.subarray(0, n);
      this.tunerView = core.tuner.subarray(0, n);
    }
    out.set(this.outView);
    if (tuner) tuner.set(this.tunerView);

    if (ready) {
      this.port.postMessage({ type: 'meters', meters: core.meters.slice(), dropouts: this.dropouts });
    }
    return true;
  }
}

registerProcessor('chain', ChainProcessor);
