/**
 * The scales and where they land. What breaks silently here is a wrong
 * interval — a scale one semitone off still lights a neck full of dots — so the
 * modes are checked as what they are, rotations of the major scale, rather
 * than against a second copy of the same table.
 *
 * Usage:  npm run test:scales
 */

import {
  KEYS, SCALES, NOTE_NAMES, scaleById, pitchClasses, scaleNoteNames, scaleOnNeck, keyOfSignature,
} from './scales.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const same = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

// E2 A2 D3 G3 B3 E4, highest first, as alphaTab lists a tuning.
const STANDARD = [64, 59, 55, 50, 45, 40];
const BASS = [43, 38, 33, 28];

check('every one of the twelve keys is offered, once',
  KEYS.length === 12 && same(KEYS.map((k) => k.root), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
check('scale ids are unique', new Set(SCALES.map((s) => s.id)).size === SCALES.length);
check('every scale starts on its root and climbs inside the octave',
  SCALES.every((s) => s.intervals[0] === 0 && s.intervals.every((v, i) => i === 0 || v > s.intervals[i - 1]!) && s.intervals.at(-1)! < 12));

const major = scaleById('major')!;
const rotate = (degree: number): number[] => {
  const from = major.intervals[degree]!;
  return [...major.intervals.slice(degree), ...major.intervals.slice(0, degree)].map((v) => (v - from + 12) % 12);
};
for (const [id, degree] of [['dorian', 1], ['phrygian', 2], ['lydian', 3], ['mixolydian', 4], ['natural-minor', 5], ['locrian', 6]] as const) {
  check(`${id} is the major scale from its ${degree + 1}th degree`, same(scaleById(id)!.intervals, rotate(degree)));
}
check('the harmonic minor is the natural minor with a raised seventh',
  same(scaleById('harmonic-minor')!.intervals, [0, 2, 3, 5, 7, 8, 11]));
const inMajor = new Set(major.intervals);
check('the major pentatonic is five notes of the major scale',
  scaleById('major-pentatonic')!.intervals.every((i) => inMajor.has(i)));
const inMinor = new Set(scaleById('natural-minor')!.intervals);
check('the minor pentatonic is five notes of the natural minor',
  scaleById('minor-pentatonic')!.intervals.every((i) => inMinor.has(i)));
check('the blues scale is the minor pentatonic and its flat fifth',
  same(scaleById('blues')!.intervals, [...scaleById('minor-pentatonic')!.intervals, 6].sort((a, b) => a - b)));

check('A minor is spelled A B C D E F G', scaleNoteNames(9, scaleById('natural-minor')!).join(' ') === 'A B C D E F G');
check('B♭ major wraps round the octave', same(pitchClasses(10, major), [10, 0, 2, 3, 5, 7, 9]));
check('names come from the neck\'s own spelling', NOTE_NAMES.length === 12 && NOTE_NAMES[1] === 'C♯');

{
  const notes = scaleOnNeck(STANDARD, 0, 4, scaleById('minor-pentatonic')!);
  const on = (string: number, fret: number): boolean => notes.some((n) => n.string === string && n.fret === fret);
  check('E minor pentatonic lights the open low E and its twelfth fret as roots',
    notes.some((n) => n.string === 1 && n.fret === 0 && n.root) && notes.some((n) => n.string === 1 && n.fret === 12 && n.root));
  check('and the first box, 0-3 on the low E', on(1, 0) && on(1, 3) && !on(1, 1) && !on(1, 2));
  check('and nothing outside it', notes.every((n) => [4, 7, 9, 11, 2].includes((STANDARD[6 - n.string]! + n.fret) % 12)));
  check('five notes of twelve, on 25 frets of six strings', notes.length > 55 && notes.length < 70, `${notes.length} positions`);
  check('no position past the 24th fret', notes.every((n) => n.fret <= 24));
}

{
  const notes = scaleOnNeck(BASS, 0, 9, scaleById('major')!);
  check('a four-string bass has four strings of positions', new Set(notes.map((n) => n.string)).size === 4);
}

{
  // Capo on 2: a note at "fret 0" sounds F♯ on the low E, which is where a
  // played note arrives in the same coordinates.
  const notes = scaleOnNeck(STANDARD, 2, 6, scaleById('major')!);
  check('frets are counted from the capo', notes.some((n) => n.string === 1 && n.fret === 0 && n.root));
  check('and stop at the 24th fret of the neck, not 24 past the capo', notes.every((n) => n.fret + 2 <= 24));
}

check('no sharps or flats is C major', keyOfSignature(0, false) === 0);
check('one sharp is G major, and E minor', keyOfSignature(1, false) === 7 && keyOfSignature(1, true) === 4);
check('three flats is E♭ major, and C minor', keyOfSignature(-3, false) === 3 && keyOfSignature(-3, true) === 0);
check('seven sharps is C♯ major', keyOfSignature(7, false) === 1);

console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
