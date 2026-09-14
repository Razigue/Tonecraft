/**
 * The tab editor's model: what a player writes, before alphaTab reads it.
 *
 * A track is written as a run of beats, and its bars are what that run falls
 * into at 4/4: a beat that does not fit what is left of a bar starts the next
 * one, and the gap it leaves is filled with rests, the way Guitar Pro closes a
 * bar. Nothing here knows alphaTab. `toAlphaTex` writes the text its importer
 * reads, so a tab being written is laid out, played, lit on the neck and
 * exported by the same reader as a file opened from disk.
 *
 * Strings count as alphaTab counts them — 1 is the lowest — and a tuning lists
 * MIDI notes highest string first, as alphaTab's staves hold them. Every edit
 * returns a new tab; none changes the one it is given.
 */

export type Duration = 1 | 2 | 4 | 8 | 16 | 32;
/** Longest first. */
export const DURATIONS: readonly Duration[] = [1, 2, 4, 8, 16, 32];

export interface EditNote { readonly string: number; readonly fret: number }
/** A beat with no notes is a rest. */
export interface EditBeat { readonly duration: Duration; readonly dotted: boolean; readonly notes: readonly EditNote[] }
export interface EditTrack { readonly name: string; readonly tuning: readonly number[]; readonly beats: readonly EditBeat[] }
export interface TimeSignature { readonly numerator: number; readonly denominator: 2 | 4 | 8 }
export interface EditTab { readonly tempo: number; readonly signature: TimeSignature; readonly tracks: readonly EditTrack[] }
export interface Cursor { readonly track: number; readonly beat: number; readonly string: number }

export interface TuningPreset { readonly name: string; readonly notes: readonly number[] }
/** By string count; the first of each is the one a new track or a new count starts on. */
export const TUNINGS: Readonly<Record<number, readonly TuningPreset[]>> = {
  4: [
    { name: 'Bass E standard', notes: [43, 38, 33, 28] },
    { name: 'Bass drop D', notes: [43, 38, 33, 26] },
    { name: 'Bass D standard', notes: [41, 36, 31, 26] },
  ],
  5: [
    { name: 'Bass B standard', notes: [43, 38, 33, 28, 23] },
    { name: 'Bass drop A', notes: [43, 38, 33, 28, 21] },
  ],
  6: [
    { name: 'E standard', notes: [64, 59, 55, 50, 45, 40] },
    { name: 'Drop D', notes: [64, 59, 55, 50, 45, 38] },
    { name: 'E♭ standard', notes: [63, 58, 54, 49, 44, 39] },
    { name: 'D standard', notes: [62, 57, 53, 48, 43, 38] },
    { name: 'Drop C', notes: [62, 57, 53, 48, 43, 36] },
    { name: 'C standard', notes: [60, 55, 51, 46, 41, 36] },
  ],
  7: [
    { name: 'B standard', notes: [64, 59, 55, 50, 45, 40, 35] },
    { name: 'Drop A', notes: [64, 59, 55, 50, 45, 40, 33] },
  ],
  8: [
    { name: 'F♯ standard', notes: [64, 59, 55, 50, 45, 40, 35, 30] },
    { name: 'Drop E', notes: [64, 59, 55, 50, 45, 40, 35, 28] },
  ],
};
export const STRING_COUNTS: readonly number[] = [4, 5, 6, 7, 8];

/** The time signatures offered; 4/4 is the one a new tab starts in. */
export const SIGNATURES: readonly TimeSignature[] = [
  { numerator: 2, denominator: 4 }, { numerator: 3, denominator: 4 }, { numerator: 4, denominator: 4 },
  { numerator: 5, denominator: 4 }, { numerator: 6, denominator: 8 }, { numerator: 7, denominator: 8 },
  { numerator: 12, denominator: 8 },
];
const FOUR_FOUR = SIGNATURES[2]!;

/** The highest fret a digit can reach. */
export const MAX_FRET = 30;
/** Two digits typed this close together on one string are one fret: 1 then 2 is 12. */
export const DIGIT_WINDOW_MS = 1000;
const WHOLE = 3840;
const MIN_TEMPO = 30;
const MAX_TEMPO = 300;

export const beatTicks = (beat: Pick<EditBeat, 'duration' | 'dotted'>): number => (WHOLE / beat.duration) * (beat.dotted ? 1.5 : 1);
/** How long a bar is, in the same ticks. */
export const barTicks = (signature: TimeSignature): number => (WHOLE * signature.numerator) / signature.denominator;
const rest = (duration: Duration, dotted = false): EditBeat => ({ duration, dotted, notes: [] });

export function newTrack(strings = 6, name = strings <= 5 ? 'Bass' : 'Guitar'): EditTrack {
  return { name, tuning: (TUNINGS[strings] ?? TUNINGS[6]!)[0]!.notes, beats: [rest(4)] };
}
export function emptyTab(tempo = 120): EditTab {
  return { tempo, signature: FOUR_FOUR, tracks: [newTrack()] };
}

