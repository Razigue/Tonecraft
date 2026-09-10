/* =============================================================================
   frontend-worklet.js — the input stage, ahead of the NAM model
   -----------------------------------------------------------------------------
   A NAM capture is a frozen snapshot: it has no controls. What can be set is
   what we send into it. This worklet holds the two blocks that matter before
   the amp:

     - a noise gate, which high gain cannot do without (these captures amplify
       enormously: 0.02 in already comes back out at -19 dBFS);
     - a Tube Screamer style boost, which cuts the low end before the
       saturation. That is the classic metal recipe: it tightens the attack and
       stops the bottom of the spectrum from boiling.

   It also owns the capture channel: a two-input interface puts its instrument
   jack on the second channel, so the choice of which channel feeds the chain is
   made here, at the worklet boundary, rather than by a splitter and a pile of
   gain nodes on the main thread. It is hardware description, never tone state.

   The boost is the only hand-written non-linearity in the whole chain (all the
   rest of the sound comes from the NAM model). It runs at 4x oversampling with
   antiderivative anti-aliasing (ADAA).

   Measured (scripts/measure-aliasing.mjs, worst case over three test notes,
   in-band aliasing relative to the fundamental):
       naive processing ............ -24 dBc
       4x oversampling alone ....... -68 dBc
       4x + ADAA (what ships) ...... -94 dBc
   ========================================================================== */

/* --------------------------- half-band filters ---------------------------
   Each 2x stage is an elliptic half-band split into two all-pass branches
   (Valenzuela & Constantinides): H(z) = (A0(z^2) + z^-1 A1(z^2)) / 2, where
   A0 and A1 are cascades of first-order all-pass sections running at the low
   rate. Two things follow from that structure:

     - the group delay is a few samples at the high rate, not half the filter
       length. The linear-phase FIR this replaces put 36 samples — 0.76 ms at
       48 kHz — between the pick and the amp whenever the boost was on. These
       put under five. Latency is the one thing this product cannot buy back
       anywhere else, so none of it is spent on a phase linearity that nobody
       can hear;
     - each section is one multiply and two adds, and the half-band property
       is exact: a 7-section stage costs 7 multiplies per input sample in each
       direction, against 16 for the 63-tap FIR it replaces.

   The phase is not linear inside the transition band, which starts at
   20 kHz. Nothing there is audible.

   Designed by scripts/design-halfband.ts: each set is the shortest whose
   stopband sits at or below -100 dB with the passband reaching 20 kHz.
       48k  -> 96k    7 sections   -112 dB   group delay 3.7 samples at 96k
       96k  -> 192k   3 sections   -102 dB   group delay 2.2 samples at 192k
       192k -> 384k   2 sections   -102 dB   group delay 1.6 samples at 384k
   The transition band is relative to the rate, so at 44.1 kHz the passband
   ends at 18.4 kHz — exactly as it did with the FIR. */
const HALFBAND_STAGES = [
  [0.033397507751963, 0.126292938978164, 0.260582948456779, 0.415885885622256,
   0.577350269189626, 0.739707378355978, 0.908403153754175],
  [0.063787836824299, 0.266780962497159, 0.668548793183609],
  [0.110301209912266, 0.536772123666460],
];

/* A cascade of first-order all-pass sections, (a + z^-1) / (1 + a z^-1). */
class AllpassChain {
  constructor(coefs) {
    this.a = Float64Array.from(coefs);
    this.x1 = new Float64Array(coefs.length);
    this.y1 = new Float64Array(coefs.length);
  }
  tick(v) {
    const a = this.a, x1 = this.x1, y1 = this.y1;
    for (let k = 0; k < a.length; k++) {
      const y = a[k] * (v - y1[k]) + x1[k];
      x1[k] = v; y1[k] = y; v = y;
    }
    return v;
  }
}

/* Even-indexed coefficients form the branch that lands on the even output
   samples; odd-indexed ones form the branch behind the one-sample delay. The
   other pairing is not a filter at all: 12 dB of passband ripple. */
const split = (coefs) => [
  coefs.filter((_, i) => i % 2 === 0),
  coefs.filter((_, i) => i % 2 === 1),
];

/* Polyphase 2x interpolator: both branches run at the low rate on the same
   input, and their outputs interleave. */
