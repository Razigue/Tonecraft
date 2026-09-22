/**
 * Palm mute from a picked note: what the palm does, learned from the dataset.
 *
 * The bank has real palm mutes at the 5th fret only. Resampling one to reach a
 * low B moves its pickup resonance and its pick click down by as much. The
 * alternative is to take the picked note already at the right pitch and do to
 * it what the palm does: a gain per octave band that changes over time, learned
 * as the ratio of muted to open envelopes, 5th fret against 5th fret.
 */
import { SRC_RATE, type Bank, type Sample } from './bank.ts';

export const BAND_EDGES = [0, 90, 180, 360, 720, 1440, 2880, 5760, 22050];
export const FRAME = Math.round(0.005 * SRC_RATE);
export const FRAMES = 160; // 0.8 s

/** Complex FFT, in place, power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; } }
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

/** Splits `x` into bands that sum back to `x` exactly (complementary raised-cosine crossovers in log frequency). */
export function bands(x: Float32Array): Float64Array[] {
  let n = 1; while (n < x.length) n <<= 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  re.set(x);
  fft(re, im);
  const out: Float64Array[] = [];
  const weight = (f: number, b: number) => {
    // Crossover at each inner edge, half an octave wide.
    const up = (edge: number) => edge <= 0 ? 1 : f <= edge / Math.SQRT2 ? 0 : f >= edge * Math.SQRT2 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * Math.log2(f / (edge / Math.SQRT2)));
    const lo = BAND_EDGES[b]!, hi = BAND_EDGES[b + 1]!;
    return up(lo) - (b + 1 === BAND_EDGES.length - 1 ? 0 : up(hi));
  };
  for (let b = 0; b < BAND_EDGES.length - 1; b++) {
    const r = new Float64Array(n), i = new Float64Array(n);
    for (let k = 0; k <= n / 2; k++) {
      const f = k * SRC_RATE / n, w = weight(f, b);
      r[k] = re[k]! * w; i[k] = im[k]! * w;
      if (k > 0 && k < n / 2) { r[n - k] = re[n - k]! * w; i[n - k] = im[n - k]! * w; }
    }
    fft(r, i, true);
    out.push(r.subarray(0, x.length));
  }
  return out;
}

/** Band envelopes, one RMS per 5 ms frame, aligned on the attack. */
export function envelopes(s: Sample): number[][] {
  return bands(s.data).map((band) => Array.from({ length: FRAMES }, (_, f) => {
    const a = s.attack + f * FRAME;
    let e = 0; for (let k = a; k < a + FRAME && k < band.length; k++) e += band[k]! ** 2;
    return Math.sqrt(e / FRAME) + 1e-9;
  }));
}

/** log(muted / open) per band and frame, averaged over the strings given (or over the takes given). */
export function learnMask(bank: Bank, strings: number[], takes?: number[]): number[][] {
  const acc = Array.from({ length: BAND_EDGES.length - 1 }, () => new Float64Array(FRAMES));
  let n = 0;
  for (const s of strings) {
    const open = envelopes(bank.picked[s]!.find((p) => p.fret === 5)!);
    for (const mu of bank.muted[s]!.filter((_, i) => !takes || takes.includes(i))) {
      const m = envelopes(mu);
      m.forEach((band, b) => band.forEach((v, f) => { acc[b]![f]! += Math.log(v / open[b]![f]!); }));
      n++;
    }
  }
  // Smooth over time: the mask is the palm, not the particular take.
  return acc.map((band) => {
    const raw = Array.from(band, (v) => v / n);
    return raw.map((_, f) => { let s = 0, c = 0; for (let k = Math.max(0, f - 3); k <= Math.min(FRAMES - 1, f + 3); k++) { s += raw[k]!; c++; } return s / c; });
  });
}

/** A picked sample with the palm applied. The level ratio at the attack is kept: a mute is quieter. */
export function applyMask(s: Sample, mask: number[][]): Sample {
  const parts = bands(s.data);
  const out = new Float32Array(s.data.length);
  const end = Math.min(s.data.length, s.attack + FRAMES * FRAME);
  parts.forEach((band, b) => {
    for (let k = 0; k < end; k++) {
      const pos = Math.max(0, (k - s.attack) / FRAME - 0.5);
      const f = Math.floor(pos), t = pos - f;
      const g = Math.exp((mask[b]![Math.min(FRAMES - 1, f)]! * (1 - t) + mask[b]![Math.min(FRAMES - 1, f + 1)]! * t));
      out[k]! += band[k]! * g;
    }
  });
  // Band splitting is not causal: fade the pre-roll in again, as the bank does.
  for (let i = 0; i < s.attack; i++) out[i]! *= 0.5 - 0.5 * Math.cos(Math.PI * i / s.attack);
  const fade = Math.round(0.01 * SRC_RATE);
  for (let i = 0; i < fade && end - 1 - i >= 0; i++) out[end - 1 - i]! *= i / fade;
  return { ...s, tech: 'MU', data: out.slice(0, end) };
}
