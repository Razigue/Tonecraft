/**
 * A tab, read as a guitarist plays it: one event per string gesture.
 *
 * MIDI would lose what makes a guitar part sound like one — which string a
 * note is on, whether it is picked or hammered, palm muted, pinched. The tab
 * carries all of it, so the score model is walked directly rather than through
 * alphaTab's MIDI generator. What that generator is used for is the order of
 * play: `timeline()` takes its tick lookup, so repeats and alternate endings
 * are unrolled exactly as alphaTab's own player unrolls them, and a rendered
 * guitar lands on the same tick as the band rendered beside it.
 *
 * Nothing here makes a sound. It is the score as gestures; `di-sampler.ts`
 * plays them.
 */
import * as alpha from '@coderline/alphatab';

export type Attack = 'pick' | 'legato' | 'tap';

export interface PitchPoint { readonly t: number; readonly semis: number }

export interface NoteEvent {
  /** 0 is the lowest string. */
  readonly string: number;
  /** MIDI note of the open string. */
  readonly open: number;
  readonly fret: number;
  /** Seconds. */
  start: number;
  /** When the hand stops the string, in seconds. */
  end: number;
  /** 0..1. */
  velocity: number;
  readonly attack: Attack;
  /** Downstroke or upstroke, for the pick's colour. */
  readonly down: boolean;
  readonly palm: boolean;
  readonly dead: boolean;
  /** Harmonic number to ring (2 = octave), 0 when none. */
  readonly harmonic: number;
  readonly pinch: boolean;
  /** Pitch offsets relative to `fret`, in semitones, at seconds from `start`. Bends, slides, whammy. */
  readonly pitch: PitchPoint[];
  /** 0 none, 1 slight, 2 wide. */
  readonly vibrato: number;
  /** A slide off the note: the hand keeps moving and the note fades. */
  readonly slideOff: number;
}

export interface TrackEvents {
  readonly name: string;
  readonly strings: number[];
  readonly events: NoteEvent[];
}

const TICKS_PER_QUARTER = 960;
/** How long a note outlives the next attack: the damping hand is not faster than the picking one. */
const OVERLAP = 0.02;
/** How long a palm mute rings past its written end, if nothing stops it sooner. */
const PALM_RING = 0.12;

export interface Occurrence {
  /** The written bar. */
  readonly bar: alpha.model.MasterBar;
  /** Playback ticks: repeats and alternate endings unrolled, as alphaTab plays them. */
  readonly start: number;
  readonly end: number;
}

export interface Timeline {
  readonly bars: Occurrence[];
  /** Playback tick to seconds, through every tempo change. */
  time(tick: number): number;
}

/** The score in the order it is played: the same unrolling alphaTab's player (and the band render) uses. */
export function timeline(score: alpha.model.Score): Timeline {
  const cached = timelines.get(score);
  if (cached) return cached;
  const midi = new alpha.midi.MidiFile();
  const gen = new alpha.midi.MidiFileGenerator(score, new alpha.Settings(), new alpha.midi.AlphaSynthMidiFileHandler(midi));
  gen.generate();
  const bars = gen.tickLookup.masterBars.map((m) => ({ bar: m.masterBar, start: m.start, end: m.end }));
  const points: { tick: number; bpm: number }[] = [];
  for (const m of gen.tickLookup.masterBars) for (const c of m.tempoChanges) points.push({ tick: c.tick, bpm: c.tempo });
  points.sort((a, b) => a.tick - b.tick);
  if (points.length === 0 || points[0]!.tick > 0) points.unshift({ tick: 0, bpm: score.tempo });
  const secs: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    secs.push(secs[i - 1]! + (points[i]!.tick - points[i - 1]!.tick) / TICKS_PER_QUARTER * 60 / points[i - 1]!.bpm);
  }
  const time = (tick: number) => {
    let lo = 0, hi = points.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (points[mid]!.tick <= tick) lo = mid; else hi = mid - 1; }
    return secs[lo]! + (tick - points[lo]!.tick) / TICKS_PER_QUARTER * 60 / points[lo]!.bpm;
  };
  const t = { bars, time };
  timelines.set(score, t);
  return t;
}
const timelines = new WeakMap<alpha.model.Score, Timeline>();

