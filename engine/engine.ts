/**
 * Everything the product does with the chain, for both of its hosts.
 *
 * The chain itself is `public/dsp/chain.wasm`, built from `dsp/`:
 *
 *     source (live DI or an audio file)
 *       -> frontend      channel choice, trim, noise gate, TS boost (4x, ADAA)
 *       -> amp           the NAM capture
 *       -> capture trim  measured offline, so captures match each other
 *       -> cabinet       synthesised minimum-phase IR, zero-latency convolution
 *       -> four-band correction, exactly the Web Audio biquads it replaced
 *       -> reverb, in parallel, computed only while audible
 *       -> master
 *       -> limiter       always on, no control anywhere (FR-18)
 *
 * Two hosts run it: the browser's AudioWorklet (`web-host.ts`) and Tonecraft
 * Engine, the native companion for ASIO (`native-host.ts`). This file is the
 * only place that decides what the chain is told — parameter values, power,
 * the tuner's silence, which source plays, which capture and cabinet — and it
 * tells both hosts the same thing through the same calls. That is what keeps a
 * feature from existing in one host and missing from the other: hosts carry no
 * feature of their own to fall out of step.
 *
 * Nothing in the chain adds latency (`npm run test:chain` asserts it). The main
 * thread owns state; the chain owns nothing (AD-11). Metering is a
 * measurement, not state, and it flows one way (AD-12).
 */

import { PARAMS } from '../schema/params.ts';
import { IR_SLOTS, CHANNEL_CODES, CLICK_WAVES, LOOP_STATES, meterIndex, type LoopState } from '../schema/chain.ts';
import { cabIR, reverbIR, DEFAULT_CAB } from './ir.ts';
import { loadCatalog, EMPTY_CATALOG, type Catalog, type Capture } from './catalog.ts';
import { classifyDevice } from './input.ts';
import {
  judgeLatency, judgeDropouts, jitterOf, judgeInput,
  type LatencyVerdict, type DropoutVerdict, type JitterStats, type InputVerdict,
} from './diagnosis.ts';
import { EngineError, type ChainHost, type HostEvents, type LatencyParts } from './chain-host.ts';
import {
  WebHost, listInputs, listOutputs, probeOutputs, canChooseOutput,
  type InputDevice, type OutputDevice,
} from './web-host.ts';
import { NativeHost, NativeLink, type NativeOpened } from './native-host.ts';
import type { ClickTransport, ClickVoice } from './metronome.ts';

export { EngineError, type EngineFailure, type LatencyParts } from './chain-host.ts';
export type { InputDevice, OutputDevice } from './web-host.ts';

/** What the looper is doing, for the one button that drives it. */
export interface LoopMeters {
  readonly state: LoopState;
  /** Where the loop is and how long it is, in seconds. Both 0 while empty. */
  readonly position: number;
  readonly length: number;
}

export interface Meters {
  /** Peak at the input, before our own gain. */
  readonly input: number;
  /** Peak leaving the input stage, on its way into the model. */
  readonly drive: number;
  /** Peak and RMS at the very end, after the limiter. */
  readonly output: number;
  readonly outputRms: number;
  /** 1 while the gate is open, 0 while it is shut. */
  readonly gate: number;
  /** Peak on each captured channel, before one is chosen. */
  readonly channelPeaks: readonly number[];
  readonly channels: number;
  /** What the transposer is adding to the round trip, in ms. 0 unless engaged. */
  readonly pitchDelayMs: number;
  readonly loop: LoopMeters;
}

/** Everything the product knows about how well it is running (FR-35 to FR-38). */
export interface Health {
  readonly latency: LatencyVerdict;
  readonly dropouts: DropoutVerdict;
  readonly jitter: JitterStats;
  readonly input: InputVerdict;
  /** Cold load to first audible note, in ms. NFR-3 targets a median under 8 s. */
  readonly timeToFirstNoteMs: number | null;
}

