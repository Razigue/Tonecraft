/**
 * One track of a tab, from its notes to the sound of an amplifier.
 *
 * The guitar is made here (`di-sampler.ts`) and played through the same chain
 * an exported take goes through (`render-recording.ts`), which is the same
 * `chain.wasm` the studio plays live. Nothing about the tab reaches the chain
 * while it is playing: a tab is rendered before it is heard, the way `AD-6`
 * requires a build-time render to use the live settings.
 *
 * Rendered in chunks, because a whole song through the amplifier takes minutes
 * and nobody should watch a bar move for that long. The strings and the chain
 * carry their state across the boundary between chunks, so what comes out is
 * what a single pass would have produced — a note ringing over a chunk edge
 * keeps ringing, and the reverb tail does not restart.
 */
import type { Bank } from './di-bank.ts';
import { DiRenderer, estimatedGain } from './di-sampler.ts';
import type { TrackEvents } from './tab-guitar.ts';
import { chainTail, isDoubled, openChain } from './render-recording.ts';
import type { RecordingTone } from './recording.ts';
import type { ChainCore } from '../public/dsp/chain-core.js';

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
  readonly samples: Float32Array<ArrayBuffer>;
  /** Present only where the doubler was on: that is the only stereo stage. */
  readonly right?: Float32Array<ArrayBuffer>;
}

/** A chunk of a track, and where it belongs in it. */
export interface TabChunk extends TabTrackAudio {
  /** Samples from the start of the track. */
  readonly at: number;
}

/** The chain is fed in blocks of this many frames, as the export does. */
const BLOCK = 1024;

export class TabTrackRenderer {
  #core: ChainCore;
  #di: DiRenderer;
  #gain: number;
  #doubled: boolean;
  #at = 0;

  private constructor(readonly job: TabTrackJob, readonly rate: number, readonly frames: number, core: ChainCore, di: DiRenderer, gain: number, doubled: boolean) {
    this.#core = core;
    this.#di = di;
    this.#gain = gain;
    this.#doubled = doubled;
  }

  /**
   * `seconds` is the music; the chain's own tail is added to it, so a reverb
   * or a pitched note is not cut off at the last bar.
   */
  static async open(bank: Bank, job: TabTrackJob, wasm: ArrayBuffer | Uint8Array<ArrayBuffer>, model: Uint8Array<ArrayBuffer>, rate: number, seconds: number): Promise<TabTrackRenderer> {
    const core = await openChain(job.tone, wasm, model, rate, BLOCK);
    const frames = Math.ceil(seconds * rate) + chainTail(job.tone, rate);
    // The gain is settled before a sample exists, from the notes themselves:
    // measuring the rendered track would mean rendering it all first, and a
    // gain that changed halfway would change the tone, since what follows it
    // is not linear.
    return new TabTrackRenderer(job, rate, frames, core, new DiRenderer(bank, job.track, rate, job.seed), estimatedGain(job.track), isDoubled(job.tone));
  }

  get at(): number { return this.#at; }
  get done(): boolean { return this.#at >= this.frames; }

  /** The next `frames` samples of the track, or fewer at its end. */
  next(frames: number): TabChunk {
    const count = Math.max(0, Math.min(frames, this.frames - this.#at));
    const samples = new Float32Array(count);
    const right = this.#doubled ? new Float32Array(count) : undefined;
    const di = new Float32Array(Math.min(BLOCK, count || 1));
    const at = this.#at;
    for (let offset = 0; offset < count; offset += BLOCK) {
      const n = Math.min(BLOCK, count - offset);
      const input = this.#core.inputs[0]!;
      input.fill(0);
      // Past the last bar the strings are done and only the chain is still
      // sounding: it is fed silence, which is what its tail is.
      if (this.#di.at < this.frames) {
        this.#di.render(di, 0, n);
        for (let i = 0; i < n; i++) input[i] = di[i]! * this.#gain;
      }
      this.#core.process(n, 1);
      samples.set(this.#core.output!.subarray(0, n), offset);
      right?.set(this.#core.outputRight!.subarray(0, n), offset);
    }
    this.#at += count;
    return { index: this.job.index, at, samples, right };
  }
}

/** The whole track in one go, for a render that nobody is waiting to hear. */
export async function renderTabTrack(
  bank: Bank,
  job: TabTrackJob,
  wasm: ArrayBuffer | Uint8Array<ArrayBuffer>,
  model: Uint8Array<ArrayBuffer>,
  rate: number,
  seconds: number,
  onProgress: (done: number) => void = () => {},
): Promise<TabTrackAudio> {
  const renderer = await TabTrackRenderer.open(bank, job, wasm, model, rate, seconds);
  const samples = new Float32Array(renderer.frames);
  const right = isDoubled(job.tone) ? new Float32Array(renderer.frames) : undefined;
  while (!renderer.done) {
    const chunk = renderer.next(Math.round(rate * 2));
    samples.set(chunk.samples, chunk.at);
    if (right && chunk.right) right.set(chunk.right, chunk.at);
    onProgress(renderer.at / renderer.frames);
  }
  onProgress(1);
  return { index: job.index, samples, right };
}
