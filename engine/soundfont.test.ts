/**
 * The tab reader's soundfont, as alphaTab actually plays it.
 *
 * Everything that went wrong here still produced sound, or nothing that looked
 * like a bug: a console full of "Skipping load of unsupported sample", a tab
 * with a piano in it that played nothing at all, a piano 45 dB too quiet and
 * muffled, an instrument that was silence, synths with their filters shut.
 * Each is checked through alphaTab's own synthesizer, rendering offline from
 * the committed file — as it is on disk, which is the bug, and prepared, which
 * is what the reader loads.
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

/** The smallest SoundFont the retyping will walk: RIFF sfbk, a LIST pdta, one shdr. */
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
  let threw = 0;
  for (const f of [monoSoundFont, prepareSoundFont]) {
    try { f(new TextEncoder().encode('<html>404 Not Found</html>')); } catch { threw++; }
  }
  check('a page that is not a SoundFont is an error, not a silent reader', threw === 2);
}

const disk = new Uint8Array(fs.readFileSync(FILE));
/** What the reader loaded before the voicing was corrected: the stereo samples retyped, nothing else. */
const monoOnly = disk.slice();
monoSoundFont(monoOnly);
const report = prepareSoundFont(disk);
const prepared = report.bytes;
{
  check('the committed soundfont has its stereo samples retyped', report.retyped === 146, `${report.retyped} of them`);
  check('values alphaTab would count twice are corrected', report.summed > 0, `${report.summed} values`);
  check('filter modulation is written into generators', report.filters > 0,
    `${report.filters} zones, ${report.copies} instruments copied to follow a preset's key`);
  const fresh = fs.readFileSync(FILE);
  check('and the bytes given are left as they were', disk.length === fresh.length && disk.every((v, i) => v === fresh[i]));
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

/**
 * How much of a note's first half second is treble: the RMS of the left
 * channel's first difference over its RMS. A first difference rises 6 dB per
 * octave, so a filter that opens by octaves moves it by a large factor.
 */
function brightness(r: Render): number {
  let diff = 0, sum = 0;
  for (let i = 2; i < Math.min(r.samples.length, 0.5 * 88200); i += 2) {
    diff += (r.samples[i]! - r.samples[i - 2]!) ** 2;
    sum += r.samples[i]! ** 2;
  }
  return Math.sqrt(diff / (sum + 1e-30));
}

/** One whole note on a guitar-tuned staff (`string.fret`), at a dynamic. */
function note(position: string, dynamic: string, program: number): alpha.midi.MidiFile {
  const importer = new alpha.importer.AlphaTexImporter();
  importer.initFromString(`\\title "Note" \\tempo 60 . \\track "Note" :1 ${position}{dy ${dynamic}} | :1 r`, new alpha.Settings());
  return midiOf(importer.readScore(), { 0: program });
}
const A3 = '2.3', A4 = '5.1';
const level = (soundFont: Uint8Array, program: number, position = A3): number => attack(render(soundFont, note(position, 'f', program), 1));

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
  const positions: [string, string][] = [['0.5', 'A2'], [A3, 'A3'], [A4, 'A4'], ['12.1', 'E5']];
  const gaps = positions.map(([p]) => level(prepared, 2, p) - level(prepared, 0, p));
  const shipped = level(monoOnly, 0) - level(monoOnly, 2);
  check('a forte grand piano sits within 10 dB of the electric piano, low to high',
    gaps.every((g) => g > -3 && g < 10),
    positions.map(([, n], i) => `${n} ${gaps[i]!.toFixed(1)}`).join(', ') + ' dB below');
  check('where loaded but uncorrected it was 45 dB and more below', shipped < -40, `${shipped.toFixed(1)} dB`);

  const dynamics = ['ppp', 'p', 'mp', 'mf', 'f', 'fff'];
  const levels = dynamics.map((d) => attack(render(prepared, note(A3, d, 0), 1)));
  check('and it plays louder the harder it is struck',
    levels.every((v, i) => i === 0 || v > levels[i - 1]!),
    dynamics.map((d, i) => `${d} ${levels[i]!.toFixed(1)}`).join(', '));
}

{
  // Attenuation set in a global zone and again in a local one, which alphaTab
  // adds up. Each is measured against its own neighbour, before and after.
  const ice = [level(monoOnly, 96), level(prepared, 96)];
  check('Ice Rain, counted 100 dB down, is heard', ice[0]! < -200 && ice[1]! > -50,
    `${ice[0]!.toFixed(0)} dB, then ${ice[1]!.toFixed(1)}`);
  const bandoneon = [monoOnly, prepared].map((b) => level(b, 23) - level(b, 22));
  check('the bandoneon comes up to the harmonica beside it', bandoneon[0]! < -15 && Math.abs(bandoneon[1]!) < 8,
    `${bandoneon[0]!.toFixed(1)} dB, then ${bandoneon[1]!.toFixed(1)}`);
  const fm = [monoOnly, prepared].map((b) => level(b, 5, A3) - level(b, 5, A4));
  check('the FM electric piano no longer drops from A4 up', fm[0]! > 12 && Math.abs(fm[1]!) < 6,
    `A3 to A4 ${fm[0]!.toFixed(1)} dB, then ${fm[1]!.toFixed(1)}`);
}

{
  // Filters the soundfont opens with modulators, which alphaTab ignores.
  for (const [program, name] of [[90, 'polysynth'], [38, 'synth bass']] as const) {
    const [before, after] = [monoOnly, prepared].map((b) => brightness(render(b, note(A3, 'f', program), 1)));
    check(`the ${name}'s filter opens`, after! > 2 * before!, `treble ${before!.toFixed(3)}, then ${after!.toFixed(3)}`);
  }
}

{
  // Scope: an instrument neither correction reaches renders exactly as before.
  for (const [program, name] of [[29, 'overdrive guitar'], [27, 'clean guitar'], [34, 'picked bass']] as const) {
    const before = render(monoOnly, note(A3, 'f', program), 1).samples;
    const after = render(prepared, note(A3, 'f', program), 1).samples;
    check(`the ${name} renders bit-identical`, before.length === after.length && before.every((v, i) => v === after[i]));
  }
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
