/* =============================================================================
   output-worklet.js — the output meter, at the very end of the chain
   -----------------------------------------------------------------------------
   Pass-through. It measures and it posts; it does not touch the signal.

   It exists because DESIGN.md section 5 rules out AnalyserNode everywhere in
   the product: the cord and the two meters are the whole visualisation layer,
   and they are fed by measurements the audio thread already has to make. An
   AnalyserNode would mean a second FFT nobody looks at.

   It also counts dropouts. `currentTime` advances by exactly one quantum per
   call when the graph keeps up; a jump means the audio thread missed a
   deadline, which is the metric that decides whether this product is playable
   (a constant 20 ms of latency is forgotten in a minute, a crackle never is).
   ========================================================================== */

class OutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.peak = 0;
    this.sum = 0;
    this.count = 0;
    this.frame = 0;
    this.dropouts = 0;
    this.lastTime = -1;
    this.quantum = 128 / sampleRate;
  }

  process(inputs, outputs) {
    const out = outputs[0][0];
    const inp = inputs[0] && inputs[0][0];
    const n = out.length;

    if (!inp) { out.fill(0); return true; }
    out.set(inp.subarray(0, n));

    // A gap larger than a quantum and a half is a block the graph did not
    // render in time. Half a quantum of slack absorbs float jitter.
    if (this.lastTime >= 0 && currentTime - this.lastTime > this.quantum * 1.5) {
      this.dropouts++;
    }
    this.lastTime = currentTime;

    for (let i = 0; i < n; i++) {
      const v = inp[i];
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      this.sum += v * v;
    }
    this.count += n;

    if ((this.frame += n) >= sampleRate / 30) {
      this.port.postMessage({
        peak: this.peak,
        rms: Math.sqrt(this.sum / this.count),
        dropouts: this.dropouts
      });
      this.peak = 0; this.sum = 0; this.count = 0; this.frame = 0;
    }
    return true;
  }
}

registerProcessor('output-meter', OutputProcessor);
