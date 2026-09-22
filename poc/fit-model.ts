/** Fits the physical model's voicing to the sampler's: same notes, same long-term spectrum. */
import fs from 'node:fs';
import { loadScore, trackEvents, span } from './tab-events.ts';
import { renderModel, DEFAULT_PARAMS, type ModelParams } from './string-model.ts';
import { renderSampler } from './sampler.ts';
import { ltas, bands } from './analysis.ts';
const score = loadScore(new Uint8Array(fs.readFileSync('/home/shinkei/Downloads/First Fragment - De Chair Et De Haine.gp')));
const sections = [[0, 30, 34], [2, 22, 26]].map(([tr, a, b]) => {
  const [t0, t1] = span(score, a!, b! - 1);
  const t = trackEvents(score, tr!, 1);
  const events = t.events.filter((e) => e.start >= t0 && e.start < t1).map((e) => ({ ...e, start: e.start - t0 + 0.1, end: Math.min(e.end, t1) - t0 + 0.1 }));
  return { track: { ...t, events }, seconds: t1 - t0 + 0.5 };
});
const use = bands.map((b, i) => (b >= 160 && b <= 8000 ? i : -1)).filter((i) => i >= 0);
const shape = (x: Float32Array) => { const l = ltas(x, 48000); const m = use.reduce((s, i) => s + l[i]!, 0) / use.length; return use.map((i) => l[i]! - m); };
const targets = sections.map((s) => shape(renderSampler(s.track, s.seconds, 1)));
const score_ = (p: ModelParams) => sections.reduce((acc, s, k) => { const l = shape(renderModel(s.track, s.seconds, p, 1)); return acc + Math.sqrt(l.reduce((e, v, i) => e + (v - targets[k]![i]!) ** 2, 0) / l.length); }, 0) / sections.length;
const seed = fs.existsSync('poc/out/model-params.json') ? JSON.parse(fs.readFileSync('poc/out/model-params.json', 'utf8')) : {};
let best = { ...DEFAULT_PARAMS, ...seed }, bestErr = score_(best);
console.log('start', bestErr.toFixed(2));
const grid: Partial<Record<keyof ModelParams, number[]>> = { tilt: [0, 0.3, 0.6, 1], resonance: [1800, 2200, 2700, 3300], q: [0.7, 1.1, 1.6, 2.2], pulse: [1, 2, 3.5, 5], pickAt: [0.05, 0.085, 0.12, 0.16], palmT60: [0.2, 0.4, 0.8], palmTreble: [0.015, 0.035, 0.07], t60Treble: [0.25, 0.5, 1] };
// Coordinate descent, twice round.
for (let round = 0; round < 2; round++) for (const [k, vals] of Object.entries(grid)) {
  for (const v of vals!) { const p = { ...best, [k]: v }; const e = score_(p); if (e < bestErr) { bestErr = e; best = p; console.log(k, v, e.toFixed(2)); } }
}
console.log('best', JSON.stringify(best), bestErr.toFixed(2));
const l = sections.map((s) => shape(renderModel(s.track, s.seconds, best, 1)));
use.forEach((i, j) => console.log(String(bands[i]).padStart(5), targets.map((t, k) => `${t[j]!.toFixed(1).padStart(7)} ${l[k]![j]!.toFixed(1).padStart(7)}`).join('   |')));
fs.writeFileSync('poc/out/model-params.json', JSON.stringify(best, null, 1));
