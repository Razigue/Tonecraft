import { readWav, toMono } from '../render/wav.ts';
import { rms, peak, db } from './chain.ts';
const w = readWav(process.argv[2]!);
const x = toMono(w);
console.log('rate', w.rate, 'len s', (x.length / w.rate).toFixed(1), 'rms dB', db(rms(x)).toFixed(1), 'peak dB', db(peak(x)).toFixed(1));
// Active RMS: only 50 ms windows above -40 dBFS.
const win = Math.round(w.rate * 0.05); const act: number[] = [];
for (let i = 0; i + win < x.length; i += win) { const r = rms(x, i, i + win); if (db(r) > -40) act.push(r); }
console.log('active rms dB', db(Math.sqrt(act.reduce((s, r) => s + r * r, 0) / act.length)).toFixed(1));
