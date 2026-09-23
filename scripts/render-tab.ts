/**
 * A tab rendered to a file, exactly as the reader plays it.
 *
 * Every guitar track through the sample bank and the chain, everything else
 * through alphaTab's synthesiser, mixed on one clock. The same modules the
 * page uses (`engine/tab-*.ts`, `engine/di-*.ts`), so what comes out here is
 * what comes out of the studio — which is how it stays checkable by ear.
 *
 *   npx tsx scripts/render-tab.ts <file.gp> [--bars 30-45] [--preset "Modern metal"]
 *                                [--clean Clean] [--out render.wav] [--only 0,1]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alpha from '@coderline/alphatab';

import { decodeBank, type Bank, type BankIndex } from '../engine/di-bank.ts';
import { renderTabTrack } from '../engine/tab-render.ts';
import { guitarTracks, scoreSeconds } from '../engine/tab-audio.ts';
import { trackEvents, span } from '../engine/tab-guitar.ts';
import { prepareSoundFont } from '../engine/soundfont.ts';
import { CABS, shapeCabIR } from '../engine/ir.ts';
import { PRESETS } from '../app/presets.ts';
import type { Capture } from '../engine/catalog.ts';
import type { RecordingTone } from '../engine/recording.ts';
import { readWav, toMono, writeWav } from '../render/wav.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 48000;
const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] ?? fallback : fallback;
};
const file = args[0];
if (!file) {
  console.error('Usage: npx tsx scripts/render-tab.ts <file.gp> [--bars 30-45] [--preset "Modern metal"] [--out render.wav]');
  process.exit(1);
}
const [barFrom, barTo] = opt('bars', '').split('-').map(Number);
const presetName = opt('preset', 'Modern metal');
const cleanName = opt('clean', 'Clean');
const out = opt('out', 'render.wav');
const only = opt('only', '') ? opt('only', '').split(',').map(Number) : null;

/** The bank, as the worker would have fetched it. */
function bank(): Bank {
  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/di-bank/bank.json'), 'utf8')) as BankIndex;
  const pcm = fs.readFileSync(path.join(ROOT, 'public/di-bank/bank.pcm'));
  return decodeBank(index, new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2));
}

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/index.json'), 'utf8')) as { models: (Capture & { file: string })[] };
function tone(name: string): RecordingTone {
  const preset = PRESETS.find((p) => p.name === name);
  if (!preset) throw new Error(`No preset called ${name}. Try: ${PRESETS.map((p) => p.name).join(', ')}`);
  const capture = catalog.models.find((m) => m.file === preset.capture) ?? catalog.models[0]!;
  const irFile = CABS.find((c) => c.id === preset.cab)?.file;
  const cabIR = irFile ? shapeCabIR(toMono(readWav(path.join(ROOT, 'public', irFile))), RATE) ?? undefined : undefined;
  return { values: { ...preset.values }, capture, cab: preset.cab, cabIR };
}

/** Everything that is not a guitar, from alphaTab, one track at a time so each keeps its own level. */
function band(score: alpha.model.Score, guitars: readonly number[], seconds: number, from: number): { left: Float32Array; right: Float32Array } | null {
  const others = score.tracks.map((t) => t.index).filter((i) => !guitars.includes(i));
  if (others.length === 0) return null;
  const midi = new alpha.midi.MidiFile();
  new alpha.midi.MidiFileGenerator(score, new alpha.Settings(), new alpha.midi.AlphaSynthMidiFileHandler(midi)).generate();
  const prepared = prepareSoundFont(new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/musescore-general/MuseScore_General.sf3'))));
  const options = new alpha.synth.AudioExportOptions();
  options.soundFonts = [prepared.bytes];
  options.sampleRate = RATE;
  options.masterVolume = 1;
  options.metronomeVolume = 0;
  for (const track of score.tracks) options.trackVolume.set(track.index, guitars.includes(track.index) ? 0 : 1);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const exporter = alpha.synth.AlphaSynth.prototype.exportAudio.call(
      { synthesizer: { presets: [] } } as unknown as alpha.synth.AlphaSynth, options, midi, [], new Map());
    const total = Math.ceil((from + seconds) * RATE);
    const left = new Float32Array(total), right = new Float32Array(total);
    let at = 0;
    for (let chunk = exporter.render(1000); chunk && at < total; chunk = exporter.render(1000)) {
      for (let i = 0; i + 1 < chunk.samples.length && at < total; i += 2, at++) {
        left[at] = chunk.samples[i]!;
        right[at] = chunk.samples[i + 1]!;
      }
    }
    return { left, right };
  } finally { console.warn = warn; }
}