/** Seconds at the start and end of a range of played bars (indices into `timeline().bars`). */
export function span(score: alpha.model.Score, from: number, to: number): [number, number] {
  const tl = timeline(score);
  const a = tl.bars[Math.max(0, from)]!, b = tl.bars[Math.min(tl.bars.length - 1, to)]!;
  return [tl.time(a.start), tl.time(b.end)];
}

/** Harmonic number from a Guitar Pro harmonic "fret" (12 → 2, 7 → 3, 5 → 4, 3.9 → 5...). */
function harmonicNumber(value: number): number {
  if (!(value > 0)) return 4;
  const p = 1 - Math.pow(2, -value / 12);
  return Math.max(2, Math.min(8, Math.round(1 / p)));
}

const DYNAMIC_VELOCITY = [0.25, 0.35, 0.45, 0.55, 0.65, 0.78, 0.9, 1.0];

/** A little of what a person does and a sequencer does not: never the same twice. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) / 4294967296); };
}

export function trackEvents(score: alpha.model.Score, trackIndex: number, seed = 1): TrackEvents {
  const track = score.tracks[trackIndex]!;
  const staff = track.staves[0]!;
  const tuning = [...staff.tuning].reverse().map((t) => t + staff.capo);
  const tl = timeline(score);
  const time = tl.time;
  const rand = rng(seed * 7919 + trackIndex);
  const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
  const events: NoteEvent[] = [];
  const byNote = new Map<alpha.model.Note, NoteEvent>();

  for (const occ of tl.bars) {
    const bar = staff.bars[occ.bar.index];
    if (!bar) continue;
    const barStart = occ.start;
    for (const voice of bar.voices) {
      for (const beat of voice.beats) {
        if (beat.isRest || beat.notes.length === 0) continue;
        // Where this pass through the bar puts the beat, repeats included.
        const startTick = occ.start + (beat.absolutePlaybackStart - occ.bar.start);
        const durTick = beat.playbackDuration;
        // Alternate picking follows the grid: downstrokes on the beat's own subdivision.
        const sub = Math.max(60, Math.min(durTick, TICKS_PER_QUARTER / 2));
        const autoDown = Math.round((startTick - barStart) / sub) % 2 === 0;
        const down = beat.pickStroke === alpha.model.PickStroke.Up ? false
          : beat.pickStroke === alpha.model.PickStroke.Down ? true : autoDown;
        const dynamic = DYNAMIC_VELOCITY[beat.dynamics] ?? 0.9;

        // Tremolo picking splits the beat into repeated strokes.
        const tremolo = beat.isTremolo && beat.tremoloSpeed !== null ? TICKS_PER_QUARTER * 4 / beat.tremoloSpeed : 0;
        const strokes = tremolo > 0 ? Math.max(1, Math.round(durTick / tremolo)) : 1;
        const strokeTicks = durTick / strokes;

        const notes = [...beat.notes].sort((a, b) => down ? a.string - b.string : b.string - a.string);
        // Up to a few ms per string: a pick crossing strings, not a keyboard chord.
        const strumPerString = notes.length > 1 ? 0.0025 + rand() * 0.0015 : 0;

        for (let k = 0; k < strokes; k++) {
          const t0 = time(startTick + k * strokeTicks);
          const t1 = time(startTick + (k + 1) * strokeTicks);
          const strokeDown = strokes > 1 ? k % 2 === 0 : down;
          notes.forEach((note, order) => {
            if (note.isTieDestination && note.tieOrigin) {
              const origin = byNote.get(note.tieOrigin);
              if (origin) { origin.end = t1; byNote.set(note, origin); return; }
            }
            const s = note.string - 1;
            const legato = k === 0 && (note.isHammerPullDestination
              || (note.slideOrigin !== null && note.slideOrigin.slideOutType === alpha.model.SlideOutType.Legato));
            const tapped = note.isLeftHandTapped || beat.tap;
            const attack: Attack = tapped ? 'tap' : legato ? 'legato' : 'pick';
            let velocity = dynamic * (note.isGhost ? 0.55 : 1) * (note.accentuated ? 1.15 : 1);
            if (!strokeDown && attack === 'pick') velocity *= 0.9;
            velocity = Math.min(1, velocity * (1 + 0.06 * gauss()));
            const jitter = attack === 'pick' ? 0.003 * gauss() : 0.002 * gauss();
            const start = Math.max(0, t0 + order * strumPerString + jitter);

            const noteLen = t1 - t0;
            const pitch: PitchPoint[] = [];
            if (note.hasBend && note.bendPoints) {
              for (const p of note.bendPoints) pitch.push({ t: p.offset / 60 * noteLen, semis: p.value / 2 });
            }
            if (beat.hasWhammyBar && beat.whammyBarPoints) {
              for (const p of beat.whammyBarPoints) pitch.push({ t: p.offset / 60 * noteLen, semis: p.value / 2 });
            }
            const slideType = note.slideOutType;
            if ((slideType === alpha.model.SlideOutType.Legato || slideType === alpha.model.SlideOutType.Shift) && note.slideTarget) {
              const target = note.slideTarget.fret - note.fret;
              const glide = Math.min(0.12, noteLen * 0.5);
              pitch.push({ t: noteLen - glide, semis: 0 }, { t: noteLen, semis: target });
            }
            let slideOff = 0;
            if (slideType === alpha.model.SlideOutType.OutDown) slideOff = -Math.min(note.fret, 9);
            if (slideType === alpha.model.SlideOutType.OutUp) slideOff = 7;

            // Written end for now; the phrasing pass below decides when the hand stops it.
            let end = t1;
            if (note.isStaccato) end = t0 + Math.max(0.06, noteLen * 0.5);
            // The palm never lifts: a mute rings, damped, until the next stroke.
            if (note.isPalmMute) end = t1 + PALM_RING;
            if (note.isLetRing) end = t1 + 4;

            const harmonics = note.harmonicType;
            const pinch = harmonics === alpha.model.HarmonicType.Pinch || harmonics === alpha.model.HarmonicType.Artificial;
            const harmonic = harmonics === alpha.model.HarmonicType.None ? 0
              : harmonics === alpha.model.HarmonicType.Natural ? harmonicNumber(note.fret || note.harmonicValue)
              : harmonicNumber(note.harmonicValue);

            const ev: NoteEvent = {
              string: s, open: tuning[s]!, fret: note.fret + (harmonics === alpha.model.HarmonicType.Natural ? -note.fret : 0),
              start, end: Math.max(end, start + 0.03), velocity, attack, down: strokeDown,
              palm: note.isPalmMute, dead: note.isDead, harmonic, pinch,
              pitch: pitch.sort((a, b) => a.t - b.t), vibrato: note.vibrato, slideOff,
            };
            events.push(ev);
            if (k === 0) byNote.set(note, ev);
          });
        }
      }
    }
  }

  events.sort((a, b) => a.start - b.start);
  // A player stops a note as the next one sounds, not before it: in a running
  // phrase, a note holds until just after the next attack on any string. After
  // a rest it stops at its written end.
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    let j = i + 1;
    while (j < events.length && events[j]!.start <= ev.start + 0.001) j++;
    const next = events[j];
    if (next && next.start <= ev.end + 0.05) ev.end = Math.max(ev.end, next.start + OVERLAP);
    else ev.end = Math.max(ev.end, ev.end + OVERLAP);
  }
  // One note per string: a new note on a string stops the one before it.
  const last: (NoteEvent | undefined)[] = [];
  for (const ev of events) {
    const prev = last[ev.string];
    if (prev && prev.end > ev.start) prev.end = ev.start;
    last[ev.string] = ev;
  }
  return { name: track.name, strings: tuning, events };
}

export function loadScore(bytes: Uint8Array): alpha.model.Score {
  return alpha.importer.ScoreLoader.loadScoreFromBytes(bytes, new alpha.Settings());
}

/** How long the score lasts, in seconds, repeats included. */
export function scoreSeconds(score: alpha.model.Score): number {
  const tl = timeline(score);
  return tl.time(tl.bars[tl.bars.length - 1]!.end);
}
