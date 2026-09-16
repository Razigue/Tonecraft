import type { Capture } from './catalog.ts';

export interface Recording {
  samples: Float32Array<ArrayBuffer>;
  sampleRate: number;
  /** The round trip it was recorded with, in frames: how late the guitar reached the DI behind a backing track it was played to. */
  latencyFrames?: number;
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

/** What an export contains: the guitar and the backing track together, or either alone. */
export type ExportContent = 'mix' | 'guitar' | 'backing';

/**
 * A take and its backing track on one timeline. The backing track started at
 * 0 with the recorder; the guitar played to it reached the DI a round trip
 * later, so on the timeline it is moved that much earlier and sounds as it was
 * played. Without a backing track there is nothing to line up with, and the
 * guitar stays where it was recorded.
 */
export interface Timeline {
  guitar: Float32Array | null;
  backing: Float32Array | null;
  /** Each lane's level in the mix, 0 to 1. */
  guitarLevel: number;
  backingLevel: number;
  latencyFrames: number;
}

const shift = (t: Timeline): number => (t.backing ? t.latencyFrames : 0);

/** How long each lane is on the timeline, in frames. */
export function laneFrames(t: Timeline): { guitar: number; backing: number } {
  return { guitar: t.guitar ? Math.max(0, t.guitar.length - shift(t)) : 0, backing: t.backing?.length ?? 0 };
}

/** Without a selection: from the first sample to the end of the longer of the lanes exported. */
export function defaultRange(t: Timeline, content: ExportContent): [number, number] {
  const lanes = laneFrames(t);
  const guitar = content === 'backing' ? 0 : lanes.guitar;
  const backing = content === 'guitar' ? 0 : lanes.backing;
  return [0, Math.max(guitar, backing)];
}

/** The frames of `range` (default: `defaultRange`) of what `content` names, summed. */
export function mixTimeline(t: Timeline, content: ExportContent, range?: readonly [number, number]): Float32Array<ArrayBuffer> {
  const [start, end] = range ?? defaultRange(t, content);
  const from = Math.max(0, Math.floor(start));
  const out = new Float32Array(Math.max(0, Math.floor(end) - from));
  if (content !== 'backing' && t.guitar) {
    const g = t.guitar, offset = from + shift(t), level = t.guitarLevel;
    const n = Math.min(out.length, g.length - offset);
    for (let i = Math.max(0, -offset); i < n; i++) out[i]! += g[offset + i]! * level;
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
  backing?: Float32Array<ArrayBuffer> | null;
  guitarLevel?: number;
  backingLevel?: number;
  /** Frames on the timeline; the default range when absent. */
  range?: readonly [number, number];
}

/** Runs on a separate worker so exporting cannot freeze the rig or its audio. */
export function exportRecording(take: Recording, tone: RecordingTone | null, progress: (value: number) => void, signal?: AbortSignal, options: ExportOptions = {}): Promise<ArrayBuffer> {
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
    const samples = take.samples.slice();
    const backing = options.backing ? options.backing.slice() : null;
    worker.postMessage({
      take: { samples, sampleRate: take.sampleRate, latencyFrames: take.latencyFrames ?? 0 }, tone,
      options: { ...options, backing }, base: new URL(import.meta.env.BASE_URL, location.href).href,
    }, backing ? [samples.buffer, backing.buffer] : [samples.buffer]);
  });
}
