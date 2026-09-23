/**
 * Renders a tab's guitar tracks, off the main thread and in the order they
 * will be heard.
 *
 * Playing a tab through the amplifier is the export path, not the live one: a
 * worker of its own, its own instance of `chain.wasm`, and nothing shared with
 * the rig. The audio thread never sees any of it, so a tab that takes minutes
 * to render cannot make the guitar in the player's hands crackle.
 *
 * It renders a chunk of each of its tracks in turn rather than a track at a
 * time, because playback starts as soon as the first seconds of *every* track
 * exist. A track at a time would mean waiting for the whole song.
 */
import { fetchBank } from './di-bank.ts';
import { TabTrackRenderer, type TabChunk, type TabTrackJob } from './tab-render.ts';

export interface TabRenderRequest {
  readonly jobs: TabTrackJob[];
  readonly rate: number;
  readonly seconds: number;
  /** Where `dsp/`, `models/` and `di-bank/` are served from. */
  readonly base: string;
  /** How much music each chunk carries. */
  readonly chunkSeconds: number;
}

export type TabRenderMessage =
  | { readonly chunk: TabChunk; readonly rendered: number }
  | { readonly done: true }
  | { readonly error: string };

async function bytes(url: string, what: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${what} could not be loaded (${response.status}).`);
  return response.arrayBuffer();
}

self.onmessage = async (event: MessageEvent<TabRenderRequest>) => {
  const { jobs, rate, seconds, base, chunkSeconds } = event.data;
  try {
    const models = new Map<string, Uint8Array<ArrayBuffer>>();
    const [bank, wasm] = await Promise.all([
      fetchBank(base),
      bytes(`${base}dsp/chain.wasm`, 'The audio engine'),
    ]);
    const renderers: TabTrackRenderer[] = [];
    for (const job of jobs) {
      const capture = job.tone.capture;
      if (!capture) throw new Error('Choose an amplifier before playing a tab through it.');
      let model = models.get(capture.file);
      if (!model) {
        model = new Uint8Array(await bytes(`${base}models/${encodeURIComponent(capture.file)}`, 'The amplifier'));
        models.set(capture.file, model);
      }
      renderers.push(await TabTrackRenderer.open(bank, job, wasm, model, rate, seconds));
    }
    const frames = Math.round(chunkSeconds * rate);
    let left = renderers.filter((r) => !r.done);
    while (left.length > 0) {
      for (const renderer of left) {
        const chunk = renderer.next(frames);
        // How far every one of this worker's tracks is rendered: what the page
        // can safely play up to is the least of them.
        const rendered = Math.min(...renderers.map((r) => r.at)) / rate;
        const transfer = [chunk.samples.buffer, ...(chunk.right ? [chunk.right.buffer] : [])];
        self.postMessage({ chunk, rendered } satisfies TabRenderMessage, { transfer });
      }
      left = left.filter((r) => !r.done);
    }
    self.postMessage({ done: true } satisfies TabRenderMessage);
  } catch (e) {
    self.postMessage({ error: e instanceof Error ? e.message : 'The tab could not be played through the amplifier.' } satisfies TabRenderMessage);
  }
};
