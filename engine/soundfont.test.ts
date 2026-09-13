/**
 * The tab reader's soundfont, as alphaTab actually plays it.
 *
 * Everything that went wrong here still produced sound, or nothing that looked
 * like a bug: a console full of "Skipping load of unsupported sample", a tab
 * with a piano in it that played nothing at all, then a piano that played 45 dB
 * too quiet and muffled. Each is checked through alphaTab's own synthesizer,
 * rendering offline from the committed file — as it is on disk, which is the
 * bug, and prepared, which is what the reader loads.
 *
 * Usage:  npm run test:soundfont
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alpha from '@coderline/alphatab';

import { monoSoundFont, prepareSoundFont } from './soundfont.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'public/musescore-general/MuseScore_General.sf3');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** The smallest SoundFont the patch will walk: RIFF sfbk, a LIST pdta, one shdr. */
function tiny(types: readonly number[]): Uint8Array {
  const shdr = new Uint8Array((types.length + 1) * 46);   // plus the terminal EOS record
  const sv = new DataView(shdr.buffer);
  types.forEach((t, i) => sv.setUint16(i * 46 + 44, t, true));
  const chunk = (id: string, body: Uint8Array): Uint8Array => {
    const out = new Uint8Array(8 + body.length + (body.length & 1));
    out.set([...id].map((c) => c.charCodeAt(0)), 0);
    new DataView(out.buffer).setUint32(4, body.length, true);
    out.set(body, 8);
    return out;
  };
  const list = (kind: string, ...parts: Uint8Array[]): Uint8Array => {
    const body = new Uint8Array(4 + parts.reduce((n, p) => n + p.length, 0));
    body.set([...kind].map((c) => c.charCodeAt(0)), 0);
    let at = 4;
    for (const p of parts) { body.set(p, at); at += p.length; }
    return chunk('LIST', body);
  };
  const riff = chunk('RIFF', (() => {
    const pdta = list('pdta', chunk('phdr', new Uint8Array(38)), chunk('shdr', shdr));
    const info = list('INFO', chunk('ifil', new Uint8Array(4)));
    const body = new Uint8Array(4 + info.length + pdta.length);
    body.set([...'sfbk'].map((c) => c.charCodeAt(0)), 0);
    body.set(info, 4);
    body.set(pdta, 4 + info.length);
    return body;
  })());
  return riff;
}
const typesOf = (bytes: Uint8Array, count: number): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const at = bytes.length - (count + 1) * 46;
  return Array.from({ length: count }, (_, i) => view.getUint16(at + i * 46 + 44, true));
};

{
  // mono, mono+vorbis, right, left, linked, right+vorbis, left+vorbis, ROM mono
  const bytes = tiny([1, 17, 2, 4, 8, 18, 20, 0x8001]);
  const changed = monoSoundFont(bytes);
  check('stereo and linked halves become mono, the compression flag kept', changed === 5,
    `${changed} changed`);
  const after = typesOf(bytes, 8);
  check('and each lands on the type alphaTab loads', after.join(',') === '1,17,1,1,1,17,17,32769', after.join(','));
  check('a second pass changes nothing', monoSoundFont(bytes) === 0);
}

{
  let threw = false;
  try { monoSoundFont(new TextEncoder().encode('<html>404 Not Found</html>')); } catch { threw = true; }
  check('a page that is not a SoundFont is an error, not a silent reader', threw);
}

const disk = new Uint8Array(fs.readFileSync(FILE));
const prepared = disk.slice();
const monoOnly = disk.slice();
{
  const report = prepareSoundFont(prepared);
  check('the committed soundfont has its stereo samples retyped', report.retyped === 146, `${report.retyped} of them`);
  check('the pianos are the presets corrected, and only they',
    report.pianoPresets === 4 && report.pianoInstruments === 16,
    `${report.pianoPresets} presets, ${report.pianoInstruments} instruments`);
  check('and the file on disk is untouched', monoSoundFont(monoOnly) === 146 && prepareSoundFont(disk.slice()).retyped === 146);
}

/** MIDI for a score, with the track's instrument set where alphaTab reads it. */
function midiOf(score: alpha.model.Score, instruments: Record<number, number>): alpha.midi.MidiFile {
  // The importer has already written each track's instrument into its first
  // beat, so the program is set there too — otherwise the MIDI keeps the old one.
  for (const [track, program] of Object.entries(instruments)) {
    const t = score.tracks[Number(track)]!;
    t.playbackInfo.program = program;
    for (const bar of t.staves[0]!.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
      for (const a of beat.automations) if (a.type === alpha.model.AutomationType.Instrument) a.value = program;
    }
  }
  const midi = new alpha.midi.MidiFile();
  new alpha.midi.MidiFileGenerator(score, new alpha.Settings(), new alpha.midi.AlphaSynthMidiFileHandler(midi)).generate();
  return midi;
}

interface Render { samples: Float32Array; broken: number; warnings: number }

/**
 * Offline, through alphaTab's own synthesizer. `exportAudio` only reads `this`
 * when it is given no soundfont, so it is called without a live synthesizer:
 * there is no audio device in Node to give it.
 */
