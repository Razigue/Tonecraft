import { cabIR, shapeCabIR } from './ir.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

const rate = 48_000;
const gain1k = (h: Float32Array): number => {
  let re = 0, im = 0;
  const w = (2 * Math.PI * 1000) / rate;
  for (let i = 0; i < h.length; i++) { re += h[i]! * Math.cos(w * i); im -= h[i]! * Math.sin(w * i); }
  return Math.hypot(re, im);
};

// A synthesised cabinet, exported the way IR packs are: 5 ms of silence first,
// half a second long, 12 dB hot.
const cab = cabIR(rate, 'v30mod');
const file = new Float32Array(rate / 2);
const lead = Math.round(rate * 0.005);
for (let i = 0; i < cab.length; i++) file[lead + i] = cab[i]! * 4;

const shaped = shapeCabIR(file, rate)!;
const peakAt = (h: Float32Array): number => h.reduce((best, v, i) => (Math.abs(v) > Math.abs(h[best]!) ? i : best), 0);
check('the pre-delay is cut, so the chain adds no latency', peakAt(shaped) === peakAt(cab), `peak at ${peakAt(shaped)}, not ${peakAt(cab)}`);
check('the silent tail is cut', shaped.length <= cab.length, `${shaped.length} taps`);
check('levelled at 1 kHz like the synthesised cabinets', Math.abs(20 * Math.log10(gain1k(shaped))) < 0.1, `${(20 * Math.log10(gain1k(shaped))).toFixed(2)} dB`);

const long = new Float32Array(rate * 2).map((_, i) => Math.exp(-i / rate) * (i % 7 === 0 ? 1 : -0.5));
check('capped at 200 ms', shapeCabIR(long, rate)!.length === rate * 0.2);
check('silence is refused', shapeCabIR(new Float32Array(1024), rate) === null);

if (failures.length > 0) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nir: all passed');
