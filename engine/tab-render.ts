/**
 * One track of a tab, from its notes to the sound of an amplifier.
 *
 * The guitar is made here (`di-sampler.ts`) and then played through the same
 * offline render an exported take goes through (`render-recording.ts`), which
 * is the same `chain.wasm` the studio plays live. Nothing about the tab
 * reaches the chain while it is playing: a tab is rendered before it is heard,
 * the way `AD-6` requires a build-time render to use the live settings.
 */
import type { Bank } from './di-bank.ts';
import { renderDi, activeRms, TARGET_RMS_DB } from './di-sampler.ts';
import type { TrackEvents } from './tab-guitar.ts';
import { renderRecording } from './render-recording.ts';
import type { RecordingTone } from './recording.ts';

export interface TabTrackJob {
  /** The track's index in the score. */
  readonly index: number;
  readonly track: TrackEvents;
  readonly tone: RecordingTone;
  /** One per track, so two guitars playing the same part are two takes. */
  readonly seed: number;
}

export interface TabTrackAudio {
  readonly index: number;
  readonly samples: Float32Array;
  /** Present only where the doubler was on: that is the only stereo stage. */
  readonly right?: Float32Array;
}

/** Brings a DI to the level the presets are voiced against. */
export function levelDi(di: Float32Array, rate: number): Float32Array {
  const rms = activeRms(di, rate);
  if (rms <= 0) return di;
  const gain = Math.pow(10, TARGET_RMS_DB / 20) / rms;
  for (let i = 0; i < di.length; i++) di[i]! *= gain;
  return di;
}

export async function renderTabTrack(
  bank: Bank,
  job: TabTrackJob,
  wasm: ArrayBuffer | Uint8Array<ArrayBuffer>,
  model: Uint8Array<ArrayBuffer>,
  rate: number,
  seconds: number,
  onProgress: (done: number) => void = () => {},
): Promise<TabTrackAudio> {
  // Two halves of the wait, and the guitar is the shorter one.
  const di = levelDi(renderDi(bank, job.track, { rate, seconds, seed: job.seed, onProgress: (d) => onProgress(d * 0.3) }), rate);
  const played = await renderRecording({ samples: di, sampleRate: rate }, job.tone, wasm, model, (d) => onProgress(0.3 + d * 0.7));
  onProgress(1);
  return { index: job.index, samples: played.samples, right: played.right };
}