/** Rests that fill `ticks`, longest first. */
function restsFor(ticks: number): EditBeat[] {
  const out: EditBeat[] = [];
  for (const d of DURATIONS) {
    const t = WHOLE / d;
    while (ticks >= t) { out.push(rest(d)); ticks -= t; }
  }
  return out;
}

export interface Laid {
  readonly bars: readonly (readonly EditBeat[])[];
  /** For each beat written: its bar, and its index among that bar's beats. */
  readonly at: readonly (readonly [number, number])[];
}

/** The bars a run of beats falls into, `bar` ticks each (4/4 by default), rests closing each one. */
export function layout(beats: readonly EditBeat[], bar = WHOLE): Laid {
  const bars: EditBeat[][] = [[]];
  const at: [number, number][] = [];
  let used = 0;
  for (const beat of beats) {
    const ticks = beatTicks(beat);
    if (used > 0 && used + ticks > bar) {
      bars[bars.length - 1]!.push(...restsFor(bar - used));
      bars.push([]);
      used = 0;
    }
    const current = bars[bars.length - 1]!;
    at.push([bars.length - 1, current.length]);
    current.push(beat);
    used += ticks;
    if (used >= bar) { bars.push([]); used = 0; }
  }
  const last = bars[bars.length - 1]!;
  if (used > 0) last.push(...restsFor(bar - used));
  else if (last.length === 0) {
    if (bars.length > 1) bars.pop();
    else last.push(...restsFor(bar));
  }
  return { bars, at };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = (midi: number): string => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

/** General MIDI programs: a clean electric guitar, and a fingered bass for four or five strings. */
const programFor = (strings: number): number => (strings <= 5 ? 33 : 27);

function beatTex(beat: EditBeat, strings: number): string {
  const duration = `${beat.duration}${beat.dotted ? '{d}' : ''}`;
  if (beat.notes.length === 0) return `r.${duration}`;
  // alphaTex counts strings from the highest.
  const notes = [...beat.notes].sort((a, b) => b.string - a.string).map((n) => `${n.fret}.${strings - n.string + 1}`);
  return notes.length === 1 ? `${notes[0]}.${duration}` : `(${notes.join(' ')}).${duration}`;
}

/** The tab as alphaTex, every track padded to the same number of bars. */
export function toAlphaTex(tab: EditTab): string {
  const ticks = barTicks(tab.signature);
  const laid = tab.tracks.map((t) => layout(t.beats, ticks));
  const barCount = Math.max(...laid.map((l) => l.bars.length));
  const parts = [`\\title "Untitled" \\tempo ${tab.tempo} .`];
  const { numerator, denominator } = tab.signature;
  tab.tracks.forEach((track, i) => {
    const bars = laid[i]!.bars.map((bar) => bar.map((b) => beatTex(b, track.tuning.length)).join(' '));
    const silent = restsFor(ticks).map((b) => beatTex(b, track.tuning.length)).join(' ');
    while (bars.length < barCount) bars.push(silent);
    const name = track.name.replace(/["\\]/g, '');
    parts.push(`\\track "${name}" \\tuning ${track.tuning.map(noteName).join(' ')} \\instrument ${programFor(track.tuning.length)} ${i === 0 ? `\\ts ${numerator} ${denominator} ` : ''}${bars.join(' | ')}`);
  });
  return parts.join(' ');
}

// --------------------------------------------------------------------------
// Edits

const clampBeat = (tab: EditTab, cursor: Cursor): Cursor => {
  const track = Math.max(0, Math.min(tab.tracks.length - 1, cursor.track));
  const t = tab.tracks[track]!;
  return {
    track,
    beat: Math.max(0, Math.min(t.beats.length - 1, cursor.beat)),
    string: Math.max(1, Math.min(t.tuning.length, cursor.string)),
  };
};

function mapBeat(tab: EditTab, cursor: Cursor, change: (beat: EditBeat) => EditBeat): EditTab {
  const c = clampBeat(tab, cursor);
  return {
    ...tab,
    tracks: tab.tracks.map((t, i) => (i !== c.track ? t : { ...t, beats: t.beats.map((b, j) => (j === c.beat ? change(b) : b)) })),
  };
}

export function setFret(tab: EditTab, cursor: Cursor, fret: number): EditTab {
  const f = Math.max(0, Math.min(MAX_FRET, Math.round(fret)));
  return mapBeat(tab, cursor, (b) => ({ ...b, notes: [...b.notes.filter((n) => n.string !== cursor.string), { string: cursor.string, fret: f }] }));
}

export function clearString(tab: EditTab, cursor: Cursor): EditTab {
  return mapBeat(tab, cursor, (b) => ({ ...b, notes: b.notes.filter((n) => n.string !== cursor.string) }));
}

export function makeRest(tab: EditTab, cursor: Cursor): EditTab {
  return mapBeat(tab, cursor, (b) => ({ ...b, notes: [] }));
}

/**
 * A beat never outlasts its bar: a dot that would not fit is dropped (a dotted
 * whole in 4/4), and a duration that would not fit even undotted is refused
 * (a whole note in 3/4).
 */
export function setDuration(tab: EditTab, cursor: Cursor, duration: Duration): EditTab {
  const bar = barTicks(tab.signature);
  return mapBeat(tab, cursor, (b) => {
    if (beatTicks({ duration, dotted: false }) > bar) return b;
    return { ...b, duration, dotted: b.dotted && beatTicks({ duration, dotted: true }) <= bar };
  });
}

/** One step longer (-1) or shorter (+1) along `DURATIONS`. */
export function nudgeDuration(tab: EditTab, cursor: Cursor, shorter: boolean): EditTab {
  const beat = tab.tracks[cursor.track]?.beats[cursor.beat];
  if (!beat) return tab;
  const index = DURATIONS.indexOf(beat.duration) + (shorter ? 1 : -1);
  const next = DURATIONS[Math.max(0, Math.min(DURATIONS.length - 1, index))]!;
  return setDuration(tab, cursor, next);
}

export function toggleDotted(tab: EditTab, cursor: Cursor): EditTab {
  const bar = barTicks(tab.signature);
  return mapBeat(tab, cursor, (b) => (b.dotted ? { ...b, dotted: false } : beatTicks({ ...b, dotted: true }) <= bar ? { ...b, dotted: true } : b));
}

/** Another time signature; a beat longer than the new bar is shortened to the longest that fits. */
export function setSignature(tab: EditTab, numerator: number, denominator: number): EditTab {
  const signature = SIGNATURES.find((s) => s.numerator === numerator && s.denominator === denominator);
  if (!signature) return tab;
  const bar = barTicks(signature);
  const fit = (b: EditBeat): EditBeat => {
    if (beatTicks(b) <= bar) return b;
    if (beatTicks({ ...b, dotted: false }) <= bar) return { ...b, dotted: false };
    return { ...b, duration: DURATIONS.find((d) => WHOLE / d <= bar)!, dotted: false };
  };
  return { ...tab, signature, tracks: tab.tracks.map((t) => ({ ...t, beats: t.beats.map(fit) })) };
}

/**
 * The next or previous beat. Past the last beat, a beat with notes gets a new
 * one after it, at its own duration, as writing goes on; a rest does not, so
 * holding the arrow never writes a row of rests.
 */
export function stepBeat(tab: EditTab, cursor: Cursor, direction: 1 | -1): { tab: EditTab; cursor: Cursor } {
  const c = clampBeat(tab, cursor);
  const track = tab.tracks[c.track]!;
  if (direction < 0) return { tab, cursor: { ...c, beat: Math.max(0, c.beat - 1) } };
  if (c.beat < track.beats.length - 1) return { tab, cursor: { ...c, beat: c.beat + 1 } };
  const current = track.beats[c.beat]!;
  if (current.notes.length === 0) return { tab, cursor: c };
  const grown: EditTab = {
    ...tab,
    tracks: tab.tracks.map((t, i) => (i !== c.track ? t : { ...t, beats: [...t.beats, rest(current.duration, current.dotted)] })),
  };
  return { tab: grown, cursor: { ...c, beat: c.beat + 1 } };
}

/** Up is +1: the next higher string. */
export function stepString(tab: EditTab, cursor: Cursor, direction: 1 | -1): Cursor {
  return clampBeat(tab, { ...cursor, string: cursor.string + direction });
}

/** Removes the beat at the cursor; a track always keeps one. */
export function deleteBeat(tab: EditTab, cursor: Cursor): { tab: EditTab; cursor: Cursor } {
  const c = clampBeat(tab, cursor);
  const track = tab.tracks[c.track]!;
  if (track.beats.length === 1) return { tab: makeRest(tab, c), cursor: c };
  const next: EditTab = { ...tab, tracks: tab.tracks.map((t, i) => (i !== c.track ? t : { ...t, beats: t.beats.filter((_, j) => j !== c.beat) })) };
  return { tab: next, cursor: clampBeat(next, c) };
}

export interface PendingDigit { readonly key: string; readonly value: number; readonly at: number }

/**
 * A digit from the number row or the keypad. Two digits on the same beat and
 * string within `DIGIT_WINDOW_MS` make one fret, when it exists: 1 then 2 is
 * 12, but 3 then 5 is 5, as no guitar has a 35th fret.
 */
export function typeDigit(tab: EditTab, cursor: Cursor, digit: number, pending: PendingDigit | null, now: number): { tab: EditTab; pending: PendingDigit } {
  const c = clampBeat(tab, cursor);
  const key = `${c.track}:${c.beat}:${c.string}`;
  const joined = pending !== null && pending.key === key && now - pending.at < DIGIT_WINDOW_MS && pending.value * 10 + digit <= MAX_FRET && pending.value > 0
    ? pending.value * 10 + digit : digit;
  return { tab: setFret(tab, c, joined), pending: { key, value: joined, at: now } };
}

export function setTempo(tab: EditTab, bpm: number): EditTab {
  return Number.isFinite(bpm) ? { ...tab, tempo: Math.max(MIN_TEMPO, Math.min(MAX_TEMPO, Math.round(bpm))) } : tab;
}

export function addTrack(tab: EditTab, strings = 6): EditTab {
  const same = tab.tracks.filter((t) => (t.tuning.length <= 5) === (strings <= 5)).length;
  const base = strings <= 5 ? 'Bass' : 'Guitar';
  return { ...tab, tracks: [...tab.tracks, newTrack(strings, same > 0 ? `${base} ${same + 1}` : base)] };
}

export function removeTrack(tab: EditTab, index: number): EditTab {
  return tab.tracks.length <= 1 ? tab : { ...tab, tracks: tab.tracks.filter((_, i) => i !== index) };
}

/** A tuning of the same string count; the frets written stay where they are. */
export function setTuning(tab: EditTab, index: number, notes: readonly number[]): EditTab {
  const track = tab.tracks[index];
  if (!track || notes.length !== track.tuning.length) return tab;
  return { ...tab, tracks: tab.tracks.map((t, i) => (i === index ? { ...t, tuning: [...notes] } : t)) };
}

/**
 * Another string count, on its standard tuning. Strings are added or taken
 * away at the low end, as a seventh string is, so every note written keeps its
 * string from the top; notes on a string that no longer exists are dropped.
 */
export function setStrings(tab: EditTab, index: number, count: number): EditTab {
  const track = tab.tracks[index];
  const preset = TUNINGS[count]?.[0];
  if (!track || !preset || count === track.tuning.length) return tab;
  const shift = count - track.tuning.length;
  const beats = track.beats.map((b) => ({
    ...b,
    notes: b.notes.map((n) => ({ ...n, string: n.string + shift })).filter((n) => n.string >= 1 && n.string <= count),
  }));
  return { ...tab, tracks: tab.tracks.map((t, i) => (i === index ? { ...t, tuning: preset.notes, beats } : t)) };
}

/**
 * A tab read back from storage, or null: what the browser kept may come from
 * an older version of this model, and a draft that does not fit it is dropped
 * rather than handed to the editor half-valid.
 */
export function readTab(value: unknown): EditTab | null {
  const v = value as Partial<EditTab> | null;
  if (!v || typeof v.tempo !== 'number' || !Array.isArray(v.tracks) || v.tracks.length === 0) return null;
  const tracks: EditTrack[] = [];
  for (const t of v.tracks as Partial<EditTrack>[]) {
    const tuning = t?.tuning;
    if (typeof t?.name !== 'string' || !Array.isArray(tuning) || !STRING_COUNTS.includes(tuning.length)
        || !tuning.every((n) => Number.isInteger(n) && n >= 0 && n <= 127) || !Array.isArray(t.beats) || t.beats.length === 0) return null;
    const beats: EditBeat[] = [];
    for (const b of t.beats as Partial<EditBeat>[]) {
      if (!b || !DURATIONS.includes(b.duration as Duration) || typeof b.dotted !== 'boolean' || !Array.isArray(b.notes)) return null;
      const notes = (b.notes as Partial<EditNote>[]).filter((n) => Number.isInteger(n?.string) && Number.isInteger(n?.fret)
        && n.string! >= 1 && n.string! <= tuning.length && n.fret! >= 0 && n.fret! <= MAX_FRET) as EditNote[];
      beats.push({ duration: b.duration!, dotted: b.duration === 1 ? false : b.dotted, notes });
    }
    tracks.push({ name: t.name, tuning: tuning as number[], beats });
  }
  // A draft from before time signatures is in 4/4.
  const signature = (v as { signature?: Partial<TimeSignature> }).signature;
  const tab = setTempo({ tempo: 120, signature: FOUR_FOUR, tracks }, v.tempo);
  if (signature === undefined) return tab;
  const read = setSignature(tab, Number(signature.numerator), Number(signature.denominator));
  return read === tab && !(signature.numerator === 4 && signature.denominator === 4) ? null : read;
}

/** The pitch a note sounds, in MIDI: its string's tuning plus the fret. */
export const pitchOf = (track: EditTrack, note: EditNote): number => track.tuning[track.tuning.length - note.string]! + note.fret;
