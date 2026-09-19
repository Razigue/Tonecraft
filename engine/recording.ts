import type { Capture } from './catalog.ts';

export interface Recording {
  samples: Float32Array<ArrayBuffer>;
  /** The right ear, when it differs from `samples`: a render with the doubler on. A DI never has one. */
  right?: Float32Array<ArrayBuffer>;
  sampleRate: number;
  /** The round trip it was recorded with, in frames: how late the guitar reached the DI behind a backing track it was played to. */
  latencyFrames?: number;
  /** Recorded while other guitar tracks played back. */
  overdub?: boolean;
}
export interface RecordingTone {
  values: Record<string, number>;
  capture: Capture | null;
  cab: string;
  /** Bumped each time the player loads another cabinet IR, so a render of the old one is not reused. */
  cabRevision?: number;
  /** The cabinet as the chain had it, at the take's rate. Required for a loaded IR, which a worker cannot synthesise. */
  cabIR?: Float32Array<ArrayBuffer>;
}

/** Reload only our own float WAV; retaining its native rate avoids resampling DI. */
export async function decodeRecording(file: Blob): Promise<Recording> {
  const bytes = await file.arrayBuffer();
  const view = new DataView(bytes);
  if (bytes.byteLength <= 56 || (bytes.byteLength - 56) % 4 !== 0
    || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645
    || view.getUint32(48) !== 0x64617461 || view.getUint16(20, true) !== 3 || view.getUint16(22, true) !== 1
    || view.getUint16(34, true) !== 32 || view.getUint32(52, true) !== bytes.byteLength - 56
    || view.getUint32(24, true) < 8000 || view.getUint32(24, true) > 384000) throw new Error('Invalid saved take.');
  const samples = new Float32Array((bytes.byteLength - 56) / 4);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getFloat32(56 + i * 4, true);
    if (!Number.isFinite(samples[i])) throw new Error('Invalid saved take.');
  }
  return { samples, sampleRate: view.getUint32(24, true) };
}

/** IEEE float WAV: preserves the DI samples exactly, with no gain or clipping. Stereo when the take has a right ear. */
export function encodeWav(take: Recording): ArrayBuffer {
  const { samples, sampleRate, right } = take;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000 || !samples.length
    || (right !== undefined && right.length !== samples.length)) {
    throw new Error('Invalid recording.');
  }
  const channels = right === undefined ? 1 : 2;
  const frameBytes = 4 * channels;
  const bytes = new ArrayBuffer(56 + samples.length * frameBytes);
  const view = new DataView(bytes);
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, channels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * frameBytes, true); view.setUint16(32, frameBytes, true); view.setUint16(34, 32, true);
  tag(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, samples.length, true);
  tag(48, 'data'); view.setUint32(52, samples.length * frameBytes, true);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i]) || (right !== undefined && !Number.isFinite(right[i]))) {
      throw new Error('The recording contains invalid samples.');
    }
    view.setFloat32(56 + i * frameBytes, samples[i]!, true);
    if (right !== undefined) view.setFloat32(60 + i * frameBytes, right[i]!, true);
  }
  return bytes;
}

/** What an export contains: the guitars and the backing track together, or either alone. */
export type ExportContent = 'mix' | 'guitar' | 'backing';

/** One guitar track on the timeline. An empty one has no samples. */
export interface GuitarLane {
  samples: Float32Array;
  /** Its level in the mix, 0 to 1. */
  level: number;
  /** How late the guitar reached the DI behind what the player heard, in frames. */
  latencyFrames: number;
  /** Recorded while other guitar tracks played: it lines up with them even with no backing track. */
  overdub?: boolean;
  /**
   * How far later the player has since moved this track, in frames, never
   * negative: a track is placed against the others by dragging one of them
   * later, so nothing is ever dragged off the front of the timeline and lost.
   * The alignment above is where the track sits before anyone touches it.
   */
  offsetFrames?: number;
}

