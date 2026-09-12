/**
 * The browser host: one AudioContext, one AudioWorklet, the input.
 *
 *     live capture ─┐
 *                   ├─> chain-processor.js (chain.wasm) ─> destination
 *                   │            └─ tuner tap ─> analyser ─> silent sink
 *
 * That is the whole graph, and it is AD-1 at last: one processor holds the
 * chain. There is no ConvolverNode, no BiquadFilterNode and no second worklet
 * any more — the cabinet, the correction and the limiter are in the chain,
 * where the native engine runs them too.
 *
 * What stays here is what only a browser has to decide: the rate the context
 * is created at, which output it plays through, when the microphone is
 * released, and how an AnalyserNode feeds the tuner.
 */

import { openInput, InputError, classifyDevice, type DeviceKind } from './input.ts';
import {
  EngineError, type CallResult, type ChainHost, type HostEvents, type LatencyParts,
} from './chain-host.ts';

// Resolved against the deployment's base: GitHub Pages serves a project
// repository under /<repo>/, and an absolute path would 404 there.
const BASE = import.meta.env.BASE_URL;

/** A call the worklet has not answered in this long is not going to be. */
const CALL_TIMEOUT_MS = 15_000;
const TUNER_FFT = 8192;

export interface InputDevice {
  readonly id: string;
  readonly label: string;
  readonly kind: DeviceKind;
}

export interface OutputDevice {
  readonly id: string;
  readonly label: string;
  /** What this device adds on the way out, in ms, measured. Absent when unprobed. */
  readonly outputMs?: number;
}

/** Labels are blank until permission has been granted at least once. */
export async function listInputs(): Promise<InputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ id: d.deviceId, label: d.label, kind: classifyDevice(d.label) }));
}

/** True where the output can be chosen at all. Firefox has no setSinkId on AudioContext. */
export function canChooseOutput(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

/** Empty until permission has been granted, like the inputs. */
export async function listOutputs(): Promise<OutputDevice[]> {
  if (!canChooseOutput()) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'audiooutput')
    .map((d) => ({ id: d.deviceId, label: d.label }));
}

/**
 * The outputs, each with what it costs on the way out.
 *
 * The only latency left worth a decision: the chain adds nothing, the render
 * buffer is one quantum, and nearly all of the rest is the output device's own
 * buffer. Each candidate is opened as a silent context of its own, read and
 * closed; the live graph is not touched, so nothing the player hears moves.
 * A device that will not open returns no number rather than a wrong one.
 */
export async function probeOutputs(sampleRate: number | undefined): Promise<OutputDevice[]> {
  const outputs = await listOutputs();
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
      // `outputLatency` is zero until the output stream is actually up.
      await new Promise<void>((resolve) => { self.setTimeout(resolve, 120); });
      if ('outputLatency' in probe && probe.outputLatency > 0) ms = probe.outputLatency * 1000;
    } catch {
      // A device that has gone away, or one the browser refuses to open on.
    } finally {
      try { await probe?.close(); } catch { /* already gone */ }
    }
    probed.push(ms === undefined ? device : { ...device, outputMs: ms });
  }
  return probed;
}

export interface WebPrefs {
  readonly deviceId: string | undefined;
  /** An output the player chose by hand; undefined lets it follow the input. */
  readonly sinkId: string | undefined;
}

type WorkletMessage =
  | { type: 'ready'; sampleRate: number }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; value: number; error?: string; data?: Uint8Array<ArrayBuffer> }
  | { type: 'meters'; meters: Float32Array; dropouts: number };

export class WebHost implements ChainHost {
  readonly kind = 'browser' as const;
  readonly tunerBufferSize = TUNER_FFT;

  readonly #events: HostEvents;
  #ctx: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #stream: MediaStream | null = null;
  #live: MediaStreamAudioSourceNode | null = null;
  #tuner: AnalyserNode | null = null;
  #captureOpen = true;
  #pending = new Map<number, { resolve: (r: CallResult) => void; timer: number }>();
  #nextId = 1;
  #ready: { resolve: () => void; reject: (e: Error) => void } | null = null;

  #deviceId: string | undefined;
  #sinkId: string | undefined;
  #sinkChosen: boolean;

