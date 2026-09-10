export const MIN_BPM = 30;
export const MAX_BPM = 450;
export const TAPS_PER_MEASURE = 4;

export interface ClickVoice {
  readonly type: OscillatorType;
  readonly frequency: number;
  readonly level: number;
  readonly duration: number;
}

const REGULAR_CLICK: ClickVoice = { type: 'triangle', frequency: 980, level: 0.72, duration: 0.038 };
const FOURTH_CLICK: ClickVoice = { type: 'sine', frequency: 1480, level: 1, duration: 0.055 };

/** In 4/4, the final beat is the audible measure marker. */
export function voiceForBeat(beat: number): ClickVoice {
  return ((beat % TAPS_PER_MEASURE) + TAPS_PER_MEASURE) % TAPS_PER_MEASURE === 3
    ? FOURTH_CLICK
    : REGULAR_CLICK;
}

/** The average of the three intervals made by exactly four taps. */
export function bpmFromFourTaps(taps: readonly number[]): number | null {
  if (taps.length !== TAPS_PER_MEASURE) return null;
  const epsilon = 1e-6;
  for (let i = 1; i < taps.length; i += 1) {
    const interval = taps[i]! - taps[i - 1]!;
    if (interval + epsilon < 60_000 / MAX_BPM || interval - epsilon > 60_000 / MIN_BPM) return null;
  }
  const average = (taps[3]! - taps[0]!) / 3;
  const bpm = 60_000 / average;
  return bpm + epsilon >= MIN_BPM && bpm - epsilon <= MAX_BPM ? Math.round(bpm) : null;
}

/**
 * A look-ahead Web Audio clock. setInterval only decides what to schedule;
 * AudioContext time decides when each click actually sounds.
 */
export class Metronome {
  #context: AudioContext | null = null;
  #master: GainNode | null = null;
  #timer: number | null = null;
  #bpm = 0;
  #volume = 0.55;
  #beat = 0;
  #nextBeatAt = 0;
  #running = false;

  async prepare(outputId = ''): Promise<void> {
    if (this.#context === null) {
      const options = {
        latencyHint: 'interactive',
        ...(outputId === '' ? {} : { sinkId: outputId }),
      } as AudioContextOptions;
      try {
        this.#context = new AudioContext(options);
      } catch {
        this.#context = new AudioContext({ latencyHint: 'interactive' });
      }
      this.#master = new GainNode(this.#context, { gain: 0 });
      this.#master.connect(this.#context.destination);
    }
    await this.#context.resume();
    if (outputId !== '') await this.useOutput(outputId);
  }

  async useOutput(outputId: string): Promise<void> {
    const context = this.#context;
    if (context === null || !('setSinkId' in context)) return;
    try {
      await (context as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(outputId);
    } catch { /* keep the current output */ }
  }

  play(bpm: number): void {
    const context = this.#context;
    const master = this.#master;
    if (context === null || master === null || bpm < MIN_BPM || bpm > MAX_BPM) return;
    void context.resume();
    this.#halt();
    this.#bpm = bpm;
    this.#beat = 0;
    this.#nextBeatAt = context.currentTime + 0.04;
    this.#running = true;
    master.gain.cancelScheduledValues(context.currentTime);
    master.gain.setValueAtTime(this.#volume * this.#volume * 0.48, context.currentTime);
    this.#schedule();
    this.#timer = self.setInterval(() => this.#schedule(), 25);
  }

  setVolume(volume: number): void {
    this.#volume = Math.max(0, Math.min(1, volume));
    const context = this.#context;
    const master = this.#master;
    if (context !== null && master !== null && this.#running) {
      master.gain.setTargetAtTime(this.#volume * this.#volume * 0.48, context.currentTime, 0.015);
    }
  }

  pause(): void {
    this.#halt();
  }

  async dispose(): Promise<void> {
    this.#halt();
    await this.#context?.close();
    this.#context = null;
    this.#master = null;
  }

  #halt(): void {
    if (this.#timer !== null) self.clearInterval(this.#timer);
    this.#timer = null;
    this.#running = false;
    const context = this.#context;
    const master = this.#master;
    if (context !== null && master !== null) {
      master.gain.cancelScheduledValues(context.currentTime);
      master.gain.setTargetAtTime(0, context.currentTime, 0.006);
    }
  }

  #schedule(): void {
    const context = this.#context;
    const master = this.#master;
    if (!this.#running || context === null || master === null || this.#bpm === 0) return;
    const horizon = context.currentTime + 0.1;
    const interval = 60 / this.#bpm;
    while (this.#nextBeatAt < horizon) {
      const voice = voiceForBeat(this.#beat);
      const oscillator = new OscillatorNode(context, {
        type: voice.type,
        frequency: voice.frequency,
      });
      const envelope = new GainNode(context, { gain: 0.0001 });
      oscillator.connect(envelope);
      envelope.connect(master);
      envelope.gain.setValueAtTime(0.0001, this.#nextBeatAt);
      envelope.gain.exponentialRampToValueAtTime(voice.level, this.#nextBeatAt + 0.002);
      envelope.gain.exponentialRampToValueAtTime(0.0001, this.#nextBeatAt + voice.duration);
      oscillator.start(this.#nextBeatAt);
      oscillator.stop(this.#nextBeatAt + 0.06);
      this.#beat = (this.#beat + 1) % TAPS_PER_MEASURE;
      this.#nextBeatAt += interval;
    }
  }
}
