/**
 * Playing a rendered tab, with alphaTab's cursor riding on it.
 *
 * The reader's audio has its own `AudioContext` and never touches the rig's
 * (CLAUDE.md §4), so what plays here is a set of buffers: one voice per track
 * of the score — the guitars already through the amplifier, the bass, the
 * drums and the keys through alphaTab's synthesiser. One voice per track and
 * not one for "the band", so muting the bass in the reader's mixer mutes the
 * bass. They are placed on one clock, which is what keeps a drum hit and a
 * chug on the same millisecond — two clocks could not.
 *
 * They arrive in chunks while the song is already playing, because rendering a
 * whole tab takes minutes. A chunk is a buffer scheduled at the second it
 * belongs to, so a track is a row of buffers played back to back rather than
 * one long one, and what has not been rendered yet is simply not scheduled.
 *
 * alphaTab is then put in external-media mode and told where that clock is.
 * With no sync points its own mapping is the identity, and the render follows
 * the score's tempo map exactly, so a tick of the cursor is a tick of the
 * audio. Seeking, pausing and looping all come back through the handler.
 */

interface Chunk {
  /** Seconds from the start of the score. */
  readonly at: number;
  readonly buffer: AudioBuffer;
}

interface Voice {
  readonly gain: GainNode;
  readonly chunks: Chunk[];
  readonly playing: AudioBufferSourceNode[];
}

/** Sources are scheduled this far ahead of the clock, never right on it. */
const SCHEDULE_LEAD = 0.03;

export class TabPlayback {
  readonly context: AudioContext;
  #master: GainNode;
  #voices = new Map<number, Voice>();
  #seconds = 0;
  /** Where the score was when playback last started, in seconds. */
  #offset = 0;
  /** Context time at which score time zero sits. */
  #startedAt = 0;
  #playing = false;
  /** How much of the score every track has been rendered up to. */
  ready = 0;

  constructor(context?: AudioContext) {
    this.context = context ?? new AudioContext();
    this.#master = this.context.createGain();
    this.#master.connect(this.context.destination);
  }

  get rate(): number { return this.context.sampleRate; }
  get playing(): boolean { return this.#playing; }
  get seconds(): number { return this.#seconds; }
  get loaded(): boolean { return this.#voices.size > 0; }

  /** Seconds into the score. */
  get position(): number {
    if (!this.#playing) return this.#offset;
    return Math.max(0, Math.min(this.#seconds, this.context.currentTime - this.#startedAt));
  }

  /** Starts a new render: the tracks it will bring, and how long the score is. */
  open(seconds: number, tracks: readonly number[]): void {
    this.stop();
    for (const voice of this.#voices.values()) voice.gain.disconnect();
    this.#voices.clear();
    this.#seconds = seconds;
    this.ready = 0;
    for (const index of tracks) {
      const gain = this.context.createGain();
      gain.connect(this.#master);
      this.#voices.set(index, { gain, chunks: [], playing: [] });
    }
  }

  /** A chunk of a track, `at` in samples from the start of the score. */
  append(index: number, at: number, left: Float32Array<ArrayBuffer>, right?: Float32Array<ArrayBuffer>): void {
    const voice = this.#voices.get(index);
    if (!voice || left.length === 0) return;
    const buffer = this.context.createBuffer(right ? 2 : 1, left.length, this.rate);
    buffer.copyToChannel(left, 0);
    if (right) buffer.copyToChannel(right, 1);
    const chunk: Chunk = { at: at / this.rate, buffer };
    voice.chunks.push(chunk);
    if (this.#playing) this.#schedule(voice, chunk);
  }

  setMasterVolume(level: number): void {
    this.#master.gain.value = Math.max(0, level);
  }

  /** A track's own level, as the reader's mixer sets it. */
  setTrackVolume(index: number, level: number): void {
    const voice = this.#voices.get(index);
    if (voice) voice.gain.gain.value = Math.max(0, level);
  }

  #schedule(voice: Voice, chunk: Chunk): void {
    // Already gone by: nothing to play. Part way through: start where the
    // clock is, into the chunk.
    if (chunk.at + chunk.buffer.duration <= this.position) return;
    const now = this.context.currentTime;
    const when = this.#startedAt + chunk.at;
    const source = this.context.createBufferSource();
    source.buffer = chunk.buffer;
    source.connect(voice.gain);
    if (when >= now) source.start(when);
    else source.start(now, now - when);
    source.onended = () => {
      const at = voice.playing.indexOf(source);
      if (at >= 0) voice.playing.splice(at, 1);
    };
    voice.playing.push(source);
  }

  #stopSources(): void {
    for (const voice of this.#voices.values()) {
      for (const source of voice.playing) {
        source.onended = null;
        try { source.stop(); } catch { /* already finished */ }
        source.disconnect();
      }
      voice.playing.length = 0;
    }
  }

  play(): void {
    if (this.#playing || this.#voices.size === 0) return;
    if (this.#offset >= this.#seconds) this.#offset = 0;
    void this.context.resume();
    // One origin for every track: their alignment is the whole point.
    this.#startedAt = this.context.currentTime + SCHEDULE_LEAD - this.#offset;
    this.#playing = true;
    for (const voice of this.#voices.values()) for (const chunk of voice.chunks) this.#schedule(voice, chunk);
  }

  pause(): void {
    if (!this.#playing) return;
    this.#offset = this.position;
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
    const to = Math.max(0, Math.min(seconds, this.#seconds));
    const wasPlaying = this.#playing;
    this.#stopSources();
    this.#playing = false;
    this.#offset = to;
    if (wasPlaying) this.play();
  }

  /** Playing, and at the edge of what has been rendered. */
  get starved(): boolean {
    return this.#playing && this.position >= this.ready - 0.05;
  }

  async close(): Promise<void> {
    this.stop();
    for (const voice of this.#voices.values()) voice.gain.disconnect();
    this.#voices.clear();
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