export interface EngineOptions {
  /** Called at up to 30 Hz. Dropping a call must never matter (AD-12). */
  onMeters?: (meters: Meters) => void;
  /** Called when a capture finishes loading, or fails to. */
  onModel?: (file: string, ok: boolean) => void;
  /**
   * Called once, if the host itself fails. Distinct from a capture failing:
   * when the engine is dead every capture fails, and a chain passing the dry
   * signal looks and sounds alive.
   */
  onEngineError?: (message: string) => void;
}

const BASE = import.meta.env.BASE_URL;

/** Which captured channel feeds the chain. `follow` picks whichever has signal. */
export type InputChannel = 'left' | 'right' | 'sum' | 'follow';
export type Source = 'live' | 'file';
/** Where the chain runs: in this tab, or in Tonecraft Engine for ASIO. */
export type Backend = 'browser' | 'native';

/** The catalogue, without an engine: the selectors must be honest before anything is powered up. */
export function readCatalog(): Promise<Catalog> {
  return loadCatalog(BASE);
}

const WIRE = new Map(PARAMS.map((p, i) => [p.id, i]));
const M_INPUT = meterIndex('input_peak');
const M_DRIVE = meterIndex('drive_peak');
const M_GATE = meterIndex('gate');
const M_BRIGHTNESS = meterIndex('brightness');
const M_CH0 = meterIndex('channel0_peak');
const M_CH1 = meterIndex('channel1_peak');
const M_OUT_PEAK = meterIndex('output_peak');
const M_OUT_RMS = meterIndex('output_rms');
const M_FILE_SECONDS = meterIndex('file_seconds');
const M_FILE_PLAYING = meterIndex('file_playing');
const M_LOOP_STATE = meterIndex('loop_state');
const M_LOOP_SECONDS = meterIndex('loop_seconds');
const M_LOOP_LENGTH = meterIndex('loop_length');
const M_PITCH_DELAY = meterIndex('pitch_delay_ms');

const LOOP_BY_CODE = Object.fromEntries(
  Object.entries(LOOP_STATES).map(([name, code]) => [code, name as LoopState]),
) as Record<number, LoopState>;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

type ClickState = { readonly bpm: number; readonly gain: number; readonly voices: readonly ClickVoice[] } | null;

/** Decodes a file at the chain's rate, so the chain plays samples and never resamples. */
async function decodeAt(bytes: ArrayBuffer, sampleRate: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  // decodeAudioData detaches what it is given; the original is kept for the
  // next rate.
  return ctx.decodeAudioData(bytes.slice(0));
}

/** One or two channels, planar, as `tc_file_load` takes them. */
function planar(buffer: AudioBuffer): Float32Array<ArrayBuffer> {
  const channels = Math.min(2, buffer.numberOfChannels);
  const out = new Float32Array(buffer.length * channels);
  for (let c = 0; c < channels; c++) out.set(buffer.getChannelData(c), c * buffer.length);
  return out;
}

export class Engine {
  #host: ChainHost | null = null;
  #web: WebHost | null = null;
  #native: NativeHost | null = null;
  #backend: Backend = 'browser';
  /** The metronome as last started through the chain, replayed into a fresh one. */
  #click: ClickState = null;
  /** The looper's playback level. It outlives a host; the loop itself does not. */
  #loopLevel = 0.8;

  // Browser preferences: they outlive a host, which is rebuilt on every start.
  #deviceId: string | undefined;
  #sinkId: string | undefined;

  #channel: InputChannel = 'follow';
  #catalog: Catalog = EMPTY_CATALOG;
  #capture: Capture | null = null;
  #cab = DEFAULT_CAB;

  #source: Source = 'live';
  #direct = false;
  #powered = true;
  #tuning = false;

  #fileBytes: ArrayBuffer | null = null;
  #buffer: AudioBuffer | null = null;
  #filePlaying = false;
  #fileLoop = true;
  #fileCursor = 0;
  #playAskedAt = 0;

  #startedAt = 0;
  #firstAudioAt: number | null = null;
  #dropouts = 0;
  #peak = 0;
  #brightness = 0;
  #lastMeters: Float32Array | null = null;
  #meterArrivals: number[] = [];
  #values = new Map<string, number>();

