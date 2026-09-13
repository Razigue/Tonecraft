/**
 * A fade in a tab silences its own note, not the rest of the track.
 *
 * Checked on the MIDI alphaTab itself generates, which is what its synthesizer
 * plays: every note-on is matched against the channel volume in force at that
 * moment.
 *
 * Usage:  npm run test:tab-fades
 */

import * as alpha from '@coderline/alphatab';

import { restoreFadedVolume } from './tab-fades.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** Note-ons, and those that start while their channel's volume is zero. */
function silentNotes(score: alpha.model.Score): { notes: number; silent: number } {
  const midi = new alpha.midi.MidiFile();
  new alpha.midi.MidiFileGenerator(score, new alpha.Settings(), new alpha.midi.AlphaSynthMidiFileHandler(midi)).generate();
  // Stable: at one tick, the generator writes a beat's automations before its notes.
  const events = midi.tracks.flatMap((t) => t.events).sort((a, b) => a.tick - b.tick);
  const volume = new Map<number, number>();
  let notes = 0, silent = 0;
  for (const e of events as unknown as { tick: number; channel: number; controller?: number; value?: number; constructor: { name: string } }[]) {
    if (e.controller === alpha.midi.ControllerType.VolumeCoarse) volume.set(e.channel, e.value!);
    else if (e.constructor.name === 'NoteOnEvent') {
      notes++;
      if (volume.get(e.channel) === 0) silent++;
    }
  }
  return { notes, silent };
}

const score = (): alpha.model.Score => {
  const importer = new alpha.importer.AlphaTexImporter();
  importer.initFromString('\\title "Fades" \\tempo 120 . \\track "Solo" '
    + ':4 0.6{fo} 2.6 3.6 5.6 | :4 7.6 8.6 r r | :4 r r r 5.5{vs} | :4 3.5 5.5 r r', new alpha.Settings());
  return importer.readScore();
};

{
  const before = silentNotes(score());
  // All but the first: the note carrying the fade still starts at full volume.
  check('as alphaTab plays it, every note after a fade is silent', before.silent === before.notes - 1,
    `${before.silent} of ${before.notes} notes at zero volume`);

  const fixed = score();
  const restored = restoreFadedVolume(fixed, alpha);
  const after = silentNotes(fixed);
  check('restored after the fade out and after the volume swell', restored === 2, `${restored} restored`);
  check('and no note plays at zero volume', after.silent === 0 && after.notes === before.notes,
    `${after.silent} of ${after.notes}`);

  const level = fixed.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[1]!.automations
    .find((a) => a.type === alpha.model.AutomationType.Volume);
  check('at the track\'s own volume, hidden from the notation',
    level?.value === fixed.tracks[0]!.playbackInfo.volume && level.isVisible === false, String(level?.value));
  check('a second pass adds nothing', restoreFadedVolume(fixed, alpha) === 0);
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
