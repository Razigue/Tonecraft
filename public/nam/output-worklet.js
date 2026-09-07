/* =============================================================================
   output-worklet.js — the output stage: the safety limiter, then the meter
   -----------------------------------------------------------------------------
   The limiter is here, and not in a WaveShaperNode, for one measured reason.
   A WaveShaperNode with `oversample: '4x'` delays the signal by 192 frames in
   Chromium — 4.0 ms at 48 kHz, more than a whole render quantum — because its
   resamplers are linear-phase FIRs (scripts/measure-latency.mjs measures it
   with an impulse). That was the largest single latency in the product's own
   code, spent on a stage that is transparent nearly all the time. Here the
   limiter runs sample by sample, at zero latency.

   The aliasing that the oversampling was there for is handled another way:
   the curve is the identity below the knee, so only the *residual* above it
   is non-linear, and that residual goes through first-order antiderivative
   anti-aliasing (the same idea as the boost in frontend-worklet.js). Below
   the knee the stage is exactly transparent — not "transparent to within a
   half-sample average", which is what ADAA on the whole signal would give,
   and which is a 2 dB loss at 10 kHz.

   The curve is the one the WaveShaper carried: identity to 0.7 (-3 dBFS),
   then a tanh knee that reaches 1.0 asymptotically. It is always on and has
   no control anywhere in the product (FR-18): a digital feedback loop in
   headphones can injure.

   It also measures — peak and RMS, posted 30 times a second — and counts
   dropouts: `currentTime` advances by exactly one quantum per call when the
   graph keeps up, and a jump is a block the audio thread did not render in
   time. That is the metric that decides whether this is playable: a constant
   20 ms of latency is forgotten in a minute, a crackle never is.
   ========================================================================== */

/** The knee, in linear amplitude. -3 dBFS. */
const KNEE = 0.7;
const SPAN = 1 - KNEE;

/* ln(cosh(x)), the antiderivative of tanh, written so it can never overflow. */
function lncosh(x) {
  const a = x < 0 ? -x : x;
  return a + Math.log1p(Math.exp(-2 * a)) - 0.6931471805599453;
}

/* What the limiter adds to the identity: zero below the knee, and above it
   the difference between the tanh knee and the straight line. */
function residual(x) {
  const a = x < 0 ? -x : x;
  if (a <= KNEE) return 0;
  const y = KNEE + SPAN * Math.tanh((a - KNEE) / SPAN);
  return x < 0 ? -(y - a) : (y - a);
}

/* Its antiderivative, even, zero below the knee. */
function residualIntegral(x) {
  const a = x < 0 ? -x : x;
  if (a <= KNEE) return 0;
  const over = a - KNEE;
  return KNEE * over + SPAN * SPAN * lncosh(over / SPAN) - 0.5 * (a * a - KNEE * KNEE);
}

class OutputProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // ADAA state: the previous input and its integral.
    this.px = 0;
    this.pF = 0;

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

    /* An input array with nothing in it is silence, not an absence of news.
       Chrome hands one over whenever everything upstream is silent, and
       returning early here left the meter frozen at its last reading — so with
       the chain switched off the output appeared to sit at -59 dBFS forever,
       unaffected by the master fader, because it was not a signal at all. */
    if (inp) out.set(inp.subarray(0, n));
    else out.fill(0);

    // A gap larger than a quantum and a half is a block the graph did not
    // render in time. Half a quantum of slack absorbs float jitter.
    if (this.lastTime >= 0 && currentTime - this.lastTime > this.quantum * 1.5) {
      this.dropouts++;
    }
    this.lastTime = currentTime;

    /* The limiter. y = x + (G(x) - G(x_prev)) / (x - x_prev), G the integral
       of the residual: the residual averaged over the interval between two
       samples, which attenuates the harmonics that would fold back. When two
       samples are too close the divided difference is unstable, and the
       midpoint value is its exact limit. */
    let px = this.px, pF = this.pF;
    for (let i = 0; i < n; i++) {
      const x = out[i];
      const F = residualIntegral(x);
      const dx = x - px;
      const r = (dx > 1e-6 || dx < -1e-6) ? (F - pF) / dx : residual(0.5 * (x + px));
      px = x; pF = F;
      /* The averaged residual can sit a little above the pointwise curve on a
         fast-moving peak, so on its own the knee's asymptote is not a ceiling.
         Safety needs a ceiling: this clip only ever engages beyond the knee,
         where the signal is already being limited. */
      const y = x + r;
      out[i] = y > 1 ? 1 : y < -1 ? -1 : y;
    }
    this.px = px; this.pF = pF;

    for (let i = 0; i < n; i++) {
      const v = out[i];
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