const score = alpha.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(file)), new alpha.Settings());
const whole = scoreSeconds(score);
const [t0, t1] = Number.isFinite(barFrom!) ? span(score, barFrom!, barTo ?? barFrom!) : [0, whole];
const seconds = t1 - t0 + 1.5;
const lead = 0.25;
const guitars = guitarTracks(score).filter((g) => !only || only.includes(g.index));
console.log(`${score.artist} — ${score.title}: ${seconds.toFixed(1)} s, ${guitars.length} guitar tracks of ${score.tracks.length}`);
if (guitars.length === 0) throw new Error('No guitar track in this tab.');

const loaded = bank();
const loud = tone(presetName), quiet = tone(cleanName);
const model = new Map<string, Uint8Array<ArrayBuffer>>();
const modelFor = (t: RecordingTone): Uint8Array<ArrayBuffer> => {
  const name = t.capture!.file;
  let bytes = model.get(name);
  if (!bytes) { bytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/models', name))); model.set(name, bytes); }
  return bytes;
};

const length = Math.ceil((seconds + lead + 2) * RATE);
const left = new Float32Array(length), right = new Float32Array(length);
for (const [k, guitar] of guitars.entries()) {
  const events = trackEvents(score, guitar.index, k + 1);
  const cut = events.events.filter((e) => e.start >= t0 - 0.01 && e.start < t1)
    .map((e) => ({ ...e, start: e.start - t0 + lead, end: Math.min(e.end, t1 + 1) - t0 + lead }));
  if (cut.length === 0) { console.log(`  ${guitar.name || `track ${guitar.index}`}: silent here`); continue; }
  const voice = guitar.clean ? quiet : loud;
  const started = performance.now();
  const audio = await renderTabTrack(loaded, { index: guitar.index, track: { ...events, events: cut }, tone: voice, seed: k + 1 },
    fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm')), modelFor(voice), RATE, seconds + lead);
  // Two guitars go to the sides, as they are recorded; everything else is centred.
  const pan = guitars.length > 1 && k < 2 ? (k === 0 ? -0.8 : 0.8) : 0;
  const gl = Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
  const ear = audio.right ?? audio.samples;
  for (let i = 0; i < audio.samples.length && i < length; i++) {
    left[i]! += audio.samples[i]! * gl;
    right[i]! += ear[i]! * gr;
  }
  console.log(`  ${guitar.name || `track ${guitar.index}`}: ${cut.length} notes, ${guitar.clean ? cleanName : presetName}, ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

const rest = band(score, guitars.map((g) => g.index), seconds, t0);
if (rest) {
  // The band is mixed a little under the guitars, where a band sits.
  const gain = Math.pow(10, -3 / 20);
  const from = Math.round(t0 * RATE);
  for (let i = 0; i < length; i++) {
    const at = from + i - Math.round(lead * RATE);
    if (at < 0 || at >= rest.left.length) continue;
    left[i]! += rest.left[at]! * gain;
    right[i]! += rest.right[at]! * gain;
  }
  console.log(`  band: ${score.tracks.length - guitars.length} tracks through the soundfont`);
}

const peak = Math.max(...[left, right].map((c) => c.reduce((m, v) => Math.max(m, Math.abs(v)), 0)));
if (peak > 0.98) for (let i = 0; i < length; i++) { left[i]! *= 0.98 / peak; right[i]! *= 0.98 / peak; }
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
writeWav(out, RATE, [left, right]);
console.log(`wrote ${out}, peak ${(20 * Math.log10(peak)).toFixed(1)} dBFS`);
