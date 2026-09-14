/**
 * The tab editor's model, read back through alphaTab's own importer and
 * exported to Guitar Pro, which is how the reader will see what is written.
 *
 * Usage:  npm run test:tab-editor
 */

import * as alpha from '@coderline/alphatab';

import {
  addTrack, clearString, deleteBeat, emptyTab, layout, nudgeDuration, pitchOf, readTab, removeTrack, setDuration, setFret, setStrings,
  setTempo, stepBeat, stepString, toAlphaTex, toggleDotted, typeDigit, type Cursor, type EditTab,
} from './tab-editor.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const read = (tab: EditTab): alpha.model.Score => {
  const importer = new alpha.importer.AlphaTexImporter();
  importer.initFromString(toAlphaTex(tab), new alpha.Settings());
  return importer.readScore();
};
const beatsOf = (score: alpha.model.Score, track = 0) =>
  score.tracks[track]!.staves[0]!.bars.map((bar) => bar.voices[0]!.beats.map((b) => (b.isRest ? `r/${b.duration}` : `${b.notes.map((n) => `${n.fret}s${n.string}`).join('+')}/${b.duration}${b.dots ? '.' : ''}`)));

{
  const score = read(emptyTab());
  check('an empty tab is one bar of 4/4, one track in standard tuning, at 120 BPM',
    score.masterBars.length === 1 && score.tracks.length === 1 && score.tempo === 120
      && score.masterBars[0]!.timeSignatureNumerator === 4 && score.tracks[0]!.staves[0]!.tuning.join(',') === '64,59,55,50,45,40',
    `${score.masterBars.length} bar(s), ${score.tempo} BPM`);
}

{
  let tab = emptyTab();
  let cursor: Cursor = { track: 0, beat: 0, string: 1 };
  let typed = typeDigit(tab, cursor, 1, null, 0);
  typed = typeDigit(typed.tab, cursor, 2, typed.pending, 400);
  check('1 then 2 within a second is fret 12', typed.tab.tracks[0]!.beats[0]!.notes[0]!.fret === 12);
  const late = typeDigit(typed.tab, cursor, 3, typed.pending, 2000);
  check('a digit after the window starts a new fret', late.tab.tracks[0]!.beats[0]!.notes[0]!.fret === 3);
  const tooHigh = typeDigit(typeDigit(tab, cursor, 3, null, 0).tab, cursor, 5, { key: '0:0:1', value: 3, at: 0 }, 100);
  check('3 then 5 is 5: there is no fret 35', tooHigh.tab.tracks[0]!.beats[0]!.notes[0]!.fret === 5);

  // Writing on: a note, then the arrow right, again and again.
  tab = setFret(emptyTab(), cursor, 3);
  for (let i = 0; i < 4; i++) {
    const stepped = stepBeat(tab, cursor, 1);
    tab = setFret(stepped.tab, stepped.cursor, 5 + i);
    cursor = stepped.cursor;
  }
  const bars = beatsOf(read(tab));
  check('five quarter notes fill a bar and start the next, closed with rests',
    bars.length === 2 && bars[0]!.length === 4 && bars[1]![0] === '8s1/4' && bars[1]!.slice(1).join(' ') === 'r/2 r/4',
    JSON.stringify(bars));
  const still = stepBeat(stepBeat(emptyTab(), { track: 0, beat: 0, string: 1 }, 1).tab, { track: 0, beat: 0, string: 1 }, 1);
  check('the arrow right past a rest writes no new beat', still.tab.tracks[0]!.beats.length === 1);
}

{
  // A beat that does not fit what is left of the bar starts the next one.
  let tab = emptyTab();
  const c: Cursor = { track: 0, beat: 0, string: 6 };
  tab = setDuration(setFret(tab, c, 0), c, 2);
  tab = toggleDotted(tab, c);                                   // dotted half: three beats
  let s = stepBeat(tab, c, 1);
  // The new beat starts at the duration it follows, dotted half, as Guitar Pro does; made a plain half here.
  check('a new beat takes the duration it follows', s.tab.tracks[0]!.beats[1]!.duration === 2 && s.tab.tracks[0]!.beats[1]!.dotted);
  tab = toggleDotted(setDuration(setFret(s.tab, s.cursor, 2), s.cursor, 2), s.cursor);  // a half: does not fit the last beat
  const bars = beatsOf(read(tab));
  check('a half after a dotted half moves to the next bar, the gap a rest',
    bars.length === 2 && bars[0]!.join(' ') === '0s6/2. r/4' && bars[1]![0] === '2s6/2', JSON.stringify(bars));
  check('+ and − walk the durations', nudgeDuration(tab, c, true).tracks[0]!.beats[0]!.duration === 4
    && nudgeDuration(tab, c, false).tracks[0]!.beats[0]!.duration === 1);
  check('a whole note is never dotted', !toggleDotted(setDuration(tab, c, 1), c).tracks[0]!.beats[0]!.dotted);
  s = deleteBeat(tab, { track: 0, beat: 1, string: 6 });
  check('a beat can be deleted', s.tab.tracks[0]!.beats.length === 1);
  check('and a string cleared', clearString(tab, c).tracks[0]!.beats[0]!.notes.length === 0);
}

