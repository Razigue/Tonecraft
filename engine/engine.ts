/**
 * Main-thread side of the engine: it builds the graph, opens the input, hands
 * the WASM bytes and the capture to the worklets, and reads metering back.
 *
 * The chain, in order:
 *
 *     source (live DI or an audio file)
 *       -> frontend worklet     channel choice, trim, noise gate, TS boost (4x)
 *       -> NAM worklet          the amplifier itself, WebAssembly
 *       -> capture trim         measured offline, so captures match each other
 *       -> cabinet              ConvolverNode, synthesised minimum-phase IR
 *       -> four-band correction native biquads, post-cabinet
 *       -> reverb, in parallel  connected only while its mix is above zero
 *       -> master
 *       -> output worklet       limiter (zero latency) and the output meter
 *
 * Nothing in this graph adds latency of its own: the worklets run inside the
 * render quantum, and biquads and convolvers are measured at zero delay. The
 * limiter used to be a WaveShaperNode at 4x, which Chromium delays by 192
 * frames — 4 ms at 48 kHz. It is now sample-by-sample inside the output
 * worklet (scripts/measure-latency.mjs is the measurement).
 *
 * A NAM capture is a frozen snapshot of one amplifier at one setting. Its own
 * gain, channel and EQ are baked in and cannot be driven from here — what is
 * set here is what we send into it and what we do with what comes out. The
 * capture and the cabinet are the two real tone choices.
 *
 * The main thread owns state; the worklets own nothing (AD-11). Metering is a
 * measurement, not state, and it flows one way (AD-12).
 */

import { PARAMS } from '../schema/params.ts';
import { makeCabIR, makeReverbIR, DEFAULT_CAB } from './ir.ts';
import { loadCatalog, EMPTY_CATALOG, type Catalog, type Capture } from './catalog.ts';
import { openInput, InputError, type DeviceKind, classifyDevice } from './input.ts';
import {
  judgeLatency, judgeDropouts, jitterOf, judgeInput,
  type LatencyVerdict, type DropoutVerdict, type JitterStats, type InputVerdict,
} from './diagnosis.ts';

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
   * Called once, if the NAM engine itself fails to come up. Distinct from a
   * capture failing: when the engine is dead every capture will fail, and the
   * chain passes the dry signal through while looking and sounding alive.
   */
  onEngineError?: (message: string) => void;
}

export type EngineFailure =
  | { kind: 'no-input-device' }
  | { kind: 'permission-denied' }
  | { kind: 'engine-missing' }
  | { kind: 'engine-broken'; detail: string };