/**
 * Guitar tracks and a backing track on one timeline. The backing track and
 * any track played back during a take start at 0 with the recorder; the
 * guitar played to them reached the DI a round trip later, so on the timeline
 * it is moved that much earlier and sounds as it was played. A track recorded
 * with nothing to hear stays where it was recorded, unless a backing track
 * gives it something to line up with.
 *
 * Where a track sits never depends on the other guitar tracks, only on its own
 * take and the backing track: what a player hears during an overdub is the
 * same timeline the export is cut from.
 */
export interface Timeline {
  guitars: readonly GuitarLane[];
  backing: Float32Array | null;
  backingLevel: number;
  /** How far later the player has moved the backing track, in frames, never negative. */
  backingOffset?: number;
}

/**
 * How many frames of a take sit before the timeline's origin: the round trip it
 * was recorded a beat late by, less however far the player has moved it since.
 * Negative means the track starts that many frames into the timeline.
 */
export const laneShift = (t: Timeline, lane: GuitarLane): number =>
  (t.backing || lane.overdub ? lane.latencyFrames : 0) - (lane.offsetFrames ?? 0);

/** How long each lane is on the timeline, in frames — where it ends, not how much audio it holds. */
export function laneFrames(t: Timeline): { guitars: number[]; backing: number } {
  return {
    guitars: t.guitars.map((g) => Math.max(0, g.samples.length - laneShift(t, g))),
    backing: t.backing === null ? 0 : t.backing.length + (t.backingOffset ?? 0),
  };
}

/** The guitar tracks an export takes: every one, or one alone. */
const chosen = (t: Timeline, only?: number): number[] =>
  t.guitars.map((_, i) => i).filter((i) => only === undefined || i === only);

/** Without a selection: from the first sample to the end of the longest of the lanes exported. */
export function defaultRange(t: Timeline, content: ExportContent, only?: number): [number, number] {
  const lanes = laneFrames(t);
  const guitar = content === 'backing' ? 0 : Math.max(0, ...chosen(t, only).map((i) => lanes.guitars[i]!));
  const backing = content === 'guitar' ? 0 : lanes.backing;
  return [0, Math.max(guitar, backing)];
}

/** The frames of `range` (default: `defaultRange`) of what `content` names, summed. */
export function mixTimeline(t: Timeline, content: ExportContent, range?: readonly [number, number], only?: number): Float32Array<ArrayBuffer> {
  const [start, end] = range ?? defaultRange(t, content, only);
  const from = Math.max(0, Math.floor(start));
  const out = new Float32Array(Math.max(0, Math.floor(end) - from));
  if (content !== 'backing') {
    for (const index of chosen(t, only)) {
      const lane = t.guitars[index]!;
      const g = lane.samples, offset = from + laneShift(t, lane), level = lane.level;
      const n = Math.min(out.length, g.length - offset);
      for (let i = Math.max(0, -offset); i < n; i++) out[i]! += g[offset + i]! * level;
    }
  }
  if (content !== 'guitar' && t.backing) {
    const b = t.backing, level = t.backingLevel;
    // The same arithmetic as a guitar lane: a moved track reads from before its
    // own first sample, and those frames are silence, not the head of the file.
    const offset = from - (t.backingOffset ?? 0);
    const n = Math.min(out.length, b.length - offset);
    for (let i = Math.max(0, -offset); i < n; i++) out[i]! += b[offset + i]! * level;
  }
  return out;
}

/** What a cut leaves: each lane's audio and where it now starts. */
export interface Cut {
  guitars: { samples: Float32Array<ArrayBuffer>; offsetFrames: number }[];
  backing: Float32Array<ArrayBuffer> | null;
  backingOffset: number;
}

/** Where a lane's first sample sits on the timeline, in frames; the guitars can be negative. */
const laneStart = (shift: number): number => -shift;

/**
 * One span removed from every lane at once, the rest closing up behind it.
 *
 * Across every lane, not only the one under the pointer: the selection is a
 * span of the timeline — it is what an export is cut to — and taking it out of
 * one track alone would move that track against the others by exactly the
 * amount removed. A take and the song it was played to would no longer line up,
 * which is the one thing the timeline exists to hold.
 *
 * A lane that begins after the cut moves earlier by however much of the cut fell
 * before it, so the silence in front of it shortens with everything else.
 */
