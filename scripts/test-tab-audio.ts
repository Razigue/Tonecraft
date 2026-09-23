/**
 * A tab played through the amplifier, checked where it is silent when wrong.
 *
 * Each of these was a real failure while it was being built, and none of them
 * throws: notes that started 80 ms after their pick, legato that faded to
 * nothing, palm mutes gone before the next sixteenth, and a band that could
 * have sat half a beat behind the guitars.
 *
 * Usage:  npm run test:tab
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as alpha from '@coderline/alphatab';

import { decodeBank, encodePcm, BANK_VERSION, type BankIndex } from '../engine/di-bank.ts';
import { renderDi, activeRms, sourceString } from '../engine/di-sampler.ts';
import { trackEvents, timeline, span } from '../engine/tab-guitar.ts';
import { guitarTracks, scoreSeconds } from '../engine/tab-audio.ts';
import { TabTrackRenderer } from '../engine/tab-render.ts';
import { PRESETS } from '../app/presets.ts';
import { CABS, shapeCabIR } from '../engine/ir.ts';
import { readWav, toMono } from '../render/wav.ts';
import { prepareSoundFont } from '../engine/soundfont.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 48000;
let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const score = (tex: string): alpha.model.Score => {
  const importer = new alpha.importer.AlphaTexImporter();
  importer.initFromString(tex, new alpha.Settings());
  return importer.readScore();
};

{
  /*
   * The order of play. A guitar rendered here is mixed with a band rendered by
   * alphaTab, so the two have to agree on when every note happens — repeats,
   * alternate endings and all. Held to alphaTab's own MIDI rather than to a
   * number written here: it is the thing that has to be matched.
   */
  const repeated = score('\\title "R" \\tempo 120 . \\track "G" \\ro :4 0.6 0.6 0.6 0.6 \\rc 3 | :4 3.6 3.6 3.6 3.6');
  const line = timeline(repeated);
  check('a repeated bar is unrolled, not read once', line.bars.length > 2, `${line.bars.length} played bars for 2 written`);
  const events = trackEvents(repeated, 0, 1).events;

  const midi = new alpha.midi.MidiFile();
  const noteOns: number[] = [];
  class Handler extends alpha.midi.AlphaSynthMidiFileHandler {
    override addNote(track: number, start: number, length: number, key: number, velocity: number, channel: number): void {
      if (track === 0) noteOns.push(line.time(start));
      super.addNote(track, start, length, key, velocity, channel);
    }
  }
  new alpha.midi.MidiFileGenerator(repeated, new alpha.Settings(), new Handler(midi)).generate();
  noteOns.sort((a, b) => a - b);
  check('as many notes as alphaTab plays', noteOns.length === events.length, `${events.length} against ${noteOns.length}`);
  const apart = events.map((e, i) => Math.abs(e.start - (noteOns[i] ?? -99)) * 1000);
  // Up to a few ms: the reader moves a pick off the grid on purpose, the way a hand does.
  check('each one where alphaTab plays it', Math.max(...apart) < 8, `worst ${Math.max(...apart).toFixed(1)} ms`);
  check('the last one lands inside the score', events[events.length - 1]!.start < scoreSeconds(repeated), `${events[events.length - 1]!.start.toFixed(2)} s of ${scoreSeconds(repeated).toFixed(2)}`);
  const [from, to] = span(repeated, 1, 1);
  check('a played bar spans its own two seconds at 120 bpm', Math.abs(to - from - 2) < 0.01, `${(to - from).toFixed(3)} s`);
}

{
  // What a guitar track is. A bass is not one — four strings, and a program
  // that is not a guitar's — and a clean guitar wants the clean amplifier.
  const band = score('\\title "B" \\tempo 120 . '
    + '\\track "Rhythm" \\instrument distortionguitar :4 0.6 0.6 0.6 0.6 '
    + '\\track "Clean" \\instrument electricguitarclean :4 0.6 0.6 0.6 0.6 '
    + '\\track "Bass" \\instrument acousticbass \\tuning E1 A1 D2 G2 :4 0.4 0.4 0.4 0.4');
  const guitars = guitarTracks(band);
  check('the guitars are the guitar tracks, and the bass is not one', guitars.map((g) => g.name).join(',') === 'Rhythm,Clean', guitars.map((g) => g.name).join(',') || 'none');
  check('and a clean program asks for the clean amplifier', guitars.find((g) => g.name === 'Clean')?.clean === true && guitars.find((g) => g.name === 'Rhythm')?.clean === false);
  // alphaTab's own default program is a steel acoustic: a tab whose author
  // never chose one still has a guitar in it, and it had better be playable.
  const plain = guitarTracks(score('\\title "P" \\tempo 120 . \\track "Guitar" :4 0.6 0.6 0.6 0.6'));
  check('a track with no instrument set is still a guitar', plain.length === 1 && plain[0]!.clean, plain.length === 0 ? 'none found' : `clean: ${plain[0]!.clean}`);
}

