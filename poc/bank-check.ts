import { loadBank, attackLevel, SRC_RATE } from './bank.ts';
const t = performance.now();
const b = loadBank();
console.log('loaded in', ((performance.now() - t) / 1000).toFixed(1), 's');
for (const [k, rows] of Object.entries(b)) console.log(k, (rows as any[][]).map((r) => r.length).join(' '),
  'len s', (rows as any[][]).flat().map((s: any) => (s.data.length / SRC_RATE).toFixed(2)).slice(0, 8).join(' '));
console.log('picked string 0 frets', b.picked[0]!.map((s) => s.fret).join(','));
console.log('harmonics s0', b.harmonics[0]!.map((s) => `${s.fret}:x${s.harmonic}:${s.pitch}`).join(' '));
console.log('dead s0', b.dead[0]!.map((s) => s.fret).join(','));
console.log('attack idx', b.picked[2]!.slice(0, 5).map((s) => s.attack).join(','));
