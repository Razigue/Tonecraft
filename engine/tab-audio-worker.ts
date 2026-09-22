/**
 * Renders a tab's guitar tracks, off the main thread.
 *
 * Playing a tab through the amplifier is the export path, not the live one: a
 * worker of its own, its own instance of `chain.wasm`, and nothing shared with
 * the rig. The audio thread never sees any of it, so a tab that takes a while
 * to render cannot make the guitar in the player's hands crackle.
 */
import { fetchBank } from './di-bank.ts';
import { renderTabTrack, type TabTrackAudio, type TabTrackJob } from './tab-render.ts';

export interface TabRenderRequest {
  readonly jobs: TabTrackJob[];
  readonly rate: number;
  readonly seconds: number;
  /** Where `dsp/`, `models/` and `di-bank/` are served from. */
  readonly base: string;
}

export type TabRenderMessage =
  | { readonly progress: number; readonly index: number }
  | { readonly track: TabTrackAudio }
  | { readonly done: true }
  | { readonly error: string };

async function bytes(url: string, what: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what} could not be loaded (${response.status}).`);
  return response.arrayBuffer();
}

self.onmessage = async (event: MessageEvent<TabRenderRequest>) => {
  const { jobs, rate, seconds, base } = event.data;
  try {
    const models = new Map<string, Uint8Array<ArrayBuffer>>();
    const [bank, wasm] = await Promise.all([
      fetchBank(base),
      bytes(`${base}dsp/chain.wasm`, 'The audio engine'),
    ]);
    for (const job of jobs) {
      const capture = job.tone.capture;
      if (!capture) throw new Error('Choose an amplifier before playing a tab through it.');
      let model = models.get(capture.file);
      if (!model) {
        model = new Uint8Array(await bytes(`${base}models/${encodeURIComponent(capture.file)}`, 'The amplifier'));
        models.set(capture.file, model);
      }
      const track = await renderTabTrack(bank, job, wasm, model, rate, seconds,
        (done) => self.postMessage({ progress: done, index: job.index } satisfies TabRenderMessage));
      const transfer = [track.samples.buffer, ...(track.right ? [track.right.buffer] : [])];
      self.postMessage({ track } satisfies TabRenderMessage, { transfer });
    }
    self.postMessage({ done: true } satisfies TabRenderMessage);
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : 'The tab could not be played through the amplifier.' } satisfies TabRenderMessage);
  }
};