  deviceKind: DeviceKind = 'unknown';
  deviceLabel = '';
  /** Channels the device delivers — the node itself always takes two. */
  channels = 1;

  constructor(events: HostEvents, prefs: WebPrefs) {
    this.#events = events;
    this.#deviceId = prefs.deviceId;
    this.#sinkId = prefs.sinkId;
    this.#sinkChosen = prefs.sinkId !== undefined;
  }

  get sampleRate(): number { return this.#ctx?.sampleRate ?? 48_000; }
  /** The output in use: a device id, or '' for the browser's default. */
  get outputId(): string { return this.#sinkId ?? ''; }

  /**
   * Must run inside a user gesture: the autoplay policy will not create a
   * running context otherwise.
   */
  async start(live: boolean): Promise<void> {
    // The device's rate BEFORE the context exists, and the context at exactly
    // that rate. An implicit resampler costs latency and quality (FR-9).
    let rate: number | undefined;
    if (live) {
      const stream = await this.#open();
      this.#stream = stream;
      const track = stream.getAudioTracks()[0];
      if (track === undefined) {
        throw new EngineError({ kind: 'no-input-device' }, 'No audio track on the input stream.');
      }
      this.#adopt(track);
      rate = track.getSettings().sampleRate;
    }

    // Chromium takes the output in the constructor, and moving it afterwards
    // rebuilds the output stream. See #pickOutput for why it follows the input.
    const sinkId = await this.#pickOutput();
    // `latencyHint: 0` asks for the smallest buffer the device offers — not
    // 'interactive', which is more conservative than we want.
    const options = { latencyHint: 0, ...(rate === undefined ? {} : { sampleRate: rate }) } as AudioContextOptions;
    let context: AudioContext;
    try {
      context = new AudioContext(
        sinkId === undefined ? options : ({ ...options, sinkId } as AudioContextOptions),
      );
    } catch {
      // An output the browser will not open: the default beats no engine.
      this.#sinkId = undefined;
      context = new AudioContext(options);
    }
    this.#ctx = context;
    await context.resume();

    // Requested before the module loads, so the two wait on the network
    // together: time to first note, not latency. A worklet has no fetch; the
    // bytes are handed over (AD-13).
    const wasmRequest = fetch(`${BASE}dsp/chain.wasm`);
    try {
      // chain-processor.js imports chain-core.js from next to itself.
      await context.audioWorklet.addModule(`${BASE}dsp/chain-processor.js`);
    } catch (cause) {
      throw new EngineError(
        { kind: 'engine-broken', detail: String(cause) },
        'The audio engine could not be loaded. Reload the page; if it persists the build is incomplete.',
      );
    }
    const response = await wasmRequest;
    if (!response.ok) {
      // Without this the worklet would try to instantiate a 404 page and the
      // interface would sit on "Starting" with nothing said.
      throw new EngineError({ kind: 'engine-missing' }, 'The audio engine is missing. Run `npm run build:dsp` and reload.');
    }
    const wasmBinary = await response.arrayBuffer();

    const node = new AudioWorkletNode(context, 'chain', {
      numberOfInputs: 1,
      numberOfOutputs: 2,
      outputChannelCount: [1, 1],
      // Without these the node applies the 'speakers' mixing rules, which fold
      // a two-channel capture down before the chain sees it — and a Scarlett
      // Solo's XLR and instrument jack are two inputs, not a stereo pair.
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
      processorOptions: { wasmBinary },
    });
    this.#node = node;
    const ready = new Promise<void>((resolve, reject) => { this.#ready = { resolve, reject }; });
    node.port.onmessage = (event: MessageEvent<WorkletMessage>): void => this.#onMessage(event.data);

    /* The worklet's second output is the selected guitar channel before gain,
       gate or boost: a clean signal for pitch detection, without duplicating
       the channel rules on the main thread. It goes to a zero-gain sink so the
       analyser keeps rendering without ever reaching the headphones. */
    const tuner = new AnalyserNode(context, { fftSize: TUNER_FFT, smoothingTimeConstant: 0 });
    const sink = new GainNode(context, { gain: 0 });
    node.connect(tuner, 1, 0);
    tuner.connect(sink);
    sink.connect(context.destination);
    node.connect(context.destination, 0, 0);
    this.#tuner = tuner;

    if (this.#stream !== null) {
      this.#live = new MediaStreamAudioSourceNode(context, { mediaStream: this.#stream });
      this.#live.connect(node);
    }

    // The chain must confirm it is running. When it does not, the product
    // would otherwise play nothing and say nothing.
    let timer = 0;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = self.setTimeout(() => reject(new Error('the audio engine did not start in time')), CALL_TIMEOUT_MS);
        }),
      ]);
    } catch (cause) {
      throw new EngineError(
        { kind: 'engine-broken', detail: String(cause) },
        `The audio engine did not start (${(cause as Error).message}). Reload the page.`,
      );
    } finally {
      self.clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#settleAll('the engine stopped');
    try { await this.#ctx?.close(); } catch { /* already closed */ }
    this.#stream = null;
    this.#live = null;
    this.#node = null;
    this.#ctx = null;
    this.#tuner = null;
  }

  resume(): void {
    void this.#ctx?.resume();
  }

  // -------------------------------------------------------------------------
  // The chain

  send(fn: string, args: readonly number[] = [], data?: ArrayBufferView<ArrayBuffer>): void {
    this.#node?.port.postMessage({ type: 'call', fn, args, data }, data === undefined ? [] : [data.buffer]);
  }

  call(fn: string, args: readonly number[] = [], data?: ArrayBufferView<ArrayBuffer>): Promise<CallResult> {
    const node = this.#node;
    if (node === null) return Promise.resolve({ value: 0, error: 'the engine is not running' });
    const id = this.#nextId++;
    return new Promise<CallResult>((resolve) => {
      const timer = self.setTimeout(() => {
        this.#pending.delete(id);
        resolve({ value: 0, error: 'no answer from the audio engine' });
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, { resolve, timer });
      node.port.postMessage({ type: 'call', id, fn, args, data }, data === undefined ? [] : [data.buffer]);
    });
  }

  #onMessage(data: WorkletMessage): void {
    switch (data.type) {
      case 'ready':
        this.#ready?.resolve();
        break;
      case 'error':
        // From the worklet's own initialisation, usually before anything was
        // asked of it — which is exactly how it used to go unnoticed.
        this.#ready?.reject(new Error(data.message));
        this.#settleAll(data.message);
        this.#events.onFailure(data.message);
        break;
      case 'result': {
        const pending = this.#pending.get(data.id);
        if (pending === undefined) break;
        this.#pending.delete(data.id);
        self.clearTimeout(pending.timer);
        pending.resolve({ value: data.value, error: data.error, data: data.data });
        break;
      }
      case 'meters':
        this.#events.onMeters(data.meters, data.dropouts);
        break;
      default:
        break;
    }
  }

  #settleAll(error: string): void {
    for (const { resolve, timer } of this.#pending.values()) {
      self.clearTimeout(timer);
      resolve({ value: 0, error });
    }
    this.#pending.clear();
  }