  /**
   * Set once the host reports it cannot run. Latched, because every later
   * load would otherwise wait out its timeout while the interface says nothing.
   */
  #engineError: string | null = null;

  readonly #onMeters: ((meters: Meters) => void) | undefined;
  readonly #onModel: ((file: string, ok: boolean) => void) | undefined;
  readonly #onEngineError: ((message: string) => void) | undefined;

  constructor(options: EngineOptions = {}) {
    this.#onMeters = options.onMeters;
    this.#onModel = options.onModel;
    this.#onEngineError = options.onEngineError;
    for (const p of PARAMS) this.#values.set(p.id, p.default);
  }

  get engineError(): string | null { return this.#engineError; }
  get running(): boolean { return this.#host !== null; }
  get backend(): Backend { return this.#backend; }
  get catalog(): Catalog { return this.#catalog; }
  get capture(): Capture | null { return this.#capture; }
  get cab(): string { return this.#cab; }
  get source(): Source { return this.#source; }
  get inputChannel(): InputChannel { return this.#channel; }
  get fileLoaded(): boolean { return this.#buffer !== null; }
  get filePlaying(): boolean { return this.#filePlaying; }
  get fileDuration(): number { return this.#buffer?.duration ?? 0; }
  get sampleRate(): number | null { return this.#host?.sampleRate ?? null; }
  /** What Tonecraft Engine opened, while it is the host. */
  get nativeOpened(): NativeOpened | null { return this.#native?.opened ?? null; }

  /** Channels the input delivers; the choice between them only exists above one. */
  get channelCount(): number {
    if (this.#web !== null) return this.#web.channels;
    const opened = this.#native?.opened;
    return opened === undefined || opened === null ? 1 : Math.min(2, opened.inputChannels);
  }

  async loadCatalog(): Promise<Catalog> {
    this.#catalog = await loadCatalog(BASE);
    return this.#catalog;
  }

  /**
   * Chooses the host for the next start. Which interface Tonecraft Engine
   * plays through is its own configuration, not this page's.
   */
  useNative(native: boolean): void {
    this.#backend = native ? 'native' : 'browser';
  }

  /** The round trip as the host reports it (FR-35). Shown, never used to decide anything (AD-5). */
  get roundTripMs(): number | null { return this.#host?.roundTripMs ?? null; }
  get latencyParts(): LatencyParts | null { return this.#host?.latencyParts ?? null; }

  /** Blocks the audio thread did not render in time, counted by the host (AD-12). */
  get dropoutCount(): number { return this.#dropouts; }

  /** The whole picture, judged. No verdict here refuses anything (FR-37). */
  get health(): Health | null {
    const ms = this.roundTripMs;
    if (ms === null) return null;
    const elapsed = (performance.now() - this.#startedAt) / 1000;
    const intervals: number[] = [];
    for (let i = 1; i < this.#meterArrivals.length; i += 1) {
      intervals.push(this.#meterArrivals[i]! - this.#meterArrivals[i - 1]!);
    }
    const label = this.#web?.deviceLabel ?? this.#native?.opened?.input ?? '';
    return {
      latency: judgeLatency(ms, this.#web?.deviceKind ?? classifyDevice(label)),
      dropouts: judgeDropouts(this.#dropouts, elapsed),
      jitter: jitterOf(intervals),
      input: judgeInput({
        deviceKind: this.#web?.deviceKind ?? classifyDevice(label),
        deviceLabel: label,
        roundTripMs: ms,
        peak: this.#peak,
        brightness: this.#brightness,
      }),
      timeToFirstNoteMs: this.#firstAudioAt === null ? null : this.#firstAudioAt - this.#startedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Starting and stopping

  /**
   * Must be called from a user gesture on the browser host — the autoplay
   * policy will not create a running context otherwise.
   */
  async start(): Promise<void> {
    if (this.#host !== null) return;
    // NFR-3 measures from the gesture: the permission prompt is part of the wait.
    this.#startedAt = performance.now();
    if (this.#catalog.models.length === 0) await this.loadCatalog();

    const events: HostEvents = {
      onMeters: (frame, dropouts) => this.#onFrame(frame, dropouts),
      onFailure: (message) => this.#onFailure(message),
      // A device changed from the engine's tray panel: its chain is new.
      onReopened: () => { void this.#pushState(); },
    };

    if (this.#backend === 'native') {
      const host = new NativeHost(NativeLink.shared, events);
      const response = await fetch(`${BASE}dsp/chain.wasm`);
      if (!response.ok) {
        throw new EngineError({ kind: 'engine-missing' }, 'The audio engine is missing. Run `npm run build:dsp` and reload.');
      }
      await host.start(await response.arrayBuffer());
      this.#native = host;
      this.#host = host;
    } else {
      const host = new WebHost(events, { deviceId: this.#deviceId, sinkId: this.#sinkId });
      try {
        await host.start(this.#source === 'live');
      } catch (cause) {
        await host.stop();
        throw cause;
      }
      this.#web = host;
      this.#host = host;
    }

    await this.#pushState();
  }

  /**
   * Everything the chain should be, sent from nothing. The chain starts empty
   * on every start, in both hosts, so there is exactly one way it gets its
   * state — this one — and no host-specific path that could forget a piece.
   */
  async #pushState(): Promise<void> {
    const host = this.#host;
    if (host === null) return;
    host.send('tc_set_input_channel', [CHANNEL_CODES[this.#channel]]);
    for (const p of PARAMS) {
      if (p.deprecated !== true) host.send('tc_set_param', [WIRE.get(p.id)!, this.#values.get(p.id) ?? p.default]);
    }
    host.send('tc_set_powered', [this.#powered ? 1 : 0]);
    host.send('tc_set_direct', [this.#direct ? 1 : 0]);
    host.send('tc_set_tuning', [this.#tuning ? 1 : 0]);
    host.send('tc_set_source', [this.#source === 'file' ? 1 : 0]);
    host.send('tc_file_loop', [this.#fileLoop ? 1 : 0]);
    host.send('tc_loop_level', [this.#loopLevel]);
    this.#syncLive();
    host.send('tc_set_ir', [IR_SLOTS.cab], cabIR(host.sampleRate, this.#cab));
    host.send('tc_set_ir', [IR_SLOTS.reverb], reverbIR(host.sampleRate, 1.3));
    if (this.#fileBytes !== null) {
      // Decoded again at the chain's rate: a take loaded before starting was
      // decoded at whatever rate there was then.
      this.#buffer = await decodeAt(this.#fileBytes, host.sampleRate);
      host.send('tc_file_load', [Math.min(2, this.#buffer.numberOfChannels)], planar(this.#buffer));
    }
    if (this.#click !== null) this.clickTransport?.play(this.#click.bpm, this.#click.gain, this.#click.voices);
    const capture = this.#capture ?? this.#catalog.models[0] ?? null;
    if (capture !== null) await this.setCapture(capture.file);
  }

  async stop(): Promise<void> {
    const host = this.#host;
    this.#host = null;
    this.#web = null;
    this.#native = null;
    this.#filePlaying = false;
    this.#tuning = false;
    this.#dropouts = 0;
    this.#meterArrivals = [];
    this.#firstAudioAt = null;
    this.#engineError = null;
    await host?.stop();
  }

  // -------------------------------------------------------------------------
  // Metering

  #onFrame(frame: Float32Array, dropouts: number): void {
    this.#lastMeters = frame;
    this.#peak = frame[M_INPUT]!;
    this.#brightness = frame[M_BRIGHTNESS]!;
    this.#dropouts = dropouts;

    const now = performance.now();
    // A rolling window: jitter is how things are going now, not a session average.
    this.#meterArrivals.push(now);
    if (this.#meterArrivals.length > 90) this.#meterArrivals.shift();
    // The first audible note is the first frame carrying signal; silence is not a note.
    if (this.#firstAudioAt === null && frame[M_INPUT]! > 0.01) this.#firstAudioAt = now;

    /* The chain reports where the take is. A frame computed before the chain
       saw a play request can arrive after it, so the first few after asking
       are not allowed to say "stopped". */
    if (this.#filePlaying && now - this.#playAskedAt > 150) {
      this.#fileCursor = frame[M_FILE_SECONDS]!;
      if (frame[M_FILE_PLAYING]! < 0.5) {
        this.#filePlaying = false;
        this.#fileCursor = this.fileDuration;
      }
    }

    const channels = this.channelCount;
    this.#onMeters?.({
      input: frame[M_INPUT]!,
      drive: frame[M_DRIVE]!,
      output: frame[M_OUT_PEAK]!,
      outputRms: frame[M_OUT_RMS]!,
      gate: frame[M_GATE]!,
      channelPeaks: [frame[M_CH0]!, frame[M_CH1]!].slice(0, Math.max(1, channels)),
      channels,
      pitchDelayMs: frame[M_PITCH_DELAY]!,
      loop: {
        state: LOOP_BY_CODE[Math.round(frame[M_LOOP_STATE]!)] ?? 'empty',
        position: frame[M_LOOP_SECONDS]!,
        length: frame[M_LOOP_LENGTH]!,
      },
    });
  }

  /** The latest meter frame, in the chain's own layout (schema/chain.ts). */
  get meterFrame(): Float32Array | null { return this.#lastMeters; }

  #onFailure(message: string): void {
    if (this.#engineError !== null) return;
    this.#engineError = message;
    this.#onModel?.('', false);
    this.#onEngineError?.(message);
  }

  // -------------------------------------------------------------------------
  // Tone

  /**
   * Loads a capture and waits for the chain to confirm it.
   *
   * Waiting matters: when a load fails the chain passes the raw DI through,
   * which sounds bad and looks like nothing at all. Confirmation is the
   * difference between a stated failure and a mystery.
   */
  async setCapture(file: string): Promise<boolean> {
    const capture = this.#catalog.models.find((m) => m.file === file);
    if (capture === undefined) return false;
    this.#capture = capture;

    const host = this.#host;
    if (host === null) return false;
    if (this.#engineError !== null) return false;

    const response = await fetch(`${BASE}models/${encodeURIComponent(file)}`);
    if (!response.ok) return false;
    const json = new Uint8Array(await response.arrayBuffer());
    if (this.#host !== host) return false;

    // Trim measured offline by scripts/calibrate-models.ts, through the
    // cabinet, because the cabinet is what sets the perceived level.
    host.send('tc_set_capture_trim', [capture.trimDb]);
    const result = await host.call('tc_load_model', [], json);
    const ok = result.value === 1;
    this.#onModel?.(file, ok);
    return ok;
  }

  /**
   * The whole simulation, on or off. Off silences every route to the output,
   * tails included, and closes the live input: leaving it open would monitor
   * whatever the machine is listening to, which on a laptop is a feedback path.
   */
  setPowered(powered: boolean): void {
    this.#powered = powered;
    if (powered) this.#host?.resume();
    this.#host?.send('tc_set_powered', [powered ? 1 : 0]);
    this.#syncLive();
  }

  /**
   * Silences the output while keeping the clean input tap alive. Power is
   * untouched, so closing the tuner restores exactly what the player had.
   */
  setTunerActive(active: boolean): void {
    this.#tuning = active;
    const host = this.#host;
    if (host === null) return;
    if (active) host.resume();
    host.send('tc_set_tuning', [active ? 1 : 0]);
    host.setTunerTap(active);
    this.#syncLive();
  }

  /** Copies the latest clean input window and returns its sample rate. */
  readTunerInput(target: Float32Array<ArrayBuffer>): number | null {
    return this.#host?.readTunerInput(target) ?? null;
  }

  get tunerBufferSize(): number {
    return this.#host?.tunerBufferSize ?? 8192;
  }

  setDirect(direct: boolean): void {
    this.#direct = direct;
    this.#host?.send('tc_set_direct', [direct ? 1 : 0]);
    this.#syncLive();
  }

  /** The live input is open while it is heard, or while the tuner listens to it. */
  #syncLive(): void {
    const open = this.#source === 'live' && (this.#tuning || (this.#powered && !this.#direct));
    const host = this.#host;
    if (host === null) return;
    host.send('tc_set_live_input', [open ? 1 : 0]);
    host.setCaptureOpen(open);
  }

  /** True when the live input is muted because the simulation is off. */
  get liveMuted(): boolean {
    return this.#direct && this.#source === 'live';
  }

  get direct(): boolean { return this.#direct; }

  /** Instant: the IR is synthesised in a few milliseconds, no file to fetch. */
  setCab(id: string): void {
    this.#cab = id;
    const host = this.#host;
    if (host !== null) host.send('tc_set_ir', [IR_SLOTS.cab], cabIR(host.sampleRate, id));
  }

  /** Engineering units (AD-9); the chain glides to it (AD-20). */
  setParam(id: string, value: number): void {
    this.#values.set(id, value);
    const wire = WIRE.get(id);
    if (wire !== undefined) this.#host?.send('tc_set_param', [wire, value]);
  }

  value(id: string): number {
    return this.#values.get(id) ?? 0;
  }

  /**
   * Instant: the capture carries every channel, so this only changes which one
   * the chain reads. Never tone state — it describes hardware, not a tone.
   */
  setInputChannel(channel: InputChannel): void {
    this.#channel = channel;
    this.#host?.send('tc_set_input_channel', [CHANNEL_CODES[channel]]);
  }

  // -------------------------------------------------------------------------
  // The browser's devices. Tonecraft Engine lists its own (native-host.ts).

  listInputs(): Promise<InputDevice[]> { return listInputs(); }
  listOutputs(): Promise<OutputDevice[]> { return listOutputs(); }
  static get canChooseOutput(): boolean { return canChooseOutput(); }

  /** The outputs with what each costs on the way out, at the rate the chain runs at. */
  probeOutputs(): Promise<OutputDevice[]> {
    return probeOutputs(this.#web?.sampleRate);
  }

  /** The output in use: a device id, or '' for the default. */
  get outputId(): string { return this.#web?.outputId ?? this.#sinkId ?? ''; }

  async useOutput(id: string): Promise<void> {
    this.#sinkId = id === '' ? undefined : id;
    await this.#web?.useOutput(id);
  }

  async useDevice(deviceId: string): Promise<void> {
    this.#deviceId = deviceId;
    if (this.#source === 'live') await this.#web?.useDevice(deviceId);
  }

  // -------------------------------------------------------------------------
  // The metronome, when the chain has to play it (native-host.ts)

  /**
   * The chain's click generator, for the native host only. Under ASIO the
   * driver owns the interface, and a click from the browser would come out of
   * the laptop's speakers rather than the headphones.
   */
  get clickTransport(): ClickTransport | null {
    const host = this.#native;
    if (host === null) return null;
    const remember = (click: ClickState): void => { this.#click = click; };
    const current = (): ClickState => this.#click;
    return {
      play(bpm: number, gain: number, voices: readonly ClickVoice[]): void {
        remember({ bpm, gain, voices });
        voices.forEach((v, beat) => {
          host.send('tc_click_voice', [beat, v.type === 'triangle' ? CLICK_WAVES.triangle : CLICK_WAVES.sine,
            v.frequency, v.level, v.duration]);
        });
        host.send('tc_click_play', [bpm, gain]);
      },
      setGain(gain: number): void {
        const click = current();
        if (click !== null) remember({ ...click, gain });
        host.send('tc_click_gain', [gain]);
      },
      stop(): void {
        remember(null);
        host.send('tc_click_stop');
      },
    };
  }

  // -------------------------------------------------------------------------
  // The looper
  //
  // It lives in the chain, at the end of it, and it records what leaves the
  // rig (dsp/looper.h). What is here is only the button: the chain owns what a
  // press means, so the browser and Tonecraft Engine cannot disagree about it.
  // A loop is audio, not state — starting the engine builds a new chain, and
  // an empty one.

  /** The one button: record, then play, then overdub, then play. */
  loopPress(): void {
    this.#host?.resume();
    this.#host?.send('tc_loop_press');
  }

  loopStop(): void { this.#host?.send('tc_loop_stop'); }
  loopClear(): void { this.#host?.send('tc_loop_clear'); }

  /** How loud the loop sits under the playing, 0..1. Session, never tone. */
  setLoopLevel(level: number): void {
    this.#loopLevel = clamp(level, 0, 1);
    this.#host?.send('tc_loop_level', [this.#loopLevel]);
  }

  get loopLevel(): number { return this.#loopLevel; }

  // -------------------------------------------------------------------------
  // The file source
  //
  // A DI take played through the same chain is how someone with no interface
  // hears the product at all, and how two captures are compared on the same
  // performance. The chain plays it — there is no second path.

  /**
   * The take that ships with the product. Fetched on demand: it is 1.6 MB,
   * and the page must not pay for it before anyone asks.
   */
  async loadDemoTake(): Promise<AudioBuffer> {
    // Versioned so a cached 404 from GitHub Pages cannot outlive a deployment.
    const response = await fetch(`${BASE}di/demo-di.wav?v=riff-a-1`);
    if (!response.ok) throw new Error('the demo take is not installed');
    return this.#adoptFile(await response.arrayBuffer());
  }

  /** Decodes a file. Works before the engine is started. */
  async loadFile(file: File): Promise<AudioBuffer> {
    return this.#adoptFile(await file.arrayBuffer());
  }

  async #adoptFile(bytes: ArrayBuffer): Promise<AudioBuffer> {
    // Whatever was playing was the take this replaces.
    this.#stopFile();
    const host = this.#host;
    const buffer = await decodeAt(bytes, host?.sampleRate ?? 48_000);
    this.#fileBytes = bytes;
    this.#buffer = buffer;
    this.#fileCursor = 0;
    if (host !== null && this.#host === host) {
      host.send('tc_file_load', [Math.min(2, buffer.numberOfChannels)], planar(buffer));
    }
    return buffer;
  }

  async setSource(source: Source): Promise<void> {
    if (source === this.#source) return;
    this.#source = source;
    const host = this.#host;
    if (host === null) return;
    if (source === 'live') this.#stopFile();
    // The browser releases the microphone for a file and opens it again for
    // live; Tonecraft Engine's input simply stops being read.
    await this.#web?.setLive(source === 'live');
    host.send('tc_set_source', [source === 'file' ? 1 : 0]);
    this.#syncLive();
  }

  setLoop(loop: boolean): void {
    this.#fileLoop = loop;
    this.#host?.send('tc_file_loop', [loop ? 1 : 0]);
  }

  playFile(from?: number): void {
    const host = this.#host;
    const buffer = this.#buffer;
    if (host === null || buffer === null) return;
    // Loading can outlive the click that asked for it; resume from this one.
    host.resume();
    let at = clamp(from ?? this.#fileCursor, 0, buffer.duration);
    if (at >= buffer.duration - 1e-3) at = 0;   // restarting from the end starts over
    host.send('tc_file_loop', [this.#fileLoop ? 1 : 0]);
    host.send('tc_file_play', [Math.round(at * buffer.sampleRate)]);
    this.#filePlaying = true;
    this.#fileCursor = at;
    this.#playAskedAt = performance.now();
  }

  stopFile(): void { this.#stopFile(); }

  #stopFile(): void {
    if (!this.#filePlaying) return;
    this.#fileCursor = this.filePosition;
    this.#filePlaying = false;
    this.#host?.send('tc_file_stop');
  }

  /** Where the take is, as the chain last reported it. */
  get filePosition(): number {
    return clamp(this.#fileCursor, 0, this.fileDuration);
  }

  seekFile(seconds: number): void {
    const buffer = this.#buffer;
    if (buffer === null) return;
    const at = clamp(seconds, 0, buffer.duration);
    if (this.#filePlaying) this.playFile(at);
    else this.#fileCursor = at;
  }
}

