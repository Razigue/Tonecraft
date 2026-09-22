/**
 * Renders a tab's guitar tracks through a DI engine, then through the chain.
 *
 *   npx tsx poc/render.ts <file.gp> --engine model|sampler --tracks 0,1 --bars 0-24 --preset Lead --out poc/out/name
 *
 * Several tracks are panned across the stereo field (two rhythm tracks go hard
 * left and right, the way they are recorded). Writes <out>-di.wav (the raw DI,
 * first track) and <out>.wav (through the amp).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadScore, trackEvents, span, type TrackEvents } from './tab-events.ts';
import { renderModel } from './string-model.ts';
import { throughChain, rms, db, RATE } from './chain.ts';
import { writeWav } from '../render/wav.ts';

/** The shipped DI's level while playing: what the presets are voiced for. */
export const TARGET_ACTIVE_RMS_DB = -36.1;

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : dflt; };
const file = args[0]!;
const engine = opt('engine', 'model');
const tracks = opt('tracks', '0').split(',').map(Number);
const [barFrom, barTo] = opt('bars', '0-16').split('-').map(Number) as [number, number];
const preset = opt('preset', 'Lead');
const out = opt('out', `poc/out/${engine}`);

export function activeRms(x: Float32Array): number {
  const win = RATE * 0.05, act: number[] = [];
  for (let i = 0; i + win < x.length; i += win) { const r = rms(x, i, i + win); if (db(r) > -60) act.push(r); }
  const top = act.sort((a, b) => b - a).slice(0, Math.max(1, Math.floor(act.length * 0.8)));
  return Math.sqrt(top.reduce((s, r) => s + r * r, 0) / top.length);
}

async function engineFor(name: string): Promise<(t: TrackEvents, seconds: number, seed: number) => Float32Array> {
  if (name === 'model') return (t, s, seed) => renderModel(t, s, undefined, seed);
  if (name === 'sampler') return (await import('./sampler.ts')).renderSampler;
  throw new Error(`unknown engine ${name}`);
}

const score = loadScore(new Uint8Array(fs.readFileSync(file)));
const [t0, t1] = span(score, barFrom, barTo);
const seconds = t1 - t0 + 1.5;
const render = await engineFor(engine);
fs.mkdirSync(path.dirname(out), { recursive: true });

const pans = tracks.length === 1 ? [0] : tracks.map((_, i) => (i === 0 ? -1 : i === 1 ? 1 : 0));
const left = new Float32Array(Math.ceil((seconds + 2) * RATE)), right = new Float32Array(left.length);
for (const [k, ti] of tracks.entries()) {
  const t = trackEvents(score, ti, k + 1);
  const events = t.events.filter((e) => e.start >= t0 - 0.01 && e.start < t1)
    .map((e) => ({ ...e, start: e.start - t0 + 0.25, end: Math.min(e.end, t1 + 1) - t0 + 0.25 }));
  const started = performance.now();
  const di = render({ ...t, events }, seconds, k + 1);
  const gain = Math.pow(10, TARGET_ACTIVE_RMS_DB / 20) / activeRms(di);
  for (let i = 0; i < di.length; i++) di[i]! *= gain;
  console.log(`${t.name}: ${events.length} notes, DI ${((performance.now() - started) / 1000).toFixed(1)} s, gain ${db(gain).toFixed(1)} dB, peak ${db(di.reduce((m, v) => Math.max(m, Math.abs(v)), 0)).toFixed(1)} dBFS`);
  if (k === 0) writeWav(`${out}-di.wav`, RATE, [di]);
  const wet = await throughChain(di, preset);
  // Equal-power pan; a centred single track stays at unity.
  const p = pans[k]!, gl = tracks.length === 1 ? 1 : Math.cos((p + 1) * Math.PI / 4), gr = tracks.length === 1 ? 1 : Math.sin((p + 1) * Math.PI / 4);
  for (let i = 0; i < wet.length && i < left.length; i++) { left[i]! += wet[i]! * gl; right[i]! += wet[i]! * gr; }
}
writeWav(`${out}.wav`, RATE, tracks.length === 1 ? [left] : [left, right]);
console.log(`wrote ${out}.wav, ${seconds.toFixed(1)} s, bars ${barFrom}-${barTo}`);
