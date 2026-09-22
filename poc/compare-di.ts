/** Long-term spectrum of DI files in octave-third bands, normalised at 1 kHz, plus crest factor. */
import { readWav, toMono } from '../render/wav.ts';
import { activeRms, ltas, bands } from './analysis.ts';
const rows = process.argv.slice(2).map((f) => { const w = readWav(f); const x = toMono(w); const l = ltas(x, w.rate); const ref = l[bands.indexOf(1000)]!;
  const pk = x.reduce((m, v) => Math.max(m, Math.abs(v)), 0); return { f, l: l.map((v) => v - ref), crest: 20 * Math.log10(pk / activeRms(x)) }; });
console.log('band  ' + rows.map((r) => r.f.split('/').pop()!.slice(0, 14).padStart(15)).join(''));
bands.forEach((b, i) => console.log(String(b).padStart(5) + ' ' + rows.map((r) => r.l[i]!.toFixed(1).padStart(15)).join('')));
console.log('crest ' + rows.map((r) => r.crest.toFixed(1).padStart(15)).join(''));
