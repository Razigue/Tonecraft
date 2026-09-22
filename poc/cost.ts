/** What rendering a whole tab costs: DI engines and the chain, per second of music, on this machine. */
import fs from 'node:fs';
import { loadScore, trackEvents, span } from './tab-events.ts';
import { renderSampler } from './sampler.ts';
import { renderModel, DEFAULT_PARAMS } from './string-model.ts';
import { loadBank } from './bank.ts';
import { throughChain } from './chain.ts';
const score = loadScore(new Uint8Array(fs.readFileSync(process.argv[2]!)));
const [t0, t1] = span(score, 0, 999);
const seconds = t1 - t0;
let t = performance.now();
const bank = loadBank();
const bankBytes = Object.values(bank).flat(2).reduce((n: number, s: any) => n + s.data.byteLength, 0);
console.log(`bank: ${(bankBytes / 1e6).toFixed(1)} MB float32 in memory, loaded in ${((performance.now() - t) / 1000).toFixed(2)} s`);
const tr = trackEvents(score, 1, 1);
t = performance.now(); renderSampler({ ...tr, events: tr.events.filter((e) => e.start < 20) }, 21, 1); // warm: palm masks
const warm = (performance.now() - t) / 1000;
const heap0 = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
t = performance.now(); const di = renderSampler(tr, seconds + 1, 1); const ds = (performance.now() - t) / 1000;
const heap1 = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
console.log(`sampler: ${seconds.toFixed(0)} s of music in ${ds.toFixed(1)} s (${(seconds / ds).toFixed(0)}x real time); palm masks first use ${warm.toFixed(1)} s; cached PM ${((heap1 - heap0) / 1e6).toFixed(0)} MB`);
t = performance.now(); renderModel({ ...tr, events: tr.events.filter((e) => e.start < 60) }, 60, DEFAULT_PARAMS, 1); const ms = (performance.now() - t) / 1000;
console.log(`model: 60 s of music in ${ms.toFixed(1)} s (${(60 / ms).toFixed(1)}x real time)`);
t = performance.now(); await throughChain(di, 'Modern metal'); const cs = (performance.now() - t) / 1000;
console.log(`chain (NAM + cab), one track: ${seconds.toFixed(0)} s in ${cs.toFixed(1)} s (${(seconds / cs).toFixed(0)}x real time, ${(100 * cs / seconds).toFixed(1)}% of a core while playing)`);
