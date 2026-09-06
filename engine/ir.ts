/**
 * Impulse responses, synthesised in the browser: cabinets and the reverb.
 *
 * There is no .wav to download and no IR pack to ship. A cabinet is a target
 * frequency response, turned into a **minimum-phase** impulse by the real
 * cepstrum method — which is exactly what is wanted here: minimum phase is the
 * most compact transient response a given magnitude admits, so the low end
 * stays tight instead of smearing.
 *
 * The cabinet is not a nicety. The captures we ship are of the amplifier alone:
 * measured, they are still +5 dB at 7 kHz, where a capture that included a
 * cabinet would be 25 dB down. Feed one straight to a speaker and you do not
 * get an amp sound, you get a jigsaw.
 */

/* -------------------------------- FFT ----------------------------------- */

function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t;
      t = im[i]!; im[i] = im[j]!; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const ur = re[i + k]!, ui = im[i + k]!;
        const jr = re[i + k + half]!, ji = im[i + k + half]!;
        const vr = jr * cr - ji * ci;
        const vi = jr * ci + ji * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + half] = ur - vr; im[i + k + half] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i]! /= n; im[i]! /= n; }
}

/* ------------------------- cabinet response curves ----------------------- */

export interface Cab {
  readonly id: string;
  readonly name: string;
  /** One sentence, shown next to the selector. */
  readonly hint: string;
  /** [frequency Hz, level dB], interpolated log/log. */
  readonly curve: readonly (readonly [number, number])[];
}

/**
 * The point that decides whether this sounds like a cabinet is the steep cut
 * above 4-5 kHz: that is what removes the jigsaw fizz.
 */
export const CABS: readonly Cab[] = [
  {
    id: 'v30mod',
    name: 'V30 4x12 — Modern',
    hint: 'SM57 at the edge of the dome. Aggressive mids, clean cut.',
    curve: [[20, -48], [45, -24], [70, -9], [90, -2], [110, 1.5], [140, 1], [180, -1],
      [250, -3], [350, -5.5], [450, -6], [600, -4.5], [800, -3], [1000, -1.5],
      [1300, 0], [1600, 1.5], [2000, 3.5], [2400, 4.5], [2800, 3], [3200, 1],
      [3600, -1.5], [4000, -5], [4600, -11], [5200, -17], [6000, -23],
      [7000, -28], [8000, -32], [10000, -38], [12000, -45], [16000, -56], [22000, -68]],
  },
  {
    id: 'v30dark',
    name: 'V30 4x12 — Off-Axis',
    hint: 'Mic moved towards the cone. Rounder, less bite.',
    curve: [[20, -48], [45, -23], [70, -8], [90, -1.5], [110, 2], [140, 1.5], [180, -0.5],
      [250, -2], [350, -4], [450, -4.5], [600, -3.5], [800, -2], [1000, -1],
      [1300, -0.5], [1600, 0], [2000, 1], [2400, 1.5], [2800, 0], [3200, -2.5],
      [3600, -6], [4000, -10], [4600, -16], [5200, -21], [6000, -26],
      [7000, -31], [8000, -35], [10000, -41], [12000, -48], [16000, -58], [22000, -70]],
  },
  {
    id: 'green',
    name: 'Greenback 4x12 — Vintage',
    hint: 'Singing mids, more grain. Thrash and old school.',
    curve: [[20, -50], [45, -26], [70, -12], [90, -4], [110, 0], [140, 0.5], [180, -0.5],
      [250, -2.5], [350, -4], [450, -3.5], [600, -1.5], [800, 0.5], [1000, 2],
      [1300, 3], [1600, 4], [2000, 4.5], [2400, 3], [2800, 1.5], [3200, 2],
      [3600, 0], [4000, -3], [4600, -8], [5200, -13], [6000, -19],
      [7000, -25], [8000, -30], [10000, -37], [12000, -44], [16000, -55], [22000, -67]],
  },
  {
    id: 'mod112',
    name: '1x12 Open Back',
    hint: 'Lighter underneath, sits better in a busy mix.',
    curve: [[20, -55], [45, -34], [70, -20], [90, -10], [110, -3], [130, 0.5], [180, -2],
      [250, -4], [350, -5], [450, -5], [600, -3], [800, -1.5], [1000, 0],
      [1300, 1], [1600, 2], [2000, 3], [2400, 3.5], [2800, 2], [3200, 0],
      [3600, -2], [4000, -6], [4600, -12], [5200, -18], [6000, -24],
      [7000, -29], [8000, -33], [10000, -40], [12000, -47], [16000, -58], [22000, -70]],
  },
] as const;

export const DEFAULT_CAB = 'v30mod';

const cabById = (id: string): Cab => CABS.find((c) => c.id === id) ?? CABS[0]!;

function dbAt(curve: readonly (readonly [number, number])[], f: number): number {
  const first = curve[0]!;
  if (f <= first[0]) return first[1];
  const last = curve[curve.length - 1]!;
  if (f >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const hi = curve[i]!;
    if (f <= hi[0]) {
      const lo = curve[i - 1]!;
      const t = Math.log(f / lo[0]) / Math.log(hi[0] / lo[0]);
      return lo[1] + t * (hi[1] - lo[1]);
    }
  }
  return last[1];
}

