/**
 * The tab render, end to end, in Node: a Guitar Pro file in, a WAV per guitar
 * track out, through the same modules the reader's worker runs.
 *
 *   npx tsx scripts/test-tab-render.ts <file.gp> [--bars 30-45] [--out /tmp/x]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alpha from '@coderline/alphatab';
import { decodeBank, type BankIndex } from '../engine/di-bank.ts';
import { renderTabTrack } from '../engine/tab-render.ts';
import { trackEvents, span, timeline } from '../engine/tab-guitar.ts';
import { PRESETS } from '../app/presets.ts';
import { CABS, shapeCabIR } from '../engine/ir.ts';
import { readWav, toMono, writeWav } from '../render/wav.ts';
import type { Capture } from '../engine/catalog.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 48000;
const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : dflt; };
const [barFrom, barTo] = opt('bars', '30-45').split('-').map(Number) as [number, number];
const out = opt('out', 'poc/out/app');

const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/di-bank/bank.json'), 'utf8')) as BankIndex;
const pcmBytes = fs.readFileSync(path.join(ROOT, 'public/di-bank/bank.pcm'));
const bank = decodeBank(index, new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2));
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/index.json'), 'utf8')) as { models: (Capture & { file: string })[] };
const wasm = fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm'));

function toneFor(preset: string) {
  const p = PRESETS.find((x) => x.name === preset)!;
  const capture = catalog.models.find((m) => m.file === p.capture)!;
  const file = CABS.find((c) => c.id === p.cab)?.file;
  const cabIR = file ? shapeCabIR(toMono(readWav(path.join(ROOT, 'public', file))), RATE)! : undefined;
  // No reverb on any tone.
  return { values: { ...p.values, reverb_bypass: 1, reverb_mix: 0 }, capture, cab: p.cab, cabIR };
}

const score = alpha.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(args[0]!)), new alpha.Settings());
const [t0, t1] = span(score, barFrom, barTo);
const seconds = t1 - t0 + 1.5;
const guitars = score.tracks.filter((t) => !t.staves[0]!.isPercussion && t.staves[0]!.tuning.length >= 6
  && t.playbackInfo.program >= 24 && t.playbackInfo.program <= 31);
console.log(`${score.artist} — ${score.title}: played bars ${timeline(score).bars.length}, ${guitars.length} guitar tracks, ${seconds.toFixed(1)} s from bar ${barFrom}`);
fs.mkdirSync(path.dirname(out), { recursive: true });

for (const [k, t] of guitars.entries()) {
  const clean = t.playbackInfo.program <= 28;
  const events = trackEvents(score, t.index, k + 1);
  const cut = events.events.filter((e) => e.start >= t0 - 0.01 && e.start < t1)
    .map((e) => ({ ...e, start: e.start - t0 + 0.25, end: Math.min(e.end, t1 + 1) - t0 + 0.25 }));
  if (cut.length === 0) { console.log(`  ${t.name}: silent here`); continue; }
  const started = performance.now();
  const audio = await renderTabTrack(bank, { index: t.index, track: { ...events, events: cut }, tone: toneFor(clean ? 'Clean' : 'Modern metal'), seed: k + 1 },
    wasm, new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/models', toneFor(clean ? 'Clean' : 'Modern metal').capture.file))), RATE, seconds);
  const peak = audio.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  console.log(`  ${t.name.trim() || `track ${t.index}`}: ${cut.length} notes, ${clean ? 'Clean' : 'Modern metal'}, ${((performance.now() - started) / 1000).toFixed(1)} s, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
  writeWav(`${out}-${t.index}.wav`, RATE, audio.right ? [audio.samples, audio.right] : [audio.samples]);
}