function render(soundFont: Uint8Array, midi: alpha.midi.MidiFile, seconds = 8): Render {
  const options = new alpha.synth.AudioExportOptions();
  options.soundFonts = [soundFont];
  options.sampleRate = 44100;
  options.masterVolume = 1;
  options.metronomeVolume = 0;
  const warn = console.warn;
  let warnings = 0;
  console.warn = (...args: unknown[]) => { if (String(args.join(' ')).includes('Skipping load of unsupported sample')) warnings++; };
  const parts: Float32Array[] = [];
  let broken = 0, total = 0;
  try {
    const exporter = alpha.synth.AlphaSynth.prototype.exportAudio.call(
      { synthesizer: { presets: [] } } as unknown as alpha.synth.AlphaSynth, options, midi, [], new Map());
    for (let chunk = exporter.render(500); chunk && total < seconds * 88200; chunk = exporter.render(500)) {
      for (const v of chunk.samples) if (!Number.isFinite(v)) broken++;
      parts.push(chunk.samples.slice());
      total += chunk.samples.length;
    }
  } finally {
    console.warn = warn;
  }
  const samples = new Float32Array(total);
  let at = 0;
  for (const p of parts) { samples.set(p, at); at += p.length; }
  return { samples, broken, warnings };
}

/** The loudest sample of a note's first 300 ms, in dBFS. */
function attack(r: Render): number {
  let peak = 0;
  for (let i = 0; i < Math.min(r.samples.length, 0.3 * 88200); i++) peak = Math.max(peak, Math.abs(r.samples[i]!));
  return 20 * Math.log10(peak + 1e-20);
}

/** One whole note on a guitar-tuned staff (`string.fret`), at a dynamic. */
function note(position: string, dynamic: string, program: number): alpha.midi.MidiFile {
  const importer = new alpha.importer.AlphaTexImporter();
  importer.initFromString(`\\title "Note" \\tempo 60 . \\track "Note" :1 ${position}{dy ${dynamic}} | :1 r`, new alpha.Settings());
  return midiOf(importer.readScore(), { 0: program });
}

{
  // The bug as the player first met it: a piano anywhere in the score, and not
  // a note of the whole tab came out — one empty piano voice turns alphaTab's
  // entire mix to NaN.
  const importer = new alpha.importer.AlphaTexImporter();
  importer.initFromString('\\title "Band" \\tempo 120 . '
    + '\\track "Guitar" :4 0.6 3.6 5.5 7.4 | :4 0.4 2.4 3.3 5.2 '
    + '\\track "Piano" :4 0.3 1.2 0.1 3.1 | :4 0.3 1.2 0.1 3.1', new alpha.Settings());
  const band = midiOf(importer.readScore(), { 1: 0 });
  const before = render(disk, band);
  check('as shipped, a score with a piano loads with warnings and plays nothing at all',
    before.warnings > 0 && before.broken === before.samples.length,
    `${before.warnings} warnings, ${before.broken} of ${before.samples.length} samples not a number`);
  const after = render(prepared, band);
  check('prepared, it loads without a single warning', after.warnings === 0, `${after.warnings} warnings`);
  check('and every sample of the output is a number', after.broken === 0, `${after.broken} non-finite`);
}

{
  // The piano's level, against the electric piano on the same notes. Across
  // the range, because the low and high halves are different instruments with
  // different filters, and a fix that only lifted one half would still be a
  // piano that disappears in the treble.
  const positions: [string, string][] = [['0.5', 'A2'], ['2.3', 'A3'], ['5.1', 'A4'], ['12.1', 'E5']];
  const gaps = positions.map(([p]) => attack(render(prepared, note(p, 'f', 2), 1)) - attack(render(prepared, note(p, 'f', 0), 1)));
  const shipped = attack(render(monoOnly, note('2.3', 'f', 0), 1)) - attack(render(monoOnly, note('2.3', 'f', 2), 1));
  check('a forte grand piano sits within 10 dB of the electric piano, low to high',
    gaps.every((g) => g > -3 && g < 10),
    positions.map(([, n], i) => `${n} ${gaps[i]!.toFixed(1)}`).join(', ') + ' dB below');
  check('where loaded but uncorrected it was 45 dB and more below', shipped < -40, `${shipped.toFixed(1)} dB`);

  const dynamics = ['ppp', 'p', 'mp', 'mf', 'f', 'fff'];
  const levels = dynamics.map((d) => attack(render(prepared, note('2.3', d, 0), 1)));
  check('and it plays louder the harder it is struck',
    levels.every((v, i) => i === 0 || v > levels[i - 1]!),
    dynamics.map((d, i) => `${d} ${levels[i]!.toFixed(1)}`).join(', '));

  // Scope: nothing but the pianos was touched.
  const guitar = render(monoOnly, note('2.3', 'f', 29), 1).samples;
  const same = render(prepared, note('2.3', 'f', 29), 1).samples;
  check('the other instruments render bit-identical', guitar.length === same.length && guitar.every((v, i) => v === same[i]));
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
