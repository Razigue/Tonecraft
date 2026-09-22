/**
 * Playing a rendered tab, with alphaTab's cursor riding on it.
 *
 * The reader's audio has its own `AudioContext` and never touches the rig's
 * (CLAUDE.md §4), so what plays here is a set of buffers: one per guitar track,
 * each already through the amplifier, plus one for everything that is not a
 * guitar, rendered by alphaTab's own synthesiser. They start together on one
 * clock, which is what keeps a drum hit and a chug on the same millisecond —
 * two clocks could not.
 *
 * alphaTab is then put in external-media mode and told where that clock is.
 * With no sync points its own mapping is the identity, and the render follows
 * the score's tempo map exactly, so a tick of the cursor is a tick of the
 * audio. Seeking, pausing and looping all come back through the handler.
 */

export interface TabTrackBuffer {
  /** The score track this is. */
  readonly index: number;
  readonly samples: Float32Array<ArrayBuffer>;
  readonly right?: Float32Array<ArrayBuffer>;
}

export interface TabMix {
  readonly rate: number;
  /** The score's own length in seconds, which is the time axis alphaTab shares. */
  readonly seconds: number;
  readonly tracks: readonly TabTrackBuffer[];
  /** Bass, drums, keys: everything the amplifier has no business with. */
  readonly band?: { readonly left: Float32Array<ArrayBuffer>; readonly right: Float32Array<ArrayBuffer> };
}

interface Voice {
  readonly gain: GainNode;
  readonly buffer: AudioBuffer;
  source: AudioBufferSourceNode | null;
}

/** The end of the audio is past the end of the score: reverb and ring-out live there. */
const TAIL_GUARD = 0.05;

export class TabPlayback {
  readonly context: AudioContext;
  #master: GainNode;
  #voices = new Map<number, Voice>();
  #band: Voice | null = null;
  /**
   * What is loaded, without the samples it was loaded from: those are copied
   * into `AudioBuffer`s and let go. Keeping both doubles a four-minute song's
   * 200 MB, for nothing — nothing ever reads them again.
   */
  #loaded: { seconds: number; rate: number } | null = null;
  /** Where the score was when playback last started, in seconds. */
  #offset = 0;
  #startedAt = 0;
  #playing = false;
  /** Called when the audio has run past the end of the score. */
  onended: (() => void) | null = null;

  constructor(context?: AudioContext) {
    this.context = context ?? new AudioContext();
    this.#master = this.context.createGain();
    this.#master.connect(this.context.destination);
  }

  get rate(): number { return this.context.sampleRate; }
  get playing(): boolean { return this.#playing; }
  get seconds(): number { return this.#loaded?.seconds ?? 0; }

  /** Seconds into the score. */
  get position(): number {
    if (!this.#playing) return this.#offset;
    return this.#offset + (this.context.currentTime - this.#startedAt);
  }

  #toBuffer(left: Float32Array<ArrayBuffer>, right?: Float32Array<ArrayBuffer>): AudioBuffer {
    const buffer = this.context.createBuffer(right ? 2 : 1, Math.max(1, left.length), this.rate);
    buffer.copyToChannel(left, 0);
    if (right) buffer.copyToChannel(right, 1);
    return buffer;
  }

  load(mix: TabMix): void {
    this.stop();
    this.#loaded = { seconds: mix.seconds, rate: mix.rate };
    for (const voice of [...this.#voices.values(), ...(this.#band ? [this.#band] : [])]) voice.gain.disconnect();
    this.#voices.clear();
    this.#band = null;
    for (const track of mix.tracks) {
      const gain = this.context.createGain();
      gain.connect(this.#master);
      this.#voices.set(track.index, { gain, buffer: this.#toBuffer(track.samples, track.right), source: null });
    }
    if (mix.band) {
      const gain = this.context.createGain();
      gain.connect(this.#master);
      this.#band = { gain, buffer: this.#toBuffer(mix.band.left, mix.band.right), source: null };
    }
  }

  get loaded(): boolean { return this.#loaded !== null; }

  setMasterVolume(level: number): void {
    this.#master.gain.value = Math.max(0, level);
  }

  /** A track's own level, as the reader's mixer sets it. */
  setTrackVolume(index: number, level: number): void {
    const voice = this.#voices.get(index);
    if (voice) voice.gain.gain.value = Math.max(0, level);
  }

  setBandVolume(level: number): void {
    if (this.#band) this.#band.gain.gain.value = Math.max(0, level);
  }

  #all(): Voice[] {
    return this.#band ? [...this.#voices.values(), this.#band] : [...this.#voices.values()];
  }

  #stopSources(): void {
    for (const voice of this.#all()) {
      if (!voice.source) continue;
      voice.source.onended = null;
      try { voice.source.stop(); } catch { /* already finished */ }
      voice.source.disconnect();
      voice.source = null;
    }
  }

  play(): void {
    if (this.#playing || !this.#loaded) return;
    if (this.#offset >= this.#loaded.seconds) this.#offset = 0;
    void this.context.resume();
    // One start time for every track: their alignment is the whole point.
    const when = this.context.currentTime + 0.03;
    for (const voice of this.#all()) {
      const source = this.context.createBufferSource();
      source.buffer = voice.buffer;
      source.connect(voice.gain);
      source.start(when, Math.min(this.#offset, voice.buffer.duration));
      voice.source = source;
    }
    this.#startedAt = when;
    this.#playing = true;
  }

  pause(): void {
    if (!this.#playing) return;
    this.#offset = Math.max(0, this.position);
    this.#stopSources();
    this.#playing = false;
  }

  stop(): void {
    this.#stopSources();
    this.#playing = false;
    this.#offset = 0;
  }

  /** Seconds into the score. Playing, it keeps playing from there. */
  seek(seconds: number): void {
    const to = Math.max(0, Math.min(seconds, this.seconds));
    if (this.#playing) {
      this.#stopSources();
      this.#playing = false;
      this.#offset = to;
      this.play();
    } else this.#offset = to;
  }

  /** True once the audio has run past the end of the score. */
  get finished(): boolean {
    return this.#playing && this.position > this.seconds + TAIL_GUARD;
  }

  async close(): Promise<void> {
    this.stop();
    this.#voices.clear();
    this.#band = null;
    this.#loaded = null;
    await this.context.close();
  }
}

/**
 * The handler alphaTab drives the cursor from. It owns no state: every answer
 * comes from the playback above, so there is one position in the reader and
 * not two that can disagree.
 */
export function externalMedia(playback: TabPlayback): {
  backingTrackDuration: number; playbackRate: number; masterVolume: number;
  seekTo(time: number): void; play(): void; pause(): void;
} {
  return {
    get backingTrackDuration(): number { return playback.seconds * 1000; },
    // Speed is a re-render, not a resampling: a slowed tab must not drop a tone.
    playbackRate: 1,
    get masterVolume(): number { return 1; },
    set masterVolume(_: number) { /* the reader's own mixer sets it */ },
    seekTo: (time: number) => playback.seek(time / 1000),
    play: () => playback.play(),
    pause: () => playback.pause(),
  };
}
