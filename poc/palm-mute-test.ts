/** Which palm mute is closer to a real one it has never seen? Leave-one-string-out. */
import { loadBank, SRC_RATE, type Sample } from './bank.ts';
import { learnMask, applyMask, envelopes } from './palm-mute.ts';
const bank = loadBank();
/** Resample by `semis` (the sampler's own way of moving a note). */
function shifted(s: Sample, semis: number): Sample {
  const r = Math.pow(2, semis / 12), n = Math.floor(s.data.length / r), d = new Float32Array(n);
  for (let i = 0; i < n; i++) { const p = i * r, a = Math.floor(p), f = p - a; d[i] = (s.data[a] ?? 0) * (1 - f) + (s.data[a + 1] ?? 0) * f; }
  return { ...s, data: d, attack: Math.round(s.attack / r) };
}
/** Distance in dB between band envelopes over the first 300 ms, level-matched. */
const cache = new Map<Sample, number[][]>();
function env(s: Sample): number[][] {
  let e = cache.get(s);
  if (!e) {
    e = envelopes(s);
    // Floor 60 dB under the note's loudest band-frame: below it is the recording's noise, not the palm.
    const top = Math.max(...e.flat());
    e = e.map((b) => b.map((v) => Math.max(v, top * 1e-3)));
    cache.set(s, e);
  }
  return e;
}
function dist(a: Sample, b: Sample): number {
  const ea = env(a), eb = env(b); const F = 60;
  const diffs: number[] = [];
  ea.forEach((band, k) => { for (let f = 0; f < F; f++) diffs.push(20 * Math.log10(band[f]! / eb[k]![f]!)); });
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length;
  return Math.sqrt(diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / diffs.length);
}
const rows: string[] = [];
const sum = { mask: 0, shift5: 0, shift10: 0, n5: 0, n10: 0, n: 0, self: 0 };
for (let s = 0; s < 6; s++) {
  const mask = learnMask(bank, [0, 1, 2, 3, 4, 5].filter((x) => x !== s));
  const real = bank.muted[s]!;
  const pk5 = bank.picked[s]!.find((p) => p.fret === 5)!;
  const masked = applyMask(pk5, mask);
  const shifts5 = s >= 1 ? bank.muted[s - 1]!.map((c) => shifted(c, 5)) : [];
  const shifts10 = s >= 2 ? bank.muted[s - 2]!.map((c) => shifted(c, 10)) : [];
  const avg = (c: Sample) => real.reduce((a, r) => a + dist(c, r), 0) / real.length;
  const selfd = real.reduce((a, r, i) => a + real.filter((_, j) => j !== i).reduce((b, q) => b + dist(r, q), 0) / (real.length - 1), 0) / real.length;
  const m = avg(masked);
  sum.mask += m; sum.self += selfd; sum.n++;
  let line = `string ${s}: other takes of the same mute ${selfd.toFixed(2)} dB | masked picked ${m.toFixed(2)}`;
  // A mute brought from one or two strings below, by +5 / +10 semitones.
  if (s >= 1) { const v = shifts5.reduce((a, c) => a + avg(c), 0) / 5; sum.shift5 += v; sum.n5++; line += ` | resampled +5 ${v.toFixed(2)}`; }
  if (s >= 2) { const v = shifts10.reduce((a, c) => a + avg(c), 0) / 5; sum.shift10 += v; sum.n10++; line += ` | resampled +10 ${v.toFixed(2)}`; }
  console.log(line);
}
console.log(`mean: take-to-take ${(sum.self / sum.n).toFixed(2)}, masked ${(sum.mask / sum.n).toFixed(2)}, +5 ${(sum.shift5 / sum.n5).toFixed(2)}, +10 ${(sum.shift10 / sum.n10).toFixed(2)}`);