class Up2 {
  constructor(coefs) {
    const [even, odd] = split(coefs);
    this.a0 = new AllpassChain(even);
    this.a1 = new AllpassChain(odd);
  }
  process(x, n, out) {              // x: n samples -> out: 2n
    const a0 = this.a0, a1 = this.a1;
    for (let i = 0; i < n; i++) {
      const v = x[i];
      out[2 * i] = a0.tick(v);
      out[2 * i + 1] = a1.tick(v);
    }
  }
}

/* Polyphase 2x decimator: the even-phase samples through one branch, the
   odd-phase samples — one high-rate sample earlier — through the other. */
class Down2 {
  constructor(coefs) {
    const [even, odd] = split(coefs);
    this.a0 = new AllpassChain(even);
    this.a1 = new AllpassChain(odd);
    this.prev = 0;
  }
  process(x, n, out) {              // x: 2n samples -> out: n
    const a0 = this.a0, a1 = this.a1;
    let prev = this.prev;
    for (let i = 0; i < n; i++) {
      out[i] = 0.5 * (a0.tick(x[2 * i]) + a1.tick(prev));
      prev = x[2 * i + 1];
    }
    this.prev = prev;
  }
}

/* The oversampling chain. The first stage (lowest rate) is the steep one; the
   ones above it can be short, because their transition band is enormous at the
   higher rates. Its buffers are sized for the 128-frame quantum up front, so
   process() never allocates. */
class OverSampler {
  constructor(stages) {
    this.up = stages.map((c) => new Up2(c));
    this.dn = stages.map((c) => new Down2(c));
    this.factor = 1 << stages.length;
    this.tmp = [];
    for (let k = 0, len = 256; k < stages.length; k++, len *= 2) this.buf(k, len);
    for (let k = 1, len = 128 << k; k < stages.length; k++, len = 128 << k) this.buf(20 + k, len);
  }
  buf(i, len) {
    if (!this.tmp[i] || this.tmp[i].length !== len) this.tmp[i] = new Float64Array(len);
    return this.tmp[i];
  }
  upsample(x, n) {
    let cur = x, cn = n;
    for (let k = 0; k < this.up.length; k++) {
      const o = this.buf(k, cn * 2);
      this.up[k].process(cur, cn, o);
      cur = o; cn *= 2;
    }
    return { buf: cur, n: cn };
  }
  downsample(x, n, out) {
    if (this.dn.length === 0) { for (let i = 0; i < n; i++) out[i] = x[i]; return; }
    let cur = x, cn = n;
    for (let k = this.dn.length - 1; k >= 0; k--) {
      const half = cn >> 1;
      const dst = (k === 0) ? out : this.buf(20 + k, half);
      this.dn[k].process(cur, half, dst);
      cur = dst; cn = half;
    }
  }
}

/* The first log2(f) stages, so the measurement script can run the same code
   at 1x, 2x, 4x and 8x. What ships is 4x. */
function osStages(f) {
  const n = f >= 8 ? 3 : f >= 4 ? 2 : f >= 2 ? 1 : 0;
  return HALFBAND_STAGES.slice(0, n);
}

/* tanh: Pade 7/6 approximation, error < 1e-6 over [-4, 4]. */
function tnh(x) {
  if (x > 4) return 1;
  if (x < -4) return -1;
  const x2 = x * x;
  return x * (135135 + x2 * (17325 + x2 * (378 + x2))) /
    (135135 + x2 * (62370 + x2 * (3150 + x2 * 28)));
}

/* ln(cosh(x)): the antiderivative of tanh, written so it can never overflow. */
function lncosh(x) {
  const a = x < 0 ? -x : x;
  return a + Math.log1p(Math.exp(-2 * a)) - 0.6931471805599453;
}

/* ----------------- antiderivative anti-aliasing (ADAA) -------------------
   Instead of evaluating tanh pointwise, integrate the function across the
   interval between two samples:

       y[n] = ( F(x[n]) - F(x[n-1]) ) / ( x[n] - x[n-1] ),   F' = tanh

   which is the same as filtering the non-linearity with a rectangular kernel:
   the highest harmonics, the ones that would fold back, are attenuated at the
   source. Typical gain: 20 to 30 dB, the equivalent of an oversampling factor
   four times higher, for far less cost.
   When two consecutive samples are too close the divided difference goes
   numerically unstable, so we fall back to evaluating directly at the midpoint,
   which is its exact limit.                                                 */
