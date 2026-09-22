/** Clicks, NaNs and timing: what an ear would catch first, measured. */
import fs from 'node:fs';
import { readWav, toMono } from '../render/wav.ts';
import { loadScore, trackEvents, span } from './tab-events.ts';
const [file, gp, track, from, to] = process.argv.slice(2);
const x = toMono(readWav(file!));
let nan = 0; for (const v of x) if (!Number.isFinite(v)) nan++;
// A click: a second difference far above what the local signal carries.
const d2 = new Float32Array(x.length);
for (let i = 2; i < x.length; i++) d2[i] = Math.abs(x[i]! - 2 * x[i - 1]! + x[i - 2]!);
const W = 480; let clicks = 0; const at: number[] = [];
for (let i = W; i < x.length - W; i++) {
  if (d2[i]! < 1e-4) continue;
  let s = 0; for (let k = i - W; k < i + W; k += 4) s += d2[k]!; const mean = s / (2 * W / 4);
  if (d2[i]! > 40 * mean) { clicks++; if (at.length < 12) at.push(+(i / 48000).toFixed(3)); i += W; }
}
console.log(`NaN ${nan}, clicks ${clicks}`, at.join(' '));
if (gp) {
  const score = loadScore(new Uint8Array(fs.readFileSync(gp)));
  const [t0, t1] = span(score, +from!, +to! - 1);
  const ev = trackEvents(score, +track!, 1).events.filter((e) => e.start >= t0 && e.start < t1 && e.attack === 'pick');
  // Onset: where the 1 ms envelope first exceeds 4x its level 10 ms earlier, near each event.
  const env = new Float32Array(Math.ceil(x.length / 48)); for (let i = 0; i < env.length; i++) { let s = 0; for (let k = i * 48; k < i * 48 + 48 && k < x.length; k++) s += x[k]! ** 2; env[i] = Math.sqrt(s / 48); }
  const errs: number[] = [];
  for (const e of ev) { const c = Math.round((e.start - t0 + 0.25) * 1000); let found = -1; for (let m = c - 8; m < c + 15; m++) if (m > 10 && env[m]! > 4 * env[m - 10]! + 1e-5) { found = m; break; } if (found >= 0) errs.push(found - c); }
  errs.sort((a, b) => a - b);
  console.log(`onsets found ${errs.length}/${ev.length}, offset ms median ${errs[errs.length >> 1]}, p10 ${errs[Math.floor(errs.length * 0.1)]}, p90 ${errs[Math.floor(errs.length * 0.9)]}`);
}