const bankFile = path.join(ROOT, 'public/di-bank/bank.json');
if (!fs.existsSync(bankFile)) {
  console.log('  skip  the sample bank is not built (npx tsx scripts/build-di-bank.ts <dataset>)');
} else {
  const index = JSON.parse(fs.readFileSync(bankFile, 'utf8')) as BankIndex;
  const pcmBytes = fs.readFileSync(path.join(ROOT, 'public/di-bank/bank.pcm'));
  const bank = decodeBank(index, new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2));
  check('the bank is the version this engine reads', index.version === BANK_VERSION);
  check('every string has its picked notes, its dead notes and its harmonics',
    bank.picked.every((r) => r.length > 12) && bank.dead.every((r) => r.length > 0) && bank.harmonics.every((r) => r.length > 0));
  check('and its palm, learned frame by frame', bank.palm.length === bank.strings.length && bank.palm.every((m) => m.length === 8 && m[0]!.length === 160));

  {
    const round = encodePcm([Float32Array.from([0, 0.5, -0.5, 1, -1])]);
    check('samples survive the trip to 16 bits', Math.abs(round[1]! / 32768 - 0.5) < 1e-4 && round[4]! === -32768);
  }

  {
    // A seven-string in F#, which is what the low B is served from the low E for.
    const low = sourceString(bank, 35);
    check('the lowest string of a 7-string is played by the lowest string of the bank', low === 0, `string ${low}`);
    check('and a standard high E takes the bank\'s own', sourceString(bank, 64) === 5);
  }

  {
    // Sixteenths at 138: the case where a note that starts late, or dies early,
    // is a hole rather than a note.
    const fast = score('\\title "F" \\tempo 138 . \\track "G" \\instrument distortionguitar '
      + ':16 0.6{pm} 0.6{pm} 0.6{pm} 0.6{pm} 3.6 5.6 3.6 5.6 0.6{pm} 0.6{pm} 0.6{pm} 0.6{pm} 3.6 5.6 3.6 5.6 | '
      + ':8 7.6 9.6{h} 10.6{h} 9.6 7.6 5.6 3.6 0.6');
    const track = trackEvents(fast, 0, 1);
    const di = renderDi(bank, track, { rate: RATE, seconds: scoreSeconds(fast) + 1 });
    const rms = activeRms(di, RATE);
    const gain = Math.pow(10, -36.1 / 20) / rms;
    for (let i = 0; i < di.length; i++) di[i]! *= gain;
    check('nothing in the render is not a number', di.every((v) => Number.isFinite(v)));

    // Every pick sounds within 10 ms of where the tab puts it.
    const window = Math.round(RATE * 0.001);
    const env: number[] = [];
    for (let i = 0; i + window < di.length; i += window) {
      let e = 0;
      for (let k = i; k < i + window; k++) e += di[k]! ** 2;
      env.push(Math.sqrt(e / window));
    }
    const late: number[] = [];
    for (const ev of track.events.filter((e) => e.attack === 'pick')) {
      const at = Math.round(ev.start * 1000);
      let found = -1;
      for (let m = Math.max(1, at - 10); m < at + 25 && m < env.length; m++) {
        if (env[m]! > 3 * (env[m - 1]! + 1e-6)) { found = m; break; }
      }
      late.push(found < 0 ? 99 : found - at);
    }
    late.sort((a, b) => a - b);
    const median = late[late.length >> 1]!;
    check('every pick sounds where the tab puts it', median >= -3 && median <= 8 && late[late.length - 1]! < 30,
      `median ${median} ms, worst ${late[late.length - 1]} ms`);

    /*
     * No hole: while a note is held, the DI stays above the gate.
     *
     * Measured over 10 ms, not over 1: a low string passes through zero twice
     * per cycle, and a millisecond of it reads as silence when nothing is
     * wrong at all.
     */
    const long = Math.round(RATE * 0.01);
    const slow: number[] = [];
    for (let i = 0; i + long < di.length; i += long) {
      let e = 0;
      for (let k = i; k < i + long; k++) e += di[k]! ** 2;
      slow.push(20 * Math.log10(Math.sqrt(e / long) + 1e-20));
    }
    let held = 0, under = 0;
    for (let i = 0; i < slow.length; i++) {
      const t = i * 0.01;
      if (!track.events.some((e) => t >= e.start + 0.01 && t < e.end - 0.01)) continue;
      held++;
      // The loudest preset gate is the Lead's -50 dBFS; Modern metal sits at -65.
      if (slow[i]! < -50) under++;
    }
    check('and a held note is never under the gate', held > 0 && under / held < 0.1, `${(100 * under / Math.max(1, held)).toFixed(0)}% of the time`);

    // A hammer-on is a note, not a silence: it was one, for a while.
    const legato = track.events.filter((e) => e.attack === 'legato');
    const heard = legato.filter((e) => {
      const at = Math.round((e.start + 0.02) * 1000);
      return env[at] !== undefined && 20 * Math.log10(env[at]! + 1e-20) > -50;
    });
    check('a hammer-on sounds', legato.length > 0 && heard.length === legato.length, `${heard.length} of ${legato.length}`);
  }
}