class ADAATanh {
  constructor() { this.pu = 0; this.pf = lncosh(0); }
  process(u) {
    const F = lncosh(u);
    const du = u - this.pu;
    const y = (du > 1e-6 || du < -1e-6)
      ? (F - this.pf) / du
      : tnh(0.5 * (u + this.pu));
    this.pu = u; this.pf = F;
    return y;
  }
}

const onePoleHP = (fc, sr) => 1 / (1 + 2 * Math.PI * fc / sr);
const onePoleLP = (fc, sr) => 1 - Math.exp(-2 * Math.PI * fc / sr);


/* ============================== INPUT STAGE ============================== */

class FrontendProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'inputGain', defaultValue: 1.0, minValue: 0, maxValue: 32, automationRate: 'k-rate' },
      { name: 'gate', defaultValue: -70, minValue: -100, maxValue: -10, automationRate: 'k-rate' },
      { name: 'boost', defaultValue: 0.0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'boostTone', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor() {
    super();
    // noise gate
    this.env = 0; this.gg = 0; this.open = false;
    this.attC = 1 - Math.exp(-1 / (sampleRate * 0.0012));   // open: 1.2 ms
    /* Close: 12 ms, down from 50.
       The gain applied is gg squared, so the time constant is not the time you
       hear. Silence is reached at roughly 3.45 tau: 50 ms put the gate fully
       shut 172 ms after the phrase ended, which is long enough to hear the
       hiss arrive before it left. 12 ms puts it at 41 ms, inside the gap
       instead of after it.
       The floor under this is chatter, and what holds it off is the 6 dB of
       hysteresis below — a note decaying through the threshold cannot reopen
       the gate it just closed. Faster than about 8 ms and the tails of held
       notes start being clipped rather than released. */
    this.relC = 1 - Math.exp(-1 / (sampleRate * 0.012));
    this.envC = 1 - Math.exp(-1 / (sampleRate * 0.0025));   // detector: 2.5 ms
    // DC blocker
    this.dx = 0; this.dy = 0; this.dA = onePoleHP(18, sampleRate);
    // control smoothing (sGain at the base rate, sBoost/sTone in the
    // oversampled domain: see process)
    this.sGain = 1; this.sBoost = 0;

    // boost: 4x oversampling + ADAA
    this.os = new OverSampler(osStages(4));
    const sr = sampleRate * this.os.factor;
    this.bA = onePoleHP(720, sr);           // the heart of the "TS" sound: cuts below 720 Hz
    this.bx = 0; this.by = 0;
    this.tLP = onePoleLP(5200, sr); this.tl = 0;   // the pedal's tone control
    this.nl = new ADAATanh();
    this.sTone = 0.5;
    // ~12 ms: slow enough to be inaudible, fast enough to follow the hand
    this.smoothC = 1 - Math.exp(-1 / (sr * 0.012));
    this.pre = new Float64Array(128);
    this.outBuf = new Float64Array(128);

    /* Which captured channel feeds the chain. -1 sums, -2 follows whichever
       channel actually carries signal. Set by the main thread; it describes the
       player's hardware, never their tone, so it is not a parameter. */
    this.channel = -2;
    this.mono = new Float32Array(128);
    // Auto-follow state. A clear margin is required before switching, so a
    // little bleed on the unused channel cannot flip it.
    this.autoAcc = [0, 0]; this.autoN = 0; this.autoPick = 0;
    this.chPeak = [0, 0];

    // level metering for the interface
    this.peakIn = 0; this.peakOut = 0; this.frame = 0;

    /* Brightness: the share of the arriving energy that lives above 2 kHz.
       On its own it says little; together with a weak peak on an onboard
       device it is the signature of a guitar plugged into a microphone input,
       which loads the pickup and takes the highs with it. The player cannot
       tell that from a bad amp model, and will blame the amp model. */
    this.brA = onePoleHP(2000, sampleRate);
    this.bhx = 0; this.bhy = 0;
    this.eAll = 0; this.eHigh = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === 'input-channel') {
        this.channel = m.channel;
        this.autoAcc[0] = 0; this.autoAcc[1] = 0; this.autoN = 0;
      }
    };

    this.#warmUp();
  }

  /**
   * Runs the whole path on silence a few times before the first real block.
   *
   * The engine's first block runs in the JavaScript interpreter, at ten times
   * the cost of the optimised code the rest of the session gets (measured:
   * 1.2 ms against 0.1 ms on a fast machine). On a slow one that first block
   * alone overruns the 2.67 ms quantum, and the session opens with a crackle
   * for no reason but the tier-up. Here the tiering happens before anything
   * is connected, while there is nothing to hear.
   *
   * Silence leaves every filter at zero; only the control smoothers move, and
   * they are put back.
   */
  #warmUp() {
    const inputs = [[new Float32Array(128), new Float32Array(128)]];
    const outputs = [[new Float32Array(128)]];
    const params = { inputGain: [2], gate: [-65], boost: [1], boostTone: [1] };
    for (let i = 0; i < 64; i++) {
      this.process(inputs, outputs, params);
      this.frame = 0;                       // never post from here
    }
    this.sGain = 1; this.sBoost = 0; this.sTone = 0.5;
    this.gg = 0; this.open = false; this.env = 0;
    this.peakIn = 0; this.peakOut = 0; this.eAll = 0; this.eHigh = 0;
    this.chPeak[0] = 0; this.chPeak[1] = 0;
    this.autoAcc[0] = 0; this.autoAcc[1] = 0; this.autoN = 0;
  }

  /**
   * Collapses the capture to the one mono signal the chain runs on, and
   * measures each channel on the way past. Peaks per channel are what makes
   * "which input is my guitar on" something you can see rather than guess.
   */
  #pick(chans, n) {
    const a = chans[0];
    const b = chans.length > 1 ? chans[1] : null;
    const out = this.mono;

    let pA = 0, pB = 0;
    for (let i = 0; i < n; i++) {
      const va = a[i] < 0 ? -a[i] : a[i];
      if (va > pA) pA = va;
    }
    if (b) {
      for (let i = 0; i < n; i++) {
        const vb = b[i] < 0 ? -b[i] : b[i];
        if (vb > pB) pB = vb;
      }
    }
    if (pA > this.chPeak[0]) this.chPeak[0] = pA;
    if (pB > this.chPeak[1]) this.chPeak[1] = pB;

    if (b === null) { out.set(a.subarray(0, n)); return; }

    let pick = this.channel;
    if (pick === -2) {
      // Many interfaces present a stereo input with only one side wired.
      this.autoAcc[0] += pA; this.autoAcc[1] += pB;
      if (++this.autoN >= 30) {
        this.autoPick = this.autoAcc[1] > this.autoAcc[0] * 3 ? 1 : 0;
        this.autoAcc[0] = 0; this.autoAcc[1] = 0; this.autoN = 0;
      }
      pick = this.autoPick;
    }

    if (pick === 0) out.set(a.subarray(0, n));
    else if (pick === 1) out.set(b.subarray(0, n));
    else for (let i = 0; i < n; i++) out[i] = 0.5 * (a[i] + b[i]);
  }

  process(inputs, outputs, params) {
    const out = outputs[0][0];
    const n = out.length;
    const chans = inputs[0];
    /* Silence, not an absence of news: Chrome hands over an empty input array
       whenever everything upstream is silent, and returning early here would
       leave the meters frozen at their last reading rather than falling to
       zero. The stage still runs — its gate and its filters have state that has
       to keep settling — it just runs on zeros. */
    if (!chans || !chans[0]) this.mono.fill(0);
    else this.#pick(chans, n);
    const inp = this.mono;

    /* Output 1 is a clean tuner tap: already mono and already following the
       selected interface channel, but untouched by gain, gate or boost. It is
       connected only to a zero-gain sink on the main graph. */
    const tuner = outputs[1] && outputs[1][0];
    if (tuner) tuner.set(inp.subarray(0, n));

    const gTarget = params.inputGain[0];
    const gateDb = params.gate[0];
    const boost = params.boost[0];
    const tone = params.boostTone[0];
    const thr = gateDb <= -99 ? 0 : Math.pow(10, gateDb / 20);
    const pre = this.pre;

    /* --- input gain, DC blocking, noise gate --- */
    let pkIn = 0;
    for (let i = 0; i < n; i++) {
      const raw = inp[i];
      // measured on what arrives, before our own gain touches it
      const bh = this.brA * (this.bhy + raw - this.bhx);
      this.bhx = raw; this.bhy = bh;
      this.eAll += raw * raw; this.eHigh += bh * bh;

      this.sGain += 0.02 * (gTarget - this.sGain);
      let x = raw * this.sGain;

      const a0 = x < 0 ? -x : x;
      if (a0 > pkIn) pkIn = a0;

      const dy = this.dA * (this.dy + x - this.dx);
      this.dx = x; this.dy = dy;
      /* Plus a constant 360 dB below full scale. Once the gate has closed the
         chain runs on exact zeros, every filter state decays into denormal
         range and stays there, and on the older Intel cores this product has
         to run on, arithmetic on a denormal is a microcode assist of about a
         hundred cycles — per state, per sample, across the oversampler's ten
         all-pass sections at 192 kHz. That is CPU spent on silence, and the
         bill comes due on the first note after it. A DC far below anything
         audible keeps every state a normal number. */
      x = dy + 1e-18;

      // gate: fast attack, 6 dB of hysteresis so it cannot chatter
      const a = x < 0 ? -x : x;
      this.env += (a > this.env ? 0.55 : this.envC) * (a - this.env);
      if (thr > 0) {
        this.open = this.env > (this.open ? thr * 0.5 : thr);
        const tgt = this.open ? 1 : 0;
        this.gg += (tgt > this.gg ? this.attC : this.relC) * (tgt - this.gg);
        if (this.gg < 1e-20) this.gg = 0;   // a closed gate is closed, not denormal
        x *= this.gg * this.gg;             // squared: a gentler close
        if (this.gg === 0) x = 1e-18;       // the guard survives the gate
      }
      pre[i] = x;
    }

    /* --- boost, oversampled ---
       Controls arrive k-rate, one value per 128-sample block. Smoothing them at
       the block rate would produce a 375 Hz staircase (48000/128) that modulates
       the non-linearity and creates sidebands at +/- 375 Hz around every
       partial — measured at -78 dBc, well above the aliasing the rest of the
       chain works to avoid. So the smoothing runs per sample, in the
       oversampled domain. */
    if (boost > 0.001 || this.sBoost > 0.001) {
      const up = this.os.upsample(pre, n);
      const buf = up.buf, on = up.n;
      const cB = this.smoothC;

      for (let i = 0; i < on; i++) {
        this.sBoost += cB * (boost - this.sBoost);
        this.sTone += cB * (tone - this.sTone);
        const b = this.sBoost;

        const x = buf[i];
        const h = this.bA * (this.by + x - this.bx);   // 720 Hz highpass
        this.bx = x; this.by = h;
        const low = x - h;
        const sat = this.nl.process(h * (1 + 24 * b));
        const y = low * (1 - 0.55 * b) + sat * (0.55 + 0.45 * b);
        const toneC = this.tLP * (0.35 + 1.3 * this.sTone);   // tone control
        this.tl += (toneC < 1 ? toneC : 1) * (y - this.tl);
        buf[i] = this.tl * (1 + 1.1 * b);
      }
      this.os.downsample(buf, on, this.outBuf);
      const ob = this.outBuf;
      for (let i = 0; i < n; i++) out[i] = ob[i];
    } else {
      for (let i = 0; i < n; i++) out[i] = pre[i];
    }

    /* --- levels back to the interface, ~30 times a second --- */
    let pkOut = 0;
    for (let i = 0; i < n; i++) { const a = out[i] < 0 ? -out[i] : out[i]; if (a > pkOut) pkOut = a; }
    if (pkIn > this.peakIn) this.peakIn = pkIn;
    if (pkOut > this.peakOut) this.peakOut = pkOut;
    if ((this.frame += n) >= sampleRate / 30) {
      this.port.postMessage({
        in: this.peakIn,
        out: this.peakOut,
        gate: this.gg,
        brightness: this.eAll > 1e-12 ? Math.sqrt(this.eHigh / this.eAll) : 0,
        channels: chans && chans.length ? chans.length : 1,
        channelPeaks: [this.chPeak[0], this.chPeak[1]],
        following: this.channel === -2 ? this.autoPick : -1
      });
      this.peakIn = 0; this.peakOut = 0;
      this.chPeak[0] = 0; this.chPeak[1] = 0;
      this.eAll = 0; this.eHigh = 0;
      this.frame = 0;
    }
    return true;
  }
}

registerProcessor('frontend', FrontendProcessor);