/** Minimum-phase impulse from a magnitude spectrum, via the real cepstrum. */
function minPhaseIR(mag: Float64Array): Float64Array {
  const N = mag.length;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = Math.log(Math.max(mag[i]!, 1e-7));

  fft(re, im, true);                        // the real cepstrum, in re[]

  const c = new Float64Array(N);
  c[0] = re[0]!;
  c[N / 2] = re[N / 2]!;
  for (let i = 1; i < N / 2; i++) c[i] = 2 * re[i]!;   // fold onto the causal side

  const r2 = Float64Array.from(c), i2 = new Float64Array(N);
  fft(r2, i2, false);
  for (let i = 0; i < N; i++) {             // complex exponential
    const e = Math.exp(r2[i]!), a = i2[i]!;
    r2[i] = e * Math.cos(a);
    i2[i] = e * Math.sin(a);
  }
  fft(r2, i2, true);
  return r2;
}

/** Gain of an IR at one frequency, used to level every cabinet the same. */
function gainAt(h: Float32Array, len: number, f: number, sr: number): number {
  let re = 0, im = 0;
  const w = (2 * Math.PI * f) / sr;
  for (let i = 0; i < len; i++) { re += h[i]! * Math.cos(w * i); im -= h[i]! * Math.sin(w * i); }
  return Math.hypot(re, im);
}

/**
 * A stereo cabinet IR.
 *
 * Both channels share the curve with a micro-variation of timbre, which opens
 * the stereo image slightly without introducing any phase difference — so the
 * mono sum stays perfectly clean.
 */
export function makeCabIR(ctx: BaseAudioContext, id: string): AudioBuffer {
  const cab = cabById(id);
  const sr = ctx.sampleRate;
  const N = 8192;
  const LEN = 1024;                          // ~21 ms at 48 kHz, plenty
  const buf = ctx.createBuffer(2, LEN, sr);

  for (let ch = 0; ch < 2; ch++) {
    const tilt = ch === 1;                   // right channel: a subtle variation
    const mag = new Float64Array(N);
    for (let k = 0; k <= N / 2; k++) {
      const f = Math.max((k * sr) / N, 1);
      let db = dbAt(cab.curve, f);
      if (tilt) {
        db += 0.7 * Math.sin(Math.log(f / 180) * 1.7);   // +/- 0.7 dB
        if (f > 4000) db -= 0.8;
      }
      const m = Math.pow(10, db / 20);
      mag[k] = m;
      if (k > 0 && k < N / 2) mag[N - k] = m;
    }

    const h = minPhaseIR(mag);
    const out = buf.getChannelData(ch);

    // Half-cosine window over the last quarter, rather than a hard truncation.
    const fadeStart = Math.floor(LEN * 0.72);
    for (let i = 0; i < LEN; i++) {
      let w = 1;
      if (i >= fadeStart) {
        const t = (i - fadeStart) / (LEN - fadeStart);
        w = 0.5 * (1 + Math.cos(Math.PI * t));
      }
      out[i] = h[i]! * w;
    }

    // A very quiet tail: the box's own resonances, -32 dB, about 9 ms.
    let seed = 1234567 + ch * 7919, lp = 0;
    const tailN = Math.min(LEN, Math.floor(sr * 0.009));
    const start = Math.floor(sr * 0.0012);
    for (let i = start; i < tailN; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const nse = seed / 0x3fffffff - 1;
      lp += 0.22 * (nse - lp);
      const env = Math.pow(1 - (i - start) / (tailN - start), 3);
      out[i]! += lp * env * 0.025;
    }

    // Levelled at 1 kHz, so switching cabinet is a change of tone and not of
    // volume.
    const g = gainAt(out, LEN, 1000, sr);
    if (g > 1e-9) for (let i = 0; i < LEN; i++) out[i]! /= g;
  }
  return buf;
}

/** A small dark plate, enough to place the sound without drowning it. */
export function makeReverbIR(ctx: BaseAudioContext, seconds = 1.3): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, n, sr);
  const pre = Math.floor(sr * 0.014);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let seed = 987654321 + ch * 31337, lp = 0, hp = 0;
    for (let i = 0; i < n; i++) {
      if (i < pre) { d[i] = 0; continue; }
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const nse = seed / 0x3fffffff - 1;
      lp += 0.30 * (nse - lp);              // dark plate: no shrill top
      hp += 0.004 * (lp - hp);
      const t = (i - pre) / (n - pre);
      const env = Math.pow(1 - t, 2.6) * Math.min(1, (i - pre) / (sr * 0.02));
      d[i] = (lp - hp) * env;
    }
    /* Normalised by ENERGY, not by peak. A reverb IR is a cloud of thousands of
       samples of the same order of magnitude: its real gain is the gain of the
       sum, not of the largest term. Setting the peak to 0.55 gives a broadband
       gain of +26 dB here — the convolver runs with disableNormalization, so
       nothing downstream catches it, and the reverb comes back louder than the
       direct signal: all you hear is an echo. Dividing by the square root of the
       energy gives unity gain, and the Reverb fader means what it says again:
       its value IS the level of the reverb. */
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i]! * d[i]!;
    const g = Math.sqrt(e);
    if (g > 1e-9) for (let i = 0; i < n; i++) d[i]! /= g;
  }
  return buf;
}