  // -------------------------------------------------------------------------
  // Latency

  /** Base plus output latency, as the browser reports them. Never used to decide anything (AD-5). */
  get roundTripMs(): number | null {
    const parts = this.latencyParts;
    return parts === null ? null : parts.input + parts.output;
  }

  /**
   * `input` is the render buffer the browser chose for `latencyHint: 0`;
   * `output` is what the system and the device add on the way out. Neither
   * includes the capture path, which the Web Audio API does not expose.
   */
  get latencyParts(): LatencyParts | null {
    const ctx = this.#ctx;
    if (ctx === null) return null;
    return {
      input: ctx.baseLatency * 1000,
      output: ('outputLatency' in ctx ? ctx.outputLatency : 0) * 1000,
    };
  }

  // -------------------------------------------------------------------------
  // Tuner

  setTunerTap(): void {
    // The analyser is always connected; there is nothing to stream here.
  }

  readTunerInput(target: Float32Array<ArrayBuffer>): number | null {
    const tuner = this.#tuner;
    const ctx = this.#ctx;
    if (tuner === null || ctx === null || target.length !== tuner.fftSize) return null;
    tuner.getFloatTimeDomainData(target);
    return ctx.sampleRate;
  }

  // -------------------------------------------------------------------------
  // Input

  /**
   * Opens or closes the live capture. `enabled = false` stops the browser
   * delivering samples at the source, so the input is actually off rather
   * than turned down. The track is not stopped: reopening a device costs a few
   * hundred milliseconds, far too slow for a switch flipped a dozen times.
   */
  setCaptureOpen(open: boolean): void {
    this.#captureOpen = open;
    this.#stream?.getAudioTracks().forEach((track) => { track.enabled = open; });
    const source = this.#live;
    const node = this.#node;
    if (source === null || node === null) return;
    try {
      if (open) source.connect(node);
      else source.disconnect(node);
    } catch {
      // Disconnecting something that is not connected throws; nothing to fix.
    }
  }

