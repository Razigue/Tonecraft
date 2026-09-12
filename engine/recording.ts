import type { Capture } from './catalog.ts';

export interface Recording { samples: Float32Array<ArrayBuffer>; sampleRate: number }
export interface RecordingTone { values: Record<string, number>; capture: Capture | null; cab: string }

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

/** Runs on a separate worker so exporting cannot freeze the rig or its audio. */
export function exportRecording(take: Recording, tone: RecordingTone | null, progress: (value: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
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
    worker.postMessage({ take: { samples, sampleRate: take.sampleRate }, tone, base: new URL(import.meta.env.BASE_URL, location.href).href }, [samples.buffer]);
  });
}