{
  // A chord, read back as alphaTab counts strings: 1 is the lowest.
  let tab = emptyTab();
  let c: Cursor = { track: 0, beat: 0, string: 1 };
  tab = setFret(tab, c, 3);
  c = stepString(tab, c, 1);
  tab = setFret(tab, c, 5);
  const beat = read(tab).tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
  check('a chord keeps each note on its string', beat.notes.map((n) => `${n.fret}s${n.string}`).sort().join(' ') === '3s1 5s2',
    beat.notes.map((n) => `${n.fret}s${n.string}`).join(' '));
  check('up never leaves the neck', stepString(tab, { track: 0, beat: 0, string: 6 }, 1).string === 6);

  const seven = setStrings(tab, 0, 7);
  const pitches = (t: EditTab) => t.tracks[0]!.beats[0]!.notes.map((n) => pitchOf(t.tracks[0]!, n)).sort().join(',');
  check('a seventh string keeps every note where it sounds', pitches(seven) === pitches(tab), `${pitches(tab)} → ${pitches(seven)}`);
  const imported = read(seven).tracks[0]!.staves[0]!;
  check('and alphaTab reads seven strings in B standard', imported.tuning.length === 7 && imported.tuning.at(-1) === 35);
  check('going back to four drops the notes on strings that no longer exist',
    setStrings(tab, 0, 4).tracks[0]!.beats[0]!.notes.length === 0);
}

{
  let tab = addTrack(setTempo(emptyTab(), 96), 4);
  tab = setFret(tab, { track: 0, beat: 0, string: 1 }, 7);
  for (let i = 0; i < 6; i++) tab = stepBeat(setFret(tab, { track: 0, beat: i, string: 1 }, i), { track: 0, beat: i, string: 1 }, 1).tab;
  const score = read(tab);
  check('a second track, a bass, padded to the same bars', score.tracks.length === 2 && score.tracks[1]!.staves[0]!.tuning.length === 4
    && score.tracks[1]!.staves[0]!.bars.length === score.tracks[0]!.staves[0]!.bars.length, `${score.tracks.map((t) => t.name).join(', ')}`);
  check('the tempo is written', score.tempo === 96);
  const removed = removeTrack(tab, 1);
  check('a track can be deleted, the others kept as written',
    removed.tracks.length === 1 && removed.tracks[0] === tab.tracks[0] && removeTrack(removed, 0) === removed);
  const { at } = layout(tab.tracks[0]!.beats);
  const mapped = at.every(([bar, index], i) => {
    const b = score.tracks[0]!.staves[0]!.bars[bar]!.voices[0]!.beats[index]!;
    const written = tab.tracks[0]!.beats[i]!;
    return written.notes.length === 0 ? b.isRest : b.notes[0]?.fret === written.notes[0]!.fret;
  });
  check('each beat written is found at the bar and index its layout says', mapped);

  const gp = new alpha.exporter.Gp7Exporter().export(score);
  const back = alpha.importer.ScoreLoader.loadScoreFromBytes(gp, new alpha.Settings());
  check('exported to Guitar Pro, it opens with the same tracks and notes',
    back.tracks.length === 2 && JSON.stringify(beatsOf(back)) === JSON.stringify(beatsOf(score)), `${gp.length} bytes`);
}

{
  const tab = setFret(addTrack(emptyTab(90), 4), { track: 0, beat: 0, string: 2 }, 7);
  const back = readTab(JSON.parse(JSON.stringify(tab)));
  check('a draft kept by the browser reads back as it was written', JSON.stringify(back) === JSON.stringify(tab));
  check('and one that does not fit the model is dropped',
    readTab({ tempo: 120, tracks: [{ name: 'x', tuning: [1, 2], beats: [] }] }) === null && readTab(null) === null && readTab('tab') === null);
}

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
