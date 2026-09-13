/**
 * The tab reader's soundfont, as alphaTab actually plays it.
 *
 * The failure this guards against had two faces: a console full of "Skipping
 * load of unsupported sample" warnings, and — the one that mattered — a tab
 * with a piano in it that played nothing at all, guitar included. Both are
 * checked here through alphaTab's own synthesizer, rendering a guitar and a
 * piano offline from the committed file: once as it is on disk, which is the
 * bug, and once patched, which is what the reader loads.
 *
 * Usage:  npm run test:soundfont
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alpha from '@coderline/alphatab';

import { monoSoundFont } from './soundfont.ts';

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
const patched = disk.slice();
{
  const changed = monoSoundFont(patched);
  check('the committed soundfont has its stereo samples retyped', changed === 146, `${changed} of them`);
  check('and the file on disk is untouched', !disk.every((v, i) => v === patched[i]) && monoSoundFont(disk.slice()) === 146);
}

/**
 * A two-track tab — a guitar and a piano — rendered by alphaTab's own
 * synthesizer. Returns how many output samples were not finite, the RMS of the
 * rest, and the warnings alphaTab logged while loading. `exportAudio` only
 * reads `this` when it is given no soundfont, so it is called without a live
 * synthesizer: there is no audio device in Node to give it.
 */
function renderBand(soundFont: Uint8Array): { broken: number; rms: number; warnings: number } {
  const importer = new alpha.importer.AlphaTexImporter();
  importer.initFromString('\\title "Band" \\tempo 120 . '
    + '\\track "Guitar" :4 0.6 3.6 5.5 7.4 | :4 0.4 2.4 3.3 5.2 '
    + '\\track "Piano" :4 0.3 1.2 0.1 3.1 | :4 0.3 1.2 0.1 3.1');
  const score = importer.readScore();
  // The importer has already written the instrument into the first beat, so
  // the program is set there too — otherwise the MIDI still says guitar.
  const piano = score.tracks[1]!;
  piano.playbackInfo.program = 0;   // acoustic grand piano
  for (const bar of piano.staves[0]!.bars) for (const voice of bar.voices) for (const beat of voice.beats) {
    for (const a of beat.automations) if (a.type === alpha.model.AutomationType.Instrument) a.value = 0;
  }
  const midi = new alpha.midi.MidiFile();
  new alpha.midi.MidiFileGenerator(score, new alpha.Settings(), new alpha.midi.AlphaSynthMidiFileHandler(midi)).generate();
  const programs = new Set(midi.tracks.flatMap((t) => t.events).filter((e) => e.type === 0xc0)
    .map((e) => (e as unknown as { program: number }).program));
  if (!programs.has(0)) throw new Error('the test score has no piano in it');

  const options = new alpha.synth.AudioExportOptions();
  options.soundFonts = [soundFont];
  options.sampleRate = 44100;
  options.masterVolume = 1;
  options.metronomeVolume = 0;

  const warn = console.warn;
  let warnings = 0;
  console.warn = (...args: unknown[]) => { if (String(args.join(' ')).includes('Skipping load of unsupported sample')) warnings++; };
  let broken = 0, sum = 0, n = 0;
  try {
    const exporter = alpha.synth.AlphaSynth.prototype.exportAudio.call(
      { synthesizer: { presets: [] } } as unknown as alpha.synth.AlphaSynth, options, midi, [], new Map());
    for (let chunk = exporter.render(500); chunk; chunk = exporter.render(500)) {
      for (const v of chunk.samples) {
        if (Number.isFinite(v)) { sum += v * v; n++; } else broken++;
      }
    }
  } finally {
    console.warn = warn;
  }
  return { broken, rms: Math.sqrt(sum / Math.max(1, n)), warnings };
}

{
  // The bug as the player met it: a piano anywhere in the score, and not a
  // note of the whole tab came out — one empty piano voice turns alphaTab's
  // entire mix to NaN.
  const before = renderBand(disk);
  check('as shipped, a score with a piano loads with warnings and plays nothing at all',
    before.warnings > 0 && before.broken > 0 && before.rms === 0,
    `${before.warnings} warnings, ${before.broken} non-finite samples`);
  const after = renderBand(patched);
  check('patched, it loads without a single warning', after.warnings === 0, `${after.warnings} warnings`);
  check('and every sample of the output is a number', after.broken === 0, `${after.broken} non-finite`);
  check('and the band is heard', after.rms > 1e-3, `rms ${after.rms.toExponential(1)}`);
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
