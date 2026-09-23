/** Can the DI's level be guessed from the notes alone, before rendering them? */
import fs from 'node:fs';
import * as alpha from '@coderline/alphatab';
import { decodeBank, type BankIndex } from '../engine/di-bank.ts';
import { renderDi, activeRms } from '../engine/di-sampler.ts';
import { trackEvents, span } from '../engine/tab-guitar.ts';
import type { TrackEvents } from '../engine/tab-guitar.ts';

const idx = JSON.parse(fs.readFileSync('public/di-bank/bank.json', 'utf8')) as BankIndex;
const pcm = fs.readFileSync('public/di-bank/bank.pcm');
const bank = decodeBank(idx, new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2));

/** The energy a track puts out, per 50 ms, from its events alone. */
function estimate(track: TrackEvents, seconds: number): number {
  const step = 0.05;
  const grid = new Float64Array(Math.ceil(seconds / step) + 1);
  for (const e of track.events) {
    // A mute is quieter and shorter; a harmonic and a dead note quieter still.
    const level = e.velocity ** 2 * (e.palm ? 0.1 : 1) * (e.dead ? 0.15 : 1) * (e.harmonic ? 0.4 : 1) * (e.attack === 'pick' ? 1 : 0.4);
    const from = Math.floor(e.start / step);
    const to = Math.min(grid.length - 1, Math.ceil(e.end / step));
    for (let i = from; i <= to; i++) {
      if (i < 0) continue;
      // What a plucked string does after it is struck.
      const t = i * step - e.start;
      grid[i]! += level * Math.exp(-t / (e.palm ? 0.12 : 0.9));
    }
  }
  const levels = Array.from(grid).filter((v) => v > 1e-9).map(Math.sqrt).sort((a, b) => b - a);
  if (levels.length === 0) return 0;
  const loud = levels.slice(0, Math.max(1, Math.floor(levels.length * 0.8)));
  return Math.sqrt(loud.reduce((s, v) => s + v * v, 0) / loud.length);
}

const cases: [string, number, number, number][] = [
  ['/home/shinkei/Downloads/Archspire - Drain Of Incarnation.gp', 1, 162, 177],
  ['/home/shinkei/Downloads/Archspire - Drain Of Incarnation.gp', 0, 158, 173],
  ['/home/shinkei/Downloads/Archspire - Drain Of Incarnation.gp', 2, 100, 115],
  ['/home/shinkei/Downloads/First Fragment - De Chair Et De Haine.gp', 0, 30, 45],
  ['/home/shinkei/Downloads/First Fragment - De Chair Et De Haine.gp', 2, 20, 30],
  ['/home/shinkei/Downloads/First Fragment - De Chair Et De Haine.gp', 1, 60, 75],
];
const ratios: number[] = [];
for (const [file, track, a, b] of cases) {
  const score = alpha.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(file)), new alpha.Settings());
  const [t0, t1] = span(score, a, b);
  const all = trackEvents(score, track, track + 1);
  const events = all.events.filter((e) => e.start >= t0 && e.start < t1).map((e) => ({ ...e, start: e.start - t0, end: Math.min(e.end, t1) - t0 }));
  if (events.length < 10) { console.log(file.split(' - ')[1], 'track', track, ': too few notes'); continue; }
  const cut = { ...all, events };
  const seconds = t1 - t0 + 1;
  const real = activeRms(renderDi(bank, cut, { rate: 48000, seconds }), 48000);
  const guess = estimate(cut, seconds);
  ratios.push(20 * Math.log10(real / guess));
  console.log(`${(file.split('/').pop() ?? '').slice(0, 22)} track ${track}: rendered ${(20 * Math.log10(real)).toFixed(1)} dB, estimate ${(20 * Math.log10(guess)).toFixed(1)} dB, difference ${(20 * Math.log10(real / guess)).toFixed(2)} dB`);
}
const mean = ratios.reduce((s, v) => s + v, 0) / ratios.length;
const spread = Math.sqrt(ratios.reduce((s, v) => s + (v - mean) ** 2, 0) / ratios.length);
console.log(`\ncalibration ${mean.toFixed(2)} dB, spread ${spread.toFixed(2)} dB, worst ${Math.max(...ratios.map((r) => Math.abs(r - mean))).toFixed(2)} dB`);