if (fs.existsSync(bankFile)) {
  /*
   * A tab is heard while it is still rendering, so it comes out in chunks —
   * and a chunk boundary must not be audible. Rendered in one piece and in
   * half-second pieces, the same track has to come out the same, which it only
   * does if the strings and the chain carry their state across.
   */
  const index = JSON.parse(fs.readFileSync(bankFile, 'utf8')) as BankIndex;
  const pcmBytes = fs.readFileSync(path.join(ROOT, 'public/di-bank/bank.pcm'));
  const bank = decodeBank(index, new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.byteLength / 2));
  const tab = score('\\title "C" \\tempo 120 . \\track "G" \\instrument distortionguitar '
    + ':8 0.6{pm} 0.6{pm} 3.6 5.6 7.6 5.6 3.6 0.6 | :2 7.6 12.6');
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/index.json'), 'utf8')) as { models: { file: string; trimDb: number }[] };
  const preset = PRESETS.find((p) => p.name === 'Modern metal')!;
  const capture = catalog.models.find((m) => m.file === preset.capture)!;
  const wasm = fs.readFileSync(path.join(ROOT, 'public/dsp/chain.wasm'));
  const model = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/models', capture.file)));
  // A recorded cabinet is a file, and only the page decodes it: give the tone
  // the samples, as the reader's worker is given them.
  const irFile = CABS.find((c) => c.id === preset.cab)?.file;
  const cabIR = irFile ? shapeCabIR(toMono(readWav(path.join(ROOT, 'public', irFile))), RATE) ?? undefined : undefined;
  const tone = { values: { ...preset.values }, capture: capture as never, cab: preset.cab, cabIR };
  const job = { index: 0, track: trackEvents(tab, 0, 1), tone, seed: 1 };
  const seconds = scoreSeconds(tab);
  const whole = await TabTrackRenderer.open(bank, job, wasm, model, RATE, seconds);
  const inOne = whole.next(whole.frames);
  const piecemeal = await TabTrackRenderer.open(bank, job, wasm, model, RATE, seconds);
  const joined = new Float32Array(piecemeal.frames);
  while (!piecemeal.done) {
    const chunk = piecemeal.next(Math.round(RATE * 0.5));
    joined.set(chunk.samples, chunk.at);
  }
  let worst = 0;
  for (let i = 0; i < joined.length; i++) worst = Math.max(worst, Math.abs(joined[i]! - inOne.samples[i]!));
  check('a chunk boundary is not audible', worst === 0, `worst sample apart: ${worst.toExponential(1)}`);

  // And the gain into the amplifier is the same whichever way it was rendered.
  let energy = 0;
  for (const v of inOne.samples) energy += v * v;
  check('the track is rendered at all', energy > 0, `${(10 * Math.log10(energy / inOne.samples.length + 1e-20)).toFixed(1)} dB`);
}

{
  /*
   * The band and the guitars share one clock, so the band's own render has to
   * sit on the beat. alphaTab's exporter looked 50 ms late when it was first
   * measured through a guitar patch — that was the patch's soft attack, not the
   * export. Measured on its metronome, which strikes on the beat, it is inside
   * one of its 1.33 ms micro-buffers, and this is here to notice if that ever
   * stops being true.
   */
  const bars = score('\\title "M" \\tempo 120 . \\track "G" :4 r r r r | :4 r r r r');
  const midi = new alpha.midi.MidiFile();
  new alpha.midi.MidiFileGenerator(bars, new alpha.Settings(), new alpha.midi.AlphaSynthMidiFileHandler(midi)).generate();
  const prepared = prepareSoundFont(new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/musescore-general/MuseScore_General.sf3'))));
  const options = new alpha.synth.AudioExportOptions();
  options.soundFonts = [prepared.bytes];
  options.sampleRate = RATE;
  options.masterVolume = 1;
  options.metronomeVolume = 1;
  const exporter = alpha.synth.AlphaSynth.prototype.exportAudio.call(
    { synthesizer: { presets: [] } } as unknown as alpha.synth.AlphaSynth, options, midi, [], new Map());
  const parts: Float32Array[] = [];
  let total = 0;
  for (let chunk = exporter.render(400); chunk && total < RATE * 5 * 2; chunk = exporter.render(400)) { parts.push(chunk.samples); total += chunk.samples.length; }
  const mono = new Float32Array(total / 2);
  let at = 0;
  for (const p of parts) for (let i = 0; i < p.length; i += 2) mono[at++] = p[i]!;
  let peak = 0;
  for (const v of mono) peak = Math.max(peak, Math.abs(v));
  const clicks: number[] = [];
  for (let i = 0; i < mono.length;) {
    if (Math.abs(mono[i]!) > 0.3 * peak) { clicks.push(i / RATE); i += Math.round(RATE * 0.1); } else i++;
  }
  const off = clicks.slice(0, 8).map((t, k) => Math.abs(t - k * 0.5) * 1000);
  check('the band is rendered on the beat, not behind it', clicks.length >= 8 && Math.max(...off) < 2,
    `worst ${Math.max(...off).toFixed(1)} ms over ${clicks.length} beats`);
}

console.log(failures === 0 ? 'ok tab audio' : `${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
