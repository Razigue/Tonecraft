/**
 * What the reader plays today: alphaTab's synthesizer and the corrected
 * MuseScore_General soundfont, offline. Also renders the band (bass, drums,
 * the rest) that the guitar renders are mixed against.
 *
 *   npx tsx poc/baseline.ts <file.gp> --tracks 0,1 --bars 30-45 --out poc/out/soundfont
 */
import fs from 'node:fs';
import * as alpha from '@coderline/alphatab';
import { prepareSoundFont } from '../engine/soundfont.ts';
import { loadScore, tempoMap } from './tab-events.ts';
import { writeWav } from '../render/wav.ts';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1]! : dflt; };
const tracks = opt('tracks', '0').split(',').map(Number);
const [barFrom, barTo] = opt('bars', '0-16').split('-').map(Number) as [number, number];
const out = opt('out', 'poc/out/soundfont');

export function renderAlphaTab(score: alpha.model.Score, keep: number[], barFrom: number, barTo: number, rate = 48000): [Float32Array, Float32Array] {
  const midi = new alpha.midi.MidiFile();
  new alpha.midi.MidiFileGenerator(score, new alpha.Settings(), new alpha.midi.AlphaSynthMidiFileHandler(midi)).generate();
  const prepared = prepareSoundFont(new Uint8Array(fs.readFileSync('public/musescore-general/MuseScore_General.sf3')));
  const options = new alpha.synth.AudioExportOptions();
  options.soundFonts = [(prepared as unknown as { bytes: Uint8Array }).bytes ?? (prepared as unknown as Uint8Array)];
  options.sampleRate = rate;
  options.masterVolume = 1;
  options.metronomeVolume = 0;
  for (const t of score.tracks) options.trackVolume.set(t.index, keep.includes(t.index) ? 1 : 0);
  const range = new alpha.synth.PlaybackRange();
  const mbA = score.masterBars[barFrom]!, mbB = score.masterBars[barTo]!;
  range.startTick = mbA.start; range.endTick = mbB.start + mbB.calculateDuration();
  options.playbackRange = range;
  const warn = console.warn; console.warn = () => {};
  const parts: Float32Array[] = []; let total = 0;
  try {
    const exporter = alpha.synth.AlphaSynth.prototype.exportAudio.call(
      { synthesizer: { presets: [] } } as unknown as alpha.synth.AlphaSynth, options, midi, [], new Map());
    for (let chunk = exporter.render(500); chunk; chunk = exporter.render(500)) { parts.push(chunk.samples.slice()); total += chunk.samples.length; }
  } finally { console.warn = warn; }
  const l = new Float32Array(total / 2), r = new Float32Array(total / 2);
  let at = 0;
  for (const p of parts) for (let i = 0; i < p.length; i += 2) { l[at] = p[i]!; r[at] = p[i + 1]!; at++; }
  return [l, r];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const score = loadScore(new Uint8Array(fs.readFileSync(args[0]!)));
  const [l, r] = renderAlphaTab(score, tracks, barFrom, barTo);
  // Same 250 ms of lead-in as the guitar renders, so the files line up.
  const pad = Math.round(0.25 * 48000);
  const L = new Float32Array(l.length + pad), R = new Float32Array(r.length + pad);
  L.set(l, pad); R.set(r, pad);
  writeWav(`${out}.wav`, 48000, [L, R]);
  console.log(`wrote ${out}.wav ${(L.length / 48000).toFixed(1)} s (expected ${(tempoMap(score)(score.masterBars[barTo]!.start + score.masterBars[barTo]!.calculateDuration()) - tempoMap(score)(score.masterBars[barFrom]!.start)).toFixed(1)} s)`);
}