export function cutTimeline(t: Timeline, range: readonly [number, number]): Cut {
  const from = Math.max(0, Math.floor(range[0])), to = Math.max(from, Math.floor(range[1]));
  const take = (samples: Float32Array | null, start: number): { samples: Float32Array<ArrayBuffer> | null; start: number } => {
    if (samples === null) return { samples: null, start };
    // In the lane's own frames, clamped to the audio it actually has.
    const a = Math.max(0, Math.min(samples.length, from - start));
    const b = Math.max(a, Math.min(samples.length, to - start));
    const out = new Float32Array(samples.length - (b - a));
    out.set(samples.subarray(0, a));
    out.set(samples.subarray(b), a);
    // Whatever of the cut fell in front of this lane pulls it earlier.
    return { samples: out, start: start - Math.max(0, Math.min(to, start) - from) };
  };
  const guitars = t.guitars.map((lane) => {
    const cut = take(lane.samples, laneStart(laneShift(t, lane)));
    // The alignment is not a move and is not undone by one: what the take owes
    // the round trip stays, and only the player's own offset can reach zero.
    const aligned = (t.backing || lane.overdub ? lane.latencyFrames : 0);
    return { samples: cut.samples ?? new Float32Array(0), offsetFrames: Math.max(0, cut.start + aligned) };
  });
  const backing = take(t.backing, t.backingOffset ?? 0);
  return { guitars, backing: backing.samples, backingOffset: Math.max(0, backing.start) };
}

/** A backing file as the chain plays it: at the take's rate, its two channels averaged. */
export async function decodeBacking(file: Blob, sampleRate: number): Promise<Float32Array<ArrayBuffer>> {
  const buffer = await new OfflineAudioContext(1, 1, sampleRate).decodeAudioData(await file.arrayBuffer());
  const out = new Float32Array(buffer.length);
  const channels = Math.min(2, buffer.numberOfChannels);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i]! += data[i]! / channels;
  }
  return out;
}

export interface ExportOptions {
  content?: ExportContent;
  /** One guitar track alone, by index; every one when absent. */
  only?: number;
  backing?: Float32Array<ArrayBuffer> | null;
  /** Per guitar track, by index; 1 when absent. */
  guitarLevels?: readonly number[];
  /** Where each guitar track has been moved to, by index, in frames; 0 when absent. */
  guitarOffsets?: readonly number[];
  backingLevel?: number;
  /** Where the backing track has been moved to, in frames. */
  backingOffset?: number;
  /** Frames on the timeline; the default range when absent. */
  range?: readonly [number, number];
}

/**
 * Runs on a separate worker so exporting cannot freeze the rig or its audio.
 * `takes` are the guitar tracks in order, an empty track as no samples.
 */
export function exportRecording(takes: readonly Recording[], sampleRate: number, tone: RecordingTone | null, progress: (value: number) => void, signal?: AbortSignal, options: ExportOptions = {}): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./recording-worker.ts', import.meta.url), { type: 'module' });
    const cleanup = () => { worker.terminate(); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { cleanup(); reject(new Error('Export cancelled.')); };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = e => {
      if (e.data.error) { cleanup(); reject(new Error(e.data.error)); }
      else if (e.data.wav) { cleanup(); resolve(e.data.wav); }
      else progress(e.data.progress);
    };
    worker.onerror = () => { cleanup(); reject(new Error('Audio export failed. Please try again.')); };
    const copies = takes.map((t) => ({ samples: t.samples.slice(), sampleRate: t.sampleRate, latencyFrames: t.latencyFrames ?? 0, overdub: t.overdub === true }));
    const backing = options.backing ? options.backing.slice() : null;
    worker.postMessage({
      takes: copies, sampleRate, tone,
      options: { ...options, backing }, base: new URL(import.meta.env.BASE_URL, location.href).href,
    }, [...copies.map((c) => c.samples.buffer), ...(backing ? [backing.buffer] : [])]);
  });
}
