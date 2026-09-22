/**
 * A tab, rendered so it can be heard through the amplifier.
 *
 * Every guitar track of the score goes through its own DI and its own pass of
 * the chain — two guitars cannot share one amplifier any more than they can in
 * a room, which is the same reason the looper records after the chain and not
 * before. Everything that is not a guitar (bass, drums, keys) is rendered by
 * alphaTab's own synthesiser, in its own worker, and arrives as one stereo
 * track: an amplifier has no business with a drum kit.
 *
 * The work happens off the main thread and before a note is heard, so the live
 * chain — the guitar in the player's hands — is never asked to share a thread
 * with it.
 */
import type * as alpha from '@coderline/alphatab';
import type { RecordingTone } from './recording.ts';
import { trackEvents, timeline } from './tab-guitar.ts';
import type { TabTrackAudio, TabTrackJob } from './tab-render.ts';
import type { TabMix, TabTrackBuffer } from './tab-playback.ts';
import type { TabRenderMessage, TabRenderRequest } from './tab-audio-worker.ts';

/** General MIDI programs: 24-28 are the quiet guitars, 29-31 the loud ones. */
const GUITAR_PROGRAMS = { first: 24, clean: 28, last: 31 };
/** Anything above this on a six-string is a bass line written on a guitar staff. */
const LOWEST_GUITAR_STRING = 45;

export interface TabGuitarTrack {
  readonly index: number;
  readonly name: string;
  /** A clean program: it wants a clean amplifier, not the rig's distortion. */
  readonly clean: boolean;
  readonly notes: number;
}

/** Which tracks of the score are guitars, and which of those are clean. */
export function guitarTracks(score: alpha.model.Score): TabGuitarTrack[] {
  const out: TabGuitarTrack[] = [];
  for (const track of score.tracks) {
    const staff = track.staves[0];
    if (!staff || staff.isPercussion || staff.tuning.length < 6) continue;
    const program = track.playbackInfo.program;
    if (program < GUITAR_PROGRAMS.first || program > GUITAR_PROGRAMS.last) continue;
    if (Math.min(...staff.tuning) > LOWEST_GUITAR_STRING) continue;
    let notes = 0;
    for (const bar of staff.bars) for (const voice of bar.voices) for (const beat of voice.beats) notes += beat.notes.length;
    if (notes === 0) continue;
    out.push({ index: track.index, name: track.name.trim(), clean: program <= GUITAR_PROGRAMS.clean, notes });
  }
  return out;
}

export interface TabRenderOptions {
  readonly score: alpha.model.Score;
  /** The reader's api, for the band: its synthesiser already has the soundfont. */
  readonly api: alpha.AlphaTabApi;
  /** The module the reader already loaded; nothing here loads a second copy. */
  readonly alphaTab: typeof import('@coderline/alphatab');
  /** The tone the studio is on, for the distorted tracks. */
  readonly tone: RecordingTone;
  /** For the clean tracks, so a clean part is not run through a metal capture. */
  readonly clean: RecordingTone;
  readonly rate: number;
  readonly base: string;
  readonly onProgress?: (done: number) => void;
  readonly signal?: AbortSignal;
}

/** How long the score runs, in seconds, repeats unrolled. */
export function scoreSeconds(score: alpha.model.Score): number {
  const line = timeline(score);
  const last = line.bars[line.bars.length - 1];
  return last ? line.time(last.end) : 0;
}

function jobsFor(options: TabRenderOptions, tracks: readonly TabGuitarTrack[]): TabTrackJob[] {
  const { score, tone, clean } = options;
  return tracks.map((t, seed) => ({
    index: t.index,
    track: trackEvents(score, t.index, seed + 1),
    tone: t.clean ? clean : tone,
    seed: seed + 1,
  })).filter((job) => job.track.events.length > 0);
}

/** The guitars, through the worker. */
function renderGuitars(request: TabRenderRequest, onProgress: (done: number) => void, signal?: AbortSignal): Promise<TabTrackAudio[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./tab-audio-worker.ts', import.meta.url), { type: 'module' });
    const done: TabTrackAudio[] = [];
    const finish = (): void => { worker.terminate(); signal?.removeEventListener('abort', cancel); };
    const cancel = (): void => { finish(); reject(new Error('Rendering cancelled.')); };
    if (signal?.aborted) { cancel(); return; }
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (e: MessageEvent<TabRenderMessage>) => {
      const data = e.data;
      if ('error' in data) { finish(); reject(new Error(data.error)); }
      else if ('track' in data) { done.push(data.track); onProgress(done.length / request.jobs.length); }
      else if ('done' in data) { finish(); resolve(done); }
      else onProgress((done.length + data.progress) / request.jobs.length);
    };
    worker.onerror = () => { finish(); reject(new Error('The tab could not be played through the amplifier.')); };
    worker.postMessage(request);
  });
}

/**
 * Everything that is not a guitar, from alphaTab's synthesiser.
 *
 * Exported rather than played live so it lands on the same clock as the
 * guitars: one set of buffers, started together, cannot drift apart.
 */
export async function renderBand(alphaTab: typeof import('@coderline/alphatab'), api: alpha.AlphaTabApi, score: alpha.model.Score, guitars: readonly number[], rate: number, seconds: number): Promise<{ left: Float32Array<ArrayBuffer>; right: Float32Array<ArrayBuffer> } | undefined> {
  const others = score.tracks.map((t) => t.index).filter((i) => !guitars.includes(i));
  if (others.length === 0) return undefined;
  const options = new alphaTab.synth.AudioExportOptions();
  options.sampleRate = rate;
  options.masterVolume = 1;
  options.metronomeVolume = 0;
  for (const track of score.tracks) options.trackVolume.set(track.index, guitars.includes(track.index) ? 0 : 1);
  const exporter = await api.exportAudio(options);
  const left = new Float32Array(Math.ceil((seconds + 1) * rate));
  const right = new Float32Array(left.length);
  let at = 0;
  try {
    for (let chunk = await exporter.render(1000); chunk; chunk = await exporter.render(1000)) {
      const samples = chunk.samples;
      for (let i = 0; i + 1 < samples.length && at < left.length; i += 2, at++) {
        left[at] = samples[i]!;
        right[at] = samples[i + 1]!;
      }
      if (at >= left.length) break;
    }
  } finally {
    exporter.destroy();
  }
  return { left, right };
}

/** The whole tab, ready to hand to `TabPlayback`. */
export async function renderTabMix(options: TabRenderOptions): Promise<TabMix> {
  const { score, api, rate, base, onProgress = () => {}, signal } = options;
  const tracks = guitarTracks(score);
  const jobs = jobsFor(options, tracks);
  const seconds = scoreSeconds(score);
  if (jobs.length === 0) throw new Error('This tab has no guitar track to play through the amplifier.');
  // The band is quick and the guitars are not, so they run side by side and
  // the bar the player watches is the guitars'.
  const band = renderBand(options.alphaTab, api, score, jobs.map((j) => j.index), rate, seconds);
  const guitars = await renderGuitars({ jobs, rate, seconds: seconds + 1, base }, onProgress, signal);
  const buffers: TabTrackBuffer[] = guitars
    .sort((a, b) => a.index - b.index)
    .map((t) => ({ index: t.index, samples: t.samples, right: t.right }));
  return { rate, seconds, tracks: buffers, band: await band };
}