export class EngineError extends Error {
  constructor(readonly failure: EngineFailure, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

// Resolved against the deployment's base, because GitHub Pages serves a project
// repository under /<repo>/ and an absolute path would 404 there.
const BASE = import.meta.env.BASE_URL;

/** Which captured channel feeds the chain. `follow` picks whichever has signal. */
export type InputChannel = 'left' | 'right' | 'sum' | 'follow';

const CHANNEL_CODE: Record<InputChannel, number> = {
  left: 0, right: 1, sum: -1, follow: -2,
};

export type Source = 'live' | 'file';

export interface InputDevice {
  readonly id: string;
  readonly label: string;
  readonly kind: DeviceKind;
}

/**
 * The catalogue, without an engine. It is only JSON, and the selectors have to
 * be populated and honest before anything is powered up.
 */
export function readCatalog(): Promise<Catalog> {
  return loadCatalog(BASE);
}

const dbToLinear = (db: number): number => Math.pow(10, db / 20);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * The boost's pre-clip gain, in dB, as the worklet's 0..1 amount.
 *
 * The wire format carries engineering units and nothing else (AD-9), and the
 * worklet's `boost` control is one macro over gain, blend and make-up. The
 * conversion is the inverse of the gain law inside it: `1 + 24 * amount`.
 */
const boostAmount = (db: number): number => clamp((dbToLinear(db) - 1) / 24, 0, 1);

/**
 * The boost's tone control, in Hz, as the worklet's 0..1 amount. Inverse of the
 * one-pole's cutoff law there: `5200 * (0.35 + 1.3 * amount)`.
 */
const boostTone = (hz: number): number => clamp((hz / 5200 - 0.35) / 1.3, 0, 1);

interface Nodes {
  bus: GainNode;
  frontend: AudioWorkletNode;
  nam: AudioWorkletNode;
  trim: GainNode;
  cab: ConvolverNode;
  bass: BiquadFilterNode;
  mid: BiquadFilterNode;
  treble: BiquadFilterNode;
  presence: BiquadFilterNode;
  lowcut: BiquadFilterNode;
  /** Everything the chain did, in one place, so the A/B can mute it. */
  chain: GainNode;
  /** The raw input, level-matched, for the A/B. */
  direct: GainNode;
  dry: GainNode;
  reverb: ConvolverNode;
  wet: GainNode;
  master: GainNode;
  /** The output stage: the limiter, always on, and the meter behind it. */
  meter: AudioWorkletNode;
}

export interface OutputDevice {
  readonly id: string;
  readonly label: string;
  /**
   * What this device adds on the way out, in ms, measured rather than assumed.
   * `undefined` when it has not been probed or would not open.
   */
  readonly outputMs?: number;
}

export class Engine {
  #context: AudioContext | null = null;
  #nodes: Nodes | null = null;
  #stream: MediaStream | null = null;
  #liveSource: MediaStreamAudioSourceNode | null = null;

  #deviceKind: DeviceKind = 'unknown';
  #deviceLabel = '';
  #deviceId: string | undefined;
  #channel: InputChannel = 'follow';
  #channels = 1;

  #catalog: Catalog = EMPTY_CATALOG;
  #capture: Capture | null = null;
  #cab = DEFAULT_CAB;

  #source: Source = 'live';
  #direct = false;
  #buffer: AudioBuffer | null = null;
  #fileNode: AudioBufferSourceNode | null = null;
  #filePlaying = false;
  #fileLoop = true;
  #fileOffset = 0;
  #fileStartedAt = 0;
  #fileCursor = 0;

  #startedAt = 0;
  #firstAudioAt: number | null = null;
  #dropouts = 0;
  #peak = 0;
  #brightness = 0;
  #meterArrivals: number[] = [];
  #values = new Map<string, number>();
  #pendingLoad: { file: string; resolve: (ok: boolean) => void; timer: number } | null = null;

  /**
   * Set once the NAM engine reports it cannot run. It is latched because every
   * later load would otherwise sit on the 15 second timeout below, one after
   * another, while the interface says nothing.
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

  get context(): AudioContext | null { return this.#context; }
  /** Why the NAM engine is not running, or null if it is. */
  get engineError(): string | null { return this.#engineError; }
  get running(): boolean { return this.#context !== null; }
  get catalog(): Catalog { return this.#catalog; }
  get capture(): Capture | null { return this.#capture; }
  get cab(): string { return this.#cab; }
  get source(): Source { return this.#source; }
  get inputChannel(): InputChannel { return this.#channel; }
  get channelCount(): number { return this.#channels; }
  get fileLoaded(): boolean { return this.#buffer !== null; }
  get filePlaying(): boolean { return this.#filePlaying; }
  get fileDuration(): number { return this.#buffer?.duration ?? 0; }

  /** The catalogue can be read before anything is started — it is only JSON. */
  async loadCatalog(): Promise<Catalog> {
    this.#catalog = await loadCatalog(BASE);
    return this.#catalog;
  }

  /**
   * Round trip, as the browser reports it (FR-35). Shown permanently, never
   * used to decide anything: quality never adapts to the machine (AD-5).
   */
  get roundTripMs(): number | null {
    const ctx = this.#context;
    if (ctx === null) return null;
    const output = 'outputLatency' in ctx ? ctx.outputLatency : 0;
    return (ctx.baseLatency + output) * 1000;
  }

  /**
   * The two halves of that figure, in ms. `base` is the render buffer the
   * browser chose for `latencyHint: 0`; `output` is what the operating system
   * and the device add on the way out. Neither includes the input path, which
   * the Web Audio API does not expose.
   */
  get latencyParts(): { readonly base: number; readonly output: number } | null {
    const ctx = this.#context;
    if (ctx === null) return null;
    return {
      base: ctx.baseLatency * 1000,
      output: ('outputLatency' in ctx ? ctx.outputLatency : 0) * 1000,
    };
  }

  /**
   * Blocks the audio thread did not render in time, counted by the output
   * worklet since start (AD-12: the worklet is the only detector). Cheap to
   * read every metering frame, unlike `health`.
   */
  get dropoutCount(): number {
    return this.#dropouts;
  }

  /** The whole picture, judged. No verdict here refuses anything (FR-37). */
  get health(): Health | null {
    const ms = this.roundTripMs;
    if (ms === null) return null;
    const elapsed = (performance.now() - this.#startedAt) / 1000;
    const intervals: number[] = [];
    for (let i = 1; i < this.#meterArrivals.length; i += 1) {
      intervals.push(this.#meterArrivals[i]! - this.#meterArrivals[i - 1]!);
    }
    return {
      latency: judgeLatency(ms, this.#deviceKind),
      dropouts: judgeDropouts(this.#dropouts, elapsed),
      jitter: jitterOf(intervals),
      input: judgeInput({
        deviceKind: this.#deviceKind,
        deviceLabel: this.#deviceLabel,
        roundTripMs: ms,
        peak: this.#peak,
        brightness: this.#brightness,
      }),
      timeToFirstNoteMs:
        this.#firstAudioAt === null ? null : this.#firstAudioAt - this.#startedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Starting and stopping

  /**
   * Must be called from a user gesture — the autoplay policy will not create a
   * running context otherwise.
   */
  async start(): Promise<void> {
    if (this.#context !== null) return;
    // NFR-3 measures from the gesture, not from when the engine happens to be
    // ready: the permission prompt is part of what the player waits through.
    this.#startedAt = performance.now();
    if (this.#catalog.models.length === 0) await this.loadCatalog();

    // Read the device's rate BEFORE the context exists, then create the context
    // at exactly that rate. Letting the browser resample implicitly costs both
    // latency and quality, and neither is visible from here (FR-9).
    let rate: number | undefined;
    if (this.#source === 'live') {
      const stream = await this.#open();
      this.#stream = stream;
      const track = stream.getAudioTracks()[0];
      if (track === undefined) {
        throw new EngineError({ kind: 'no-input-device' }, 'No audio track on the input stream.');
      }
      this.#adopt(track);
      rate = track.getSettings().sampleRate;
    }

    // The output device, decided before the context exists because Chromium
    // takes it in the constructor and moving it afterwards rebuilds the output
    // stream. See #pickOutput for why it follows the input.
    const sinkId = await this.#pickOutput();

    // `latencyHint: 0` asks for the smallest buffer the device offers. Not
    // 'interactive', which is more conservative than we want.
    const options = {
      latencyHint: 0,
      ...(rate === undefined ? {} : { sampleRate: rate }),
    } as AudioContextOptions;
    let context: AudioContext;
    try {
      // `sinkId` is in the specification and in Chromium; the lib typings
      // this project compiles against do not carry it yet.
      context = new AudioContext(
        sinkId === undefined ? options : ({ ...options, sinkId } as AudioContextOptions),
      );
    } catch {
      // An output the browser will not open: the default is better than no
      // engine at all, and the round trip on screen says which one is in use.
      this.#sinkId = undefined;
      context = new AudioContext(options);
    }
    this.#context = context;
    await context.resume();

    // The bytes are fetched here and handed over. A worklet scope has no fetch,
    // and no business doing I/O anyway (AD-13). The request goes out before the
    // worklet modules load, so the two wait on the network together rather
    // than one after the other: time to first note, not latency.
    const wasmRequest = fetch(`${BASE}nam/nam.wasm`);

    // Order matters: nam-glue.js puts createNamModule in the worklet's global
    // scope, and nam-processor.js reads it from there.
    try {
      await context.audioWorklet.addModule(`${BASE}nam/frontend-worklet.js`);
      await context.audioWorklet.addModule(`${BASE}nam/nam-glue.js`);
      await context.audioWorklet.addModule(`${BASE}nam/nam-processor.js`);
      await context.audioWorklet.addModule(`${BASE}nam/output-worklet.js`);
    } catch (cause) {
      throw new EngineError(
        { kind: 'engine-broken', detail: String(cause) },
        'The audio engine could not be loaded. Reload the page; if it persists ' +
        'the build is incomplete.',
      );
    }

    const response = await wasmRequest;
    if (!response.ok) {
      // Without this the worklet would try to instantiate a 404 page and the UI
      // would sit on "Starting" forever with nothing said. Silence is the one
      // failure mode this product must not have.
      throw new EngineError(
        { kind: 'engine-missing' },
        'The NAM engine is missing. Run `npm run vendor` and reload.',
      );
    }
    const wasmBinary = await response.arrayBuffer();

    this.#nodes = this.#build(context, wasmBinary);
    this.#wireSource();
    this.setInputChannel(this.#channel);
    this.setDirect(this.#direct);
    this.#applyAll();

    const capture = this.#capture ?? this.#catalog.models[0] ?? null;
    if (capture !== null) await this.setCapture(capture.file);
  }

  async stop(): Promise<void> {
    this.#stopFile();
    this.#stream?.getTracks().forEach((t) => t.stop());
    await this.#context?.close();
    this.#stream = null;
    this.#liveSource = null;
    this.#nodes = null;
    this.#reverbWired = false;
    this.#context = null;
    // An output the rule picked belongs to the input it followed; a chosen one
    // belongs to the player and survives.
    if (!this.#sinkChosen) this.#sinkId = undefined;
    this.#dropouts = 0;
    this.#meterArrivals = [];
    this.#firstAudioAt = null;
    this.#engineError = null;
  }

  #build(context: AudioContext, wasmBinary: ArrayBuffer): Nodes {
    const mono = {
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    } as const;

    const bus = new GainNode(context, { gain: 1 });

    const frontend = new AudioWorkletNode(context, 'frontend', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      // Without these the node applies the default 'speakers' mixing rules,
      // which fold a two-channel capture down to one before the processor ever
      // sees it — and then choosing a channel is choosing between two copies of
      // the same mixed signal. A Scarlett Solo's XLR and instrument jack are
      // two separate inputs, not a stereo pair to be mixed.
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    frontend.port.onmessage = (event: MessageEvent): void => this.#onFrontendMessage(event.data);

    const nam = new AudioWorkletNode(context, 'nam', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      ...mono,
      processorOptions: { wasmBinary },
    });
    nam.port.onmessage = (event: MessageEvent): void => this.#onNamMessage(event.data);

    const trim = new GainNode(context, { gain: 1 });
    const cab = new ConvolverNode(context, { disableNormalization: true });

    // Post-cabinet correction. The frequencies are the classic four-band amp
    // layout, not a parametric: they are fixed and only their gains move.
    const bass = new BiquadFilterNode(context, { type: 'lowshelf', frequency: 110 });
    const mid = new BiquadFilterNode(context, { type: 'peaking', frequency: 650, Q: 0.9 });
    const treble = new BiquadFilterNode(context, { type: 'highshelf', frequency: 2600 });
    const presence = new BiquadFilterNode(context, { type: 'highshelf', frequency: 4200 });
    // Below the low E there is nothing but cone excursion and rumble.
    const lowcut = new BiquadFilterNode(context, { type: 'highpass', frequency: 55, Q: 0.707 });

    const chain = new GainNode(context, { gain: 1 });
    const direct = new GainNode(context, { gain: 0 });
    const dry = new GainNode(context, { gain: 1 });
    const reverb = new ConvolverNode(context, { disableNormalization: true });
    const wet = new GainNode(context, { gain: 0 });
    reverb.buffer = makeReverbIR(context, 1.3);

    const master = new GainNode(context, { gain: 0.5 });

    // The limiter lives inside this worklet, sample by sample: a WaveShaperNode
    // at 4x costs 192 frames of latency in Chromium (measured), for a stage
    // that is transparent nearly all of the time.
    const meter = new AudioWorkletNode(context, 'output-meter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      ...mono,
    });
    meter.port.onmessage = (event: MessageEvent): void => this.#onOutputMessage(event.data);

    bus.connect(frontend);
    frontend.connect(nam);
    nam.connect(trim);
    trim.connect(cab);
    cab.connect(bass);
    bass.connect(mid);
    mid.connect(treble);
    treble.connect(presence);
    presence.connect(lowcut);

    lowcut.connect(chain);
    chain.connect(dry);
    // chain -> reverb is wired by #wireReverb, only while the mix is above
    // zero: a ConvolverNode with a live input renders its whole 1.3 s tail on
    // every quantum whether or not anything listens, and on a weak machine
    // that is CPU spent on silence.
    reverb.connect(wet);
    dry.connect(master);
    wet.connect(master);

    /* The A/B tap, taken at the very front — before the trim, the gate and the
       boost — because the question it answers is "what does this do to my
       guitar", and half an answer is worse than none. It rejoins at the master
       so the volume fader and the limiter still apply to both. */
    bus.connect(direct);
    direct.connect(master);

    master.connect(meter);
    meter.connect(context.destination);

    const nodes: Nodes = {
      bus, frontend, nam, trim, cab, bass, mid, treble, presence, lowcut,
      chain, direct, dry, reverb, wet, master, meter,
    };
    nodes.cab.buffer = makeCabIR(context, this.#cab);
    return nodes;
  }

  #reverbWired = false;

  /**
   * Connects the reverb only while it is audible.
   *
   * Disconnecting is safe mid-note: a convolver keeps rendering its tail after
   * its input goes away, and the wet gain is already fading, so nothing is
   * cut. Once the tail is out the browser stops calling the node at all. On
   * the way back in, the connection is made before the gain rises.
   */
  #wireReverb(on: boolean): void {
    const nodes = this.#nodes;
    if (nodes === null || on === this.#reverbWired) return;
    this.#reverbWired = on;
    if (on) nodes.chain.connect(nodes.reverb);
    else nodes.chain.disconnect(nodes.reverb);
  }

  // -------------------------------------------------------------------------
  // Metering

  #onFrontendMessage(data: {
    in: number; out: number; gate: number; brightness: number;
    channels: number; channelPeaks: number[]; following: number;
  }): void {
    this.#peak = data.in;
    this.#brightness = data.brightness;
    /* `data.channels` is always two: the node is configured `explicit` at two
       channels so a two-input interface cannot be folded down before we choose
       between its inputs, which means a mono device arrives up-mixed with a
       silent second channel. The count that decides whether there is a choice
       to offer is therefore the device's own, taken from the track. */

    const now = performance.now();
    // A rolling window: jitter is a property of how things are going now, not
    // an average over the whole session.
    this.#meterArrivals.push(now);
    if (this.#meterArrivals.length > 90) this.#meterArrivals.shift();
    // First audible note: the first frame carrying real signal, not the first
    // frame at all — silence is not a note.
    if (this.#firstAudioAt === null && data.in > 0.01) this.#firstAudioAt = now;

    this.#onMeters?.({
      input: data.in,
      drive: data.out,
      output: this.#lastOutPeak,
      outputRms: this.#lastOutRms,
      gate: data.gate,
      channelPeaks: data.channelPeaks.slice(0, Math.max(1, this.#channels)),
      channels: this.#channels,
    });
  }

  #lastOutPeak = 0;
  #lastOutRms = 0;

  #onOutputMessage(data: { peak: number; rms: number; dropouts: number }): void {
    this.#lastOutPeak = data.peak;
    this.#lastOutRms = data.rms;
    this.#dropouts = data.dropouts;
  }

  #onNamMessage(data: { type: string; ok?: boolean; file?: string; message?: string }): void {
    if (data.type === 'modelLoaded') {
      const pending = this.#pendingLoad;
      if (pending !== null && pending.file === data.file) {
        clearTimeout(pending.timer);
        this.#pendingLoad = null;
        pending.resolve(data.ok === true);
      }
      this.#onModel?.(data.file ?? '', data.ok === true);
    } else if (data.type === 'error') {
      // This arrives from the worklet's own initialisation, usually before any
      // capture has been asked for, so there is nothing pending to reject — and
      // that is exactly how it used to go unnoticed.
      this.#engineError = data.message ?? 'the NAM engine did not start';
      const pending = this.#pendingLoad;
      if (pending !== null) {
        clearTimeout(pending.timer);
        this.#pendingLoad = null;
        pending.resolve(false);
      }
      this.#onModel?.('', false);
      this.#onEngineError?.(this.#engineError);
    }
  }

  // -------------------------------------------------------------------------
  // Tone

  /**
   * Loads a capture, and waits for the worklet to confirm it.
   *
   * Waiting matters: if the engine quietly fails, the chain passes the raw DI
   * through, which sounds bad and looks like nothing at all. Confirmation is
   * the difference between a stated failure and a mystery.
   */
  async setCapture(file: string): Promise<boolean> {
    const capture = this.#catalog.models.find((m) => m.file === file);
    if (capture === undefined) return false;
    this.#capture = capture;

    const nodes = this.#nodes;
    const ctx = this.#context;
    if (nodes === null || ctx === null) return false;
    // Fail immediately rather than waiting out the timeout below: with the
    // engine down, no capture is ever going to answer.
    if (this.#engineError !== null) return false;

    const response = await fetch(`${BASE}models/${encodeURIComponent(file)}`);
    if (!response.ok) return false;
    const json = await response.text();

    const settled = new Promise<boolean>((resolve) => {
      // A load that never answers must not leave the UI waiting forever.
      const timer = self.setTimeout(() => {
        if (this.#pendingLoad?.file === file) {
          this.#pendingLoad = null;
          resolve(false);
        }
      }, 15_000);
      this.#pendingLoad = { file, resolve, timer };
    });

    nodes.nam.port.postMessage({ type: 'model', json, name: capture.name, file });
    // Trim measured offline by scripts/calibrate-models.mjs, through the
    // cabinet, because the cabinet is what sets the perceived level.
    nodes.trim.gain.setTargetAtTime(dbToLinear(capture.trimDb), ctx.currentTime, 0.05);
    return settled;
  }

  /**
   * Makeup gain on the direct path, in dB.
   *
   * Measured, not guessed: the demo take through the shipped preset against the
   * same take raw, both seeked to zero first and integrated over fourteen
   * seconds off the output meter. Re-measured whenever the default preset
   * changes — it moved 1.6 dB when the default became "Lead", which carries 8
   * more decibels of boost — and whenever the take changes, which is what has
   * moved it 10.2 dB across three takes today: the direct path *is* the take,
   * so its level is the take's level. Repeatable to a tenth of a dB — measuring
   * it without seeking first put 1.8 dB of the take's own dynamics into the
   * answer, because the two passes were covering different notes.
   *
   * npm run test:browser is what measures it: the check that the two sides are
   * within 1.5 dB prints the offset either way, so a stale number here shows up
   * as the amount to add rather than as a bare failure.
   *
   * Without this the A/B is a loudness test, and louder wins every loudness test
   * regardless of what it sounds like.
   *
   * It is one number for one preset, so it drifts as the master or the preset
   * moves — the alternative is matching the loudness continuously, which is a
   * compressor nobody asked for sitting across the only honest comparison in
   * the product.
   */
  static readonly DIRECT_MAKEUP_DB = 16.5;

  /**
   * The whole simulation, on or off.
   *
   * Off means off: the chain is muted **and the live input is closed**. Leaving
   * the input open would monitor whatever the machine is listening to — on a
   * laptop that is the built-in microphone, straight back out of the speakers,
   * which is a feedback path rather than a comparison. What is left is the file,
   * raw, which is the point: the same DI, once through Tonecraft and once not.
   *
   * The consequence is deliberate and worth stating: with the live input as the
   * source there is nothing to hear while this is off. The interface says so
   * rather than leaving the silence to be puzzled over.
   *
   * Crossfaded rather than switched: a hard cut clicks, and a click is the
   * loudest thing in an A/B.
   */
  setDirect(direct: boolean): void {
    this.#direct = direct;
    const nodes = this.#nodes;
    const ctx = this.#context;
    if (nodes === null || ctx === null) return;
    const now = ctx.currentTime;
    nodes.chain.gain.setTargetAtTime(direct ? 0 : 1, now, 0.02);
    nodes.direct.gain.setTargetAtTime(
      direct ? dbToLinear(Engine.DIRECT_MAKEUP_DB) : 0, now, 0.02,
    );
    this.#setLiveOpen(!direct);
  }

  /**
   * Opens or closes the live capture.
   *
   * `enabled = false` stops the browser delivering samples at the source, which
   * is what makes this an input that is actually off rather than one that is
   * merely turned down. The track is not stopped: stopping releases the device
   * and reopening it costs a few hundred milliseconds, which is far too slow
   * for a control meant to be flipped a dozen times in a row.
   */
  #setLiveOpen(open: boolean): void {
    const nodes = this.#nodes;
    if (nodes === null) return;
    this.#stream?.getAudioTracks().forEach((track) => { track.enabled = open; });
    const source = this.#liveSource;
    if (source === null) return;
    try {
      if (open) source.connect(nodes.bus);
      else source.disconnect(nodes.bus);
    } catch {
      // Disconnecting something that is not connected throws; nothing to fix.
    }
  }

  /** True when the live input is muted because the simulation is off. */
  get liveMuted(): boolean {
    return this.#direct && this.#source === 'live';
  }

  get direct(): boolean { return this.#direct; }

  /** Instant: the IR is synthesised in a few milliseconds, no file to fetch. */
  setCab(id: string): void {
    this.#cab = id;
    const nodes = this.#nodes;
    const ctx = this.#context;
    if (nodes === null || ctx === null) return;
    nodes.cab.buffer = makeCabIR(ctx, id);
  }

  /** Continuous values go through AudioParam so they interpolate (FR-19, AD-20). */
  setParam(id: string, value: number): void {
    this.#values.set(id, value);
    this.#apply(id);
  }

  value(id: string): number {
    return this.#values.get(id) ?? 0;
  }

  #applyAll(): void {
    for (const p of PARAMS) if (p.deprecated !== true) this.#apply(p.id);
  }

  #apply(id: string): void {
    const nodes = this.#nodes;
    const ctx = this.#context;
    if (nodes === null || ctx === null) return;
    const now = ctx.currentTime;
    // 20 ms: fast enough to follow the hand, slow enough to never zipper.
    const T = 0.02;
    const v = (name: string): number => this.#values.get(name) ?? 0;
    const on = (name: string): boolean => v(name) < 0.5;

    switch (id) {
      case 'in_trim':
        nodes.frontend.parameters.get('inputGain')!
          .setTargetAtTime(dbToLinear(v('in_trim')), now, T);
        break;

      case 'gate_threshold':
      case 'gate_bypass':
        // -100 is the worklet's "off": no threshold, no gating at all.
        nodes.frontend.parameters.get('gate')!
          .setTargetAtTime(on('gate_bypass') ? v('gate_threshold') : -100, now, T);
        break;

      case 'drive_gain':
      case 'drive_tone':
      case 'drive_bypass': {
        const amount = on('drive_bypass') ? boostAmount(v('drive_gain')) : 0;
        nodes.frontend.parameters.get('boost')!.setTargetAtTime(amount, now, T);
        nodes.frontend.parameters.get('boostTone')!
          .setTargetAtTime(boostTone(v('drive_tone')), now, T);
        break;
      }

      case 'tone_bass':
      case 'tone_mid':
      case 'tone_treble':
      case 'tone_presence':
      case 'tone_bypass': {
        const flat = !on('tone_bypass');
        nodes.bass.gain.setTargetAtTime(flat ? 0 : v('tone_bass'), now, T);
        nodes.mid.gain.setTargetAtTime(flat ? 0 : v('tone_mid'), now, T);
        nodes.treble.gain.setTargetAtTime(flat ? 0 : v('tone_treble'), now, T);
        nodes.presence.gain.setTargetAtTime(flat ? 0 : v('tone_presence'), now, T);
        break;
      }

      case 'reverb_mix':
      case 'reverb_bypass': {
        const mix = on('reverb_bypass') ? v('reverb_mix') : 0;
        this.#wireReverb(mix > 0);
        // The dry side comes down as the wet goes up, so the total stays put.
        nodes.wet.gain.setTargetAtTime(mix * 0.8, now, T);
        nodes.dry.gain.setTargetAtTime(1 - mix * 0.35, now, T);
        break;
      }

      case 'out_master':
      case 'out_mute':
        nodes.master.gain.setTargetAtTime(
          on('out_mute') ? dbToLinear(v('out_master')) : 0, now, T,
        );
        break;

      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Input

  /** Labels are blank until permission has been granted at least once. */
  async listInputs(): Promise<InputDevice[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ id: d.deviceId, label: d.label, kind: classifyDevice(d.label) }));
  }

  // -------------------------------------------------------------------------
  // Output
  //
  // Where the sound comes out is chosen, not left to the browser's default.
  // By default it follows the input: a guitarist with an interface has their
  // headphones plugged into *it*, and the browser's default output is the
  // laptop's speakers. Two things are gained beyond the obvious one:
  //
  //   - one clock. Input and output on different devices drift, and the
  //     browser hides the drift by resampling through a FIFO that grows and
  //     shrinks — which is jitter, the failure CLAUDE.md says matters more
  //     than the absolute figure;
  //   - an honest number. `outputLatency` describes the device the context is
  //     on, so the round trip on screen is the one through the headphones.
  //
  // Firefox has no `setSinkId` on AudioContext (NFR-11): there the default
  // output stands, and nothing is said about it.

  /** True where the output can be chosen at all. */
  static get canChooseOutput(): boolean {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  #sinkId: string | undefined;
  #sinkChosen = false;

  /** Empty until permission has been granted, like the inputs. */
  async listOutputs(): Promise<OutputDevice[]> {
    if (!Engine.canChooseOutput) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audiooutput')
      .map((d) => ({ id: d.deviceId, label: d.label }));
  }

  /**
   * The same list, with what each device costs on the way out.
   *
   * This is the only latency left worth a decision. Measured on this machine:
   * the chain adds 0.1 ms, `baseLatency` is one render quantum and cannot go
   * below it, and everything else in a 35 ms round trip is the output device's
   * own buffer — 32 of those 35. Which device the sound leaves by is therefore
   * not a preference, it is the latency setting, and until now the selector
   * offered it as a list of names with no way to tell them apart.
   *
   * Each candidate is opened as a silent context of its own, read, and closed.
   * Nothing is connected to them and the live graph is not touched, so the
   * sound does not move and the player hears nothing: measuring by calling
   * `setSinkId` on the running context would rebuild its output stream, which
   * is audible and changes what they are listening to.
   *
   * A device that will not open returns no number rather than a wrong one.
   */
  async probeOutputs(): Promise<OutputDevice[]> {
    const outputs = await this.listOutputs();
    if (outputs.length === 0) return outputs;

    // The rate the live context runs at, so the figure is the one the player
    // would actually get rather than one for a context they will never have.
    const sampleRate = this.#context?.sampleRate;
    const probed: OutputDevice[] = [];

    for (const device of outputs) {
      let ms: number | undefined;
      let probe: AudioContext | null = null;
      try {
        probe = new AudioContext({
          latencyHint: 0,
          ...(sampleRate === undefined ? {} : { sampleRate }),
          sinkId: device.id,
        } as AudioContextOptions);
        await probe.resume();
        /* `outputLatency` is zero until the output stream is actually up. One
           frame of the probe's own clock is enough and costs nothing audible,
           because nothing is connected to it. */
        await new Promise<void>((resolve) => { self.setTimeout(resolve, 120); });
        if ('outputLatency' in probe && probe.outputLatency > 0) {
          ms = probe.outputLatency * 1000;
        }
      } catch {
        // A device that has gone away, or one the browser refuses to open on.
      } finally {
        try { await probe?.close(); } catch { /* already gone */ }
      }
      probed.push(ms === undefined ? device : { ...device, outputMs: ms });
    }
    return probed;
  }

  /** The output in use: a device id, or '' for the browser's default. */
  get outputId(): string {
    return this.#sinkId ?? '';
  }

  /**
   * Chooses the output. An explicit choice sticks across device changes; ''
   * means the default, and hands the decision back to the input-following
   * rule on the next start.
   */
  async useOutput(id: string): Promise<void> {
    this.#sinkChosen = id !== '';
    this.#sinkId = id === '' ? undefined : id;
    await this.#applyOutput(id);
  }

  async #applyOutput(id: string): Promise<void> {
    const ctx = this.#context;
    if (ctx === null || !Engine.canChooseOutput) return;
    try {
      await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(id);
    } catch {
      // A device that has gone away, or one the browser refuses: the sound
      // keeps coming out where it was, which is better than not at all.
    }
  }

  /** Re-runs the input-following rule after the input changed. */
  async #followInput(): Promise<void> {
    if (this.#sinkChosen) return;
    const sink = await this.#pickOutput();
    await this.#applyOutput(sink ?? '');
  }

  /**
   * The output to build the context on. The player's explicit choice if there
   * is one; otherwise the output that shares hardware with the open input.
   * `groupId` is the browser's word for "the same physical device", and it is
   * only meaningful once permission has been granted — which it has, by the
   * time this runs on the live path.
   */
  async #pickOutput(): Promise<string | undefined> {
    if (!Engine.canChooseOutput) return undefined;
    let devices: MediaDeviceInfo[];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return this.#sinkChosen ? this.#sinkId : undefined;
    }
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    if (this.#sinkChosen) {
      // A remembered device that has since been unplugged must not take the
      // whole context down with it: the choice lapses and the rule takes over.
      if (outputs.some((d) => d.deviceId === this.#sinkId)) return this.#sinkId;
      this.#sinkChosen = false;
      this.#sinkId = undefined;
    }
    const track = this.#stream?.getAudioTracks()[0];
    const group = track?.getSettings().groupId;
    if (group === undefined || group === '') return undefined;
    this.#sinkId = outputs.find((d) => d.groupId === group)?.deviceId;
    return this.#sinkId;
  }

  /** Reopens the stream on another interface, keeping everything else. */
  async useDevice(deviceId: string): Promise<void> {
    this.#deviceId = deviceId;
    if (this.#context === null || this.#source !== 'live') return;
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#liveSource?.disconnect();
    this.#liveSource = null;
    const stream = await openInput(navigator.mediaDevices, deviceId);
    this.#stream = stream;
    const track = stream.getAudioTracks()[0];
    if (track !== undefined) this.#adopt(track);
    this.#wireSource();
    // A new interface means a new place for the headphones, unless the player
    // chose an output by hand.
    await this.#followInput();
  }

  /**
   * Instant: the capture already carries every channel, so this only changes
   * which one the worklet reads. Never part of the tone state — it describes
   * the player's hardware, not their tone.
   */
  setInputChannel(channel: InputChannel): void {
    this.#channel = channel;
    this.#nodes?.frontend.port.postMessage({
      type: 'input-channel',
      channel: CHANNEL_CODE[channel],
    });
  }

  #adopt(track: MediaStreamTrack): void {
    this.#deviceLabel = track.label;
    this.#deviceKind = classifyDevice(track.label);
    this.#channels = track.getSettings().channelCount ?? 1;
  }

  #wireSource(): void {
    const ctx = this.#context;
    const nodes = this.#nodes;
    if (ctx === null || nodes === null) return;
    if (this.#source === 'live' && this.#stream !== null) {
      this.#liveSource = new MediaStreamAudioSourceNode(ctx, { mediaStream: this.#stream });
      this.#liveSource.connect(nodes.bus);
      // Changing device while the simulation is off must not reopen the input.
      this.#setLiveOpen(!this.#direct);
    }
  }

  async #open(): Promise<MediaStream> {
    try {
      return await openInput(navigator.mediaDevices, this.#deviceId);
    } catch (cause) {
      if (cause instanceof InputError) {
        throw new EngineError({ kind: cause.reason }, cause.message);
      }
      throw cause;
    }
  }

  // -------------------------------------------------------------------------
  // The file source
  //
  // Playing a DI take through the same chain is how someone with no interface
  // hears the product at all, and how anyone compares two captures on the same
  // performance. It runs through the identical graph — there is no second path.

  /**
   * The take that ships with the product, so someone with no interface and no
   * guitar to hand can still hear what this does. Fetched on demand: it is 1.6
   * MB, and the page must not pay for it before anyone asks.
   */
  async loadDemoTake(): Promise<AudioBuffer> {
    const response = await fetch(`${BASE}di/demo-di.wav`);
    if (!response.ok) throw new Error('the demo take is not installed');
    const bytes = await response.arrayBuffer();
    // Whatever was playing was playing the buffer this replaces. Leaving it
    // running means the waveform shows one take while you hear another.
    this.#stopFile();
    const ctx = this.#context ?? new AudioContext();
    try {
      this.#buffer = await ctx.decodeAudioData(bytes);
      this.#fileCursor = 0;
      return this.#buffer;
    } finally {
      if (this.#context === null) await ctx.close();
    }
  }

  /** Decodes a file. Works before the engine is started. */
  async loadFile(file: File): Promise<AudioBuffer> {
    // As above: the take being replaced is the one currently playing.
    this.#stopFile();
    const ctx = this.#context ?? new AudioContext();
    try {
      this.#buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      this.#fileCursor = 0;
      return this.#buffer;
    } finally {
      if (this.#context === null) await ctx.close();
    }
  }

  async setSource(source: Source): Promise<void> {
    if (source === this.#source) return;
    this.#source = source;
    if (this.#context === null) return;

    if (source === 'file') {
      this.#stream?.getTracks().forEach((t) => t.stop());
      this.#liveSource?.disconnect();
      this.#stream = null;
      this.#liveSource = null;
    } else {
      this.#stopFile();
      this.#stream = await this.#open();
      const track = this.#stream.getAudioTracks()[0];
      if (track !== undefined) this.#adopt(track);
      this.#wireSource();
      this.#setLiveOpen(!this.#direct);
      await this.#followInput();
    }
  }

  setLoop(loop: boolean): void {
    this.#fileLoop = loop;
    if (this.#fileNode === null) return;
    // Re-anchor the clock: the position folded by the loop would be wrong.
    this.#fileOffset = this.filePosition;
    this.#fileStartedAt = this.#context?.currentTime ?? 0;
    this.#fileNode.loop = loop;
  }

  playFile(from?: number): void {
    const ctx = this.#context;
    const nodes = this.#nodes;
    const buffer = this.#buffer;
    if (ctx === null || nodes === null || buffer === null) return;

    let at = clamp(from ?? this.#fileCursor, 0, buffer.duration);
    if (at >= buffer.duration - 1e-3) at = 0;   // restarting from the end starts over
    this.#stopFile();

    const node = new AudioBufferSourceNode(ctx, { buffer, loop: this.#fileLoop });
    node.connect(nodes.bus);
    node.onended = (): void => {
      this.#filePlaying = false;
      this.#fileCursor = buffer.duration;
    };
    this.#fileNode = node;
    this.#fileOffset = at;
    this.#fileCursor = at;
    this.#fileStartedAt = ctx.currentTime;
    node.start(0, at);
    this.#filePlaying = true;
  }

  stopFile(): void { this.#stopFile(); }

  #stopFile(): void {
    const node = this.#fileNode;
    if (node !== null) {
      if (this.#filePlaying) this.#fileCursor = this.filePosition;
      // Otherwise stopping by hand looks like reaching the end of the take.
      node.onended = null;
      try { node.stop(); } catch { /* already stopped */ }
      node.disconnect();
      this.#fileNode = null;
    }
    this.#filePlaying = false;
  }

  /**
   * Playback position, reconstructed. An AudioBufferSourceNode exposes none,
   * and while looping it restarts without saying so, so the elapsed time is
   * folded back over the duration.
   */
  get filePosition(): number {
    const buffer = this.#buffer;
    const ctx = this.#context;
    if (buffer === null) return 0;
    if (!this.#filePlaying || ctx === null) return clamp(this.#fileCursor, 0, buffer.duration);
    let t = this.#fileOffset + (ctx.currentTime - this.#fileStartedAt);
    if (this.#fileLoop && buffer.duration > 0) t %= buffer.duration;
    return clamp(t, 0, buffer.duration);
  }

  seekFile(seconds: number): void {
    const buffer = this.#buffer;
    if (buffer === null) return;
    const at = clamp(seconds, 0, buffer.duration);
    if (this.#filePlaying) this.playFile(at);
    else this.#fileCursor = at;
  }
}
