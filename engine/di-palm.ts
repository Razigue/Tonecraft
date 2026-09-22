/**
 * The palm, as a filter learned from recordings.
 *
 * A palm mute is not a different note, it is the same note with a hand resting
 * on the strings: the attack darkens and the ring dies early. Measured on a
 * guitar — the same fret played open and muted — that is a gain per octave
 * band that changes over time, and it transfers to any other note of that
 * string. It is learned once when the bank is built (`scripts/build-di-bank.ts`)
 * and shipped with it, so nothing here runs at load time.
 *
 * Learning it beats carrying muted samples: a bank cannot hold a mute for
 * every fret, and resampling one from the 5th fret down to a 7-string's low B
 * drags its pick click and its pickup resonance down with it. Leave-one-string-
 * out, the masked note lands as close to a real mute as another take of that
 * same mute does (12.6 dB against 12.2; resampling by ten semitones, 14.9).
 */

/** Octave bands, Hz. The top one runs to Nyquist. */
export const BAND_EDGES = [0, 90, 180, 360, 720, 1440, 2880, 5760, 22050];
/** One mask frame per 5 ms. */
export const FRAME_SECONDS = 0.005;
/** 0.8 s of mask: a mute is long gone by then. */
export const FRAMES = 160;

/** log(muted / open) per band and frame. */
export type PalmMask = readonly (readonly number[])[];

/** In-place complex FFT, power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let b = n >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inverse ? 2 : -2) * Math.PI / len;
    for (let i = 0; i < n; i += len) for (let k = 0; k < len / 2; k++) {
      const wr = Math.cos(a * k), wi = Math.sin(a * k);
      const u = i + k, v = u + len / 2;
      const xr = re[v]! * wr - im[v]! * wi, xi = re[v]! * wi + im[v]! * wr;
      re[v] = re[u]! - xr; im[v] = im[u]! - xi; re[u]! += xr; im[u]! += xi;
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i]! /= n; im[i]! /= n; }
}

/**
 * Splits a note into bands that sum back to it exactly: complementary
 * raised-cosine crossovers, half an octave wide, in the frequency domain.
 */
export function splitBands(x: Float32Array, rate: number): Float64Array<ArrayBuffer>[] {
  let n = 1;
  while (n < x.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  const rise = (f: number, edge: number): number => {
    if (edge <= 0) return 1;
    const lo = edge / Math.SQRT2, hi = edge * Math.SQRT2;
    if (f <= lo) return 0;
    if (f >= hi) return 1;
    return 0.5 - 0.5 * Math.cos(Math.PI * Math.log2(f / lo));
  };
  const out: Float64Array<ArrayBuffer>[] = [];
  for (let b = 0; b < BAND_EDGES.length - 1; b++) {
    const r = new Float64Array(n), i = new Float64Array(n);
    const last = b + 2 === BAND_EDGES.length;
    for (let k = 0; k <= n / 2; k++) {
      const f = k * rate / n;
      const w = rise(f, BAND_EDGES[b]!) - (last ? 0 : rise(f, BAND_EDGES[b + 1]!));
      r[k] = re[k]! * w; i[k] = im[k]! * w;
      if (k > 0 && k < n / 2) { r[n - k] = re[n - k]! * w; i[n - k] = im[n - k]! * w; }
    }
    fft(r, i, true);
    out.push(r.subarray(0, x.length));
  }
  return out;
}

/** Band envelopes, one RMS per frame, from `attack` on. */
export function envelopes(data: Float32Array, attack: number, rate: number): number[][] {
  const frame = Math.round(FRAME_SECONDS * rate);
  return splitBands(data, rate).map((band) => Array.from({ length: FRAMES }, (_, f) => {
    const at = attack + f * frame;
    let e = 0;
    for (let k = at; k < at + frame && k < band.length; k++) e += band[k]! ** 2;
    return Math.sqrt(e / frame) + 1e-9;
  }));
}

/**
 * Applies the palm to a picked note.
 *
 * The mask carries two things that are scaled apart. Its first frame is how
 * dark and quiet the palm makes the attack — the chug, kept nearly whole — and
 * the rest is how fast it then kills the note, which the dataset's hardest
 * takes do in 80 ms. Left at 1, running sixteenths on the high strings left a
 * hole before every note.
 */
export function applyPalm(data: Float32Array, attack: number, rate: number, mask: PalmMask, decay: number, tone: number): Float32Array<ArrayBuffer> {
  const frame = Math.round(FRAME_SECONDS * rate);
  const parts = splitBands(data, rate);
  const end = Math.min(data.length, attack + FRAMES * frame);
  const out = new Float32Array(end);
  parts.forEach((band, b) => {
    const row = mask[b]!;
    for (let k = 0; k < end; k++) {
      const pos = Math.max(0, (k - attack) / frame - 0.5);
      const f = Math.floor(pos), t = pos - f;
      const m = row[Math.min(FRAMES - 1, f)]! * (1 - t) + row[Math.min(FRAMES - 1, f + 1)]! * t;
      out[k]! += band[k]! * Math.exp(tone * row[0]! + decay * (m - row[0]!));
    }
  });
  // Band splitting is not causal, so the fade the bank cut into the pre-roll
  // has to be cut again, and the new end needs one of its own.
  for (let i = 0; i < attack; i++) out[i]! *= 0.5 - 0.5 * Math.cos(Math.PI * i / attack);
  const fade = Math.round(0.01 * rate);
  for (let i = 0; i < fade && end - 1 - i >= 0; i++) out[end - 1 - i]! *= i / fade;
  return out;
}
