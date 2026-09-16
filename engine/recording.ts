import type { Capture } from './catalog.ts';

export interface Recording {
  samples: Float32Array<ArrayBuffer>;
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

/** IEEE float WAV: preserves the DI samples exactly, with no gain or clipping. */
export function encodeWav(take: Recording): ArrayBuffer {
  const { samples, sampleRate } = take;
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000 || !samples.length) {
    throw new Error('Invalid recording.');
  }
  const bytes = new ArrayBuffer(56 + samples.length * 4);
  const view = new DataView(bytes);
  const tag = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE');
  tag(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 3, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 32, true);
  tag(36, 'fact'); view.setUint32(40, 4, true); view.setUint32(44, samples.length, true);
  tag(48, 'data'); view.setUint32(52, samples.length * 4, true);
  for (let i = 0; i < samples.length; i++) {
    if (!Number.isFinite(samples[i])) throw new Error('The recording contains invalid samples.');
    view.setFloat32(56 + i * 4, samples[i]!, true);
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
}

export const laneShift = (t: Timeline, lane: GuitarLane): number => (t.backing || lane.overdub ? lane.latencyFrames : 0);

/** How long each lane is on the timeline, in frames. */
export function laneFrames(t: Timeline): { guitars: number[]; backing: number } {
  return {
    guitars: t.guitars.map((g) => Math.max(0, g.samples.length - laneShift(t, g))),
    backing: t.backing?.length ?? 0,
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
    const n = Math.min(out.length, b.length - from);
    for (let i = 0; i < n; i++) out[i]! += b[from + i]! * level;
  }
  return out;
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
  backingLevel?: number;
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
