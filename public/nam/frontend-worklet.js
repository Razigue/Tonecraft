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

/* ------------------------------- utilities ------------------------------- */

function besselI0(x) {
  let s = 1, t = 1;
  for (let i = 1; i < 50; i++) {
    const u = x / (2 * i); t *= u * u; s += t;
    if (t < 1e-18 * s) break;
  }
  return s;
}

/* Half-band filter: a sinc windowed by a Kaiser.
   L must be 3 (mod 4) so the centre tap lands on an odd index. */
function halfbandTaps(L, beta) {
  const c = (L - 1) / 2, h = new Float64Array(L), d = besselI0(beta);
  for (let n = 0; n < L; n++) {
    const m = n - c;
    const s = (m === 0) ? 0.5 : Math.sin(Math.PI * m / 2) / (Math.PI * m);
    const r = m / c;
    h[n] = s * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / d;
  }
  let g = 0; for (let n = 0; n < L; n++) g += h[n];
  for (let n = 0; n < L; n++) h[n] /= g;      // unity DC gain
  return h;
}

/* Polyphase 2x interpolator. Half-band property: the odd branch collapses to a
   plain delay, so there are very few multiplies. */
class Up2 {
  constructor(L, beta) {
    const h = halfbandTaps(L, beta), c = (L - 1) / 2;
    this.t = new Float64Array((L + 1) >> 1);
    for (let j = 0, m = 0; j < L; j += 2, m++) this.t[m] = 2 * h[j];
    this.M = this.t.length;
    this.mid = (c - 1) / 2;
    this.th = 2 * h[c];
    this.hist = new Float64Array(this.M - 1);
    this.a = null;
  }
  process(x, n, out) {
    const M = this.M, t = this.t, need = M - 1 + n;
    if (!this.a || this.a.length < need) this.a = new Float64Array(need);
    const a = this.a;
    a.set(this.hist, 0);
    for (let i = 0; i < n; i++) a[M - 1 + i] = x[i];
    const base = M - 1, mid = this.mid, th = this.th;
    for (let i = 0; i < n; i++) {
      const p = base + i;
      let s = 0;
      for (let m = 0; m < M; m++) s += t[m] * a[p - m];
      out[2 * i] = s;
      out[2 * i + 1] = th * a[p - mid];
    }
    this.hist.set(a.subarray(n, n + M - 1));
  }
}

/* Polyphase 2x decimator (the mirror structure). */
class Down2 {
  constructor(L, beta) {
    const h = halfbandTaps(L, beta), c = (L - 1) / 2;
    this.t = new Float64Array((L + 1) >> 1);
    for (let j = 0, m = 0; j < L; j += 2, m++) this.t[m] = h[j];
    this.M = this.t.length;
    this.c = c;
    this.hc = h[c];
    this.H = 2 * (this.M - 1);
    this.hist = new Float64Array(this.H);
    this.a = null;
  }
  process(x, n, out) {              // x: 2n samples -> out: n
    const M = this.M, t = this.t, H = this.H, c = this.c, hc = this.hc;
    const need = H + 2 * n;
    if (!this.a || this.a.length < need) this.a = new Float64Array(need);
    const a = this.a;
    a.set(this.hist, 0);
    for (let i = 0; i < 2 * n; i++) a[H + i] = x[i];
    for (let i = 0; i < n; i++) {
      const p = H + 2 * i;
      let s = 0;
      for (let m = 0; m < M; m++) s += t[m] * a[p - 2 * m];
      out[i] = s + hc * a[p - c];
    }
    this.hist.set(a.subarray(2 * n, 2 * n + H));
  }
}

/* The oversampling chain. The first stage (lowest rate) is the steep one; the
   ones above it can be short, because their transition band is enormous at the
   higher rates. */
class OverSampler {
  constructor(stages) {
    this.up = stages.map(s => new Up2(s[0], s[1]));
    this.dn = stages.map(s => new Down2(s[0], s[1]));
    this.factor = 1 << stages.length;
    this.tmp = [];
    this.upBuf = null;
    this.upN = 0;
  }
  buf(i, len) {
    if (!this.tmp[i] || this.tmp[i].length !== len) this.tmp[i] = new Float64Array(len);
    return this.tmp[i];
  }
  /* Writes into `this.upBuf` / `this.upN` rather than returning a pair.
     process() may not allocate, and an object literal per block is still an
     allocation even when it is small enough that an engine will usually see
     through it — usually is not a real-time guarantee. */
  upsample(x, n) {
    let cur = x, cn = n;
    for (let k = 0; k < this.up.length; k++) {
      const o = this.buf(k, cn * 2);
      this.up[k].process(cur, cn, o);
      cur = o; cn *= 2;
    }
    this.upBuf = cur; this.upN = cn;
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

/* Length AND beta both matter: the length sets the steepness, the Kaiser beta
   sets the stopband floor. A short low-beta stage plateaus around -60 dB and
   becomes the weakest link in the whole chain. These values each stay under
   -100 dB for a negligible CPU cost. */
function osStages(f) {
  const s = [];
  if (f >= 2) s.push([63, 10.5]);    // 1x -> 2x: narrow transition band
  if (f >= 4) s.push([23, 11.0]);
  if (f >= 8) s.push([19, 11.0]);
  if (f >= 16) s.push([19, 11.0]);
  return s;
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
    this.attC = 1 - Math.exp(-1 / (sampleRate * 0.0012));
    this.relC = 1 - Math.exp(-1 / (sampleRate * 0.050));
    this.envC = 1 - Math.exp(-1 / (sampleRate * 0.0025));
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
      this.dx = x; this.dy = dy; x = dy;

      // gate: fast attack, 6 dB of hysteresis so it cannot chatter
      const a = x < 0 ? -x : x;
      this.env += (a > this.env ? 0.55 : this.envC) * (a - this.env);
      if (thr > 0) {
        this.open = this.env > (this.open ? thr * 0.5 : thr);
        const tgt = this.open ? 1 : 0;
        this.gg += (tgt > this.gg ? this.attC : this.relC) * (tgt - this.gg);
        x *= this.gg * this.gg;             // squared: a gentler close
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
      this.os.upsample(pre, n);
      const buf = this.os.upBuf, on = this.os.upN;
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