  /** Releases the input entirely (file source) or opens it again (live). */
  async setLive(on: boolean): Promise<void> {
    const ctx = this.#ctx;
    const node = this.#node;
    this.#stream?.getTracks().forEach((t) => t.stop());
    this.#live?.disconnect();
    this.#stream = null;
    this.#live = null;
    if (!on || ctx === null || node === null) return;
    const stream = await this.#open();
    this.#stream = stream;
    const track = stream.getAudioTracks()[0];
    if (track !== undefined) this.#adopt(track);
    this.#live = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream });
    this.#live.connect(node);
    this.setCaptureOpen(this.#captureOpen);
    await this.#followInput();
  }

  /** Reopens the capture on another interface, keeping everything else. */
  async useDevice(deviceId: string): Promise<void> {
    this.#deviceId = deviceId;
    if (this.#stream === null) return;
    await this.setLive(true);
  }

  async #open(): Promise<MediaStream> {
    try {
      return await openInput(navigator.mediaDevices, this.#deviceId);
    } catch (cause) {
      if (cause instanceof InputError) throw new EngineError({ kind: cause.reason }, cause.message);
      throw cause;
    }
  }

  #adopt(track: MediaStreamTrack): void {
    this.deviceLabel = track.label;
    this.deviceKind = classifyDevice(track.label);
    this.channels = track.getSettings().channelCount ?? 1;
  }

  // -------------------------------------------------------------------------
  // Output
  //
  // Where the sound comes out is chosen, not left to the browser. By default
  // it follows the input: a guitarist with an interface has their headphones
  // plugged into it, and the browser's default output is the laptop speakers.
  // One clock in and out also means no drift, so no resampling to hide it —
  // and the round trip on screen is the one through the headphones.

  /**
   * An explicit choice sticks across device changes; '' hands the decision
   * back to the input-following rule.
   */
  async useOutput(id: string): Promise<void> {
    this.#sinkChosen = id !== '';
    this.#sinkId = id === '' ? undefined : id;
    await this.#applyOutput(id);
  }

  async #applyOutput(id: string): Promise<void> {
    const ctx = this.#ctx;
    if (ctx === null || !canChooseOutput()) return;
    try {
      await (ctx as AudioContext & { setSinkId(id: string): Promise<void> }).setSinkId(id);
    } catch {
      // A device that has gone away: the sound keeps coming out where it was.
    }
  }

  async #followInput(): Promise<void> {
    if (this.#sinkChosen) return;
    const sink = await this.#pickOutput();
    await this.#applyOutput(sink ?? '');
  }

  /**
   * The player's explicit choice if there is one; otherwise the output that
   * shares hardware with the open input. `groupId` is the browser's word for
   * "the same physical device", meaningful once permission has been granted.
   */
  async #pickOutput(): Promise<string | undefined> {
    if (!canChooseOutput()) return undefined;
    let devices: MediaDeviceInfo[];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
      return this.#sinkChosen ? this.#sinkId : undefined;
    }
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    if (this.#sinkChosen) {
      // A remembered device since unplugged must not take the context down.
      if (outputs.some((d) => d.deviceId === this.#sinkId)) return this.#sinkId;
      this.#sinkChosen = false;
      this.#sinkId = undefined;
    }
    const group = this.#stream?.getAudioTracks()[0]?.getSettings().groupId;
    if (group === undefined || group === '') return undefined;
    this.#sinkId = outputs.find((d) => d.groupId === group)?.deviceId;
    return this.#sinkId;
  }
}
