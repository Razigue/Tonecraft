import fs from 'node:fs';
import { loadScore, trackEvents, tempoMap } from './tab-events.ts';
const score = loadScore(new Uint8Array(fs.readFileSync(process.argv[2]!)));
const time = tempoMap(score);
for (const ti of [0, 1, 2, 3, 4]) {
  const ev = trackEvents(score, ti).events;
  const bars = new Map<number, number>();
  for (const mb of score.masterBars) { const a = time(mb.start), b = time(mb.start + mb.calculateDuration()); bars.set(mb.index, ev.filter(e => e.start >= a && e.start < b).length); }
  const line = [...bars].map(([i, n]) => n === 0 ? '.' : n < 10 ? String(n) : '#').join('');
  console.log(ti, line);
}
console.log('bar 0 at', 0, 'bar 16', time(score.masterBars[16]!.start).toFixed(1), 'bar 20', time(score.masterBars[20]!.start).toFixed(1), 'end', time(score.masterBars.at(-1)!.start).toFixed(1));
