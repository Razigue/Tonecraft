/**
 * The native host: Tonecraft Engine, the companion that plays through ASIO.
 *
 * A browser cannot open an ASIO driver, and on Windows ASIO is where the low
 * buffers are. So the chain — the very `chain.wasm` this page runs in its
 * worklet — runs in a small native program instead, and this page becomes
 * its interface. The two talk over a WebSocket on the loopback address; the
 * protocol is `service/PROTOCOL.md`.
 *
 * Nothing about the sound is decided here. The page uploads the chain it would
 * have run itself, then drives it with the same `tc_*` calls `engine.ts` sends
 * to the worklet. Audio never crosses the socket, except the tuner's tap while
 * the tuner is open: the engine plays through the interface directly.
 *
 * Reaching `ws://127.0.0.1` from an https page is allowed as loopback by
 * Chromium and Firefox; Chromium may first ask to allow access to devices on
 * the local network. Safari refuses it outright.
 */

import {
  EngineError, type CallResult, type ChainHost, type HostEvents, type LatencyParts,
} from './chain-host.ts';

export const NATIVE_PORT = 47800;
const NATIVE_URL = `ws://127.0.0.1:${NATIVE_PORT}/`;
const ABI = 1;

/** Release assets carry stable names so these links never change. */
const RELEASES = 'https://github.com/Razigue/Tonecraft/releases';
export const DOWNLOADS = {
  windows: 'tonecraft-engine-windows-x64.zip',
  macos: 'tonecraft-engine-macos-universal.zip',
  linux: 'tonecraft-engine-linux-x64.tar.gz',
} as const;
export type Platform = keyof typeof DOWNLOADS;

export const downloadUrl = (platform: Platform): string => `${RELEASES}/latest/download/${DOWNLOADS[platform]}`;
export const releasesUrl = RELEASES;

/** Which download to offer. Mobile and unknown systems get none: the play path is desktop only. */
export function detectPlatform(): Platform | 'mobile' | 'other' {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  if (nav.userAgentData?.mobile === true) return 'mobile';
  const hint = `${nav.userAgentData?.platform ?? ''} ${navigator.userAgent}`.toLowerCase();
  if (/android|iphone|ipad|ipod/.test(hint)) return 'mobile';
  if (hint.includes('win')) return 'windows';
  if (hint.includes('mac')) return 'macos';
  if (hint.includes('linux') || hint.includes('x11')) return 'linux';
  return 'other';
}

/** Safari will not let an https page open a plain WebSocket, even to loopback. */
export function browserBlocksLoopback(): boolean {
  const ua = navigator.userAgent;
  return /safari/i.test(ua) && !/chrome|chromium|crios|edg|firefox|fxios/i.test(ua);
}

export interface NativeHostApi { readonly id: string; readonly name: string }

export interface NativeInfo {
  readonly version: string;
  readonly abi: number;
  readonly platform: string;
  readonly hosts: readonly NativeHostApi[];
}

export interface NativeDevice {
  readonly id: string;
  readonly name: string;
  readonly channels: number;
  readonly sampleRates: readonly number[];
  readonly defaultRate: number;
  readonly bufferSizes: { readonly min: number; readonly max: number } | null;
}

export interface NativeDevices {
  readonly inputs: readonly NativeDevice[];
  readonly outputs: readonly NativeDevice[];
}

/**
 * The engine's device configuration. The engine owns it — its tray panel and
 * this page edit the same one, saved on the player's machine — so the two can
 * never disagree about which interface is in use. `null` means the engine's
 * best choice.
 */
export interface NativeConfig {
  readonly host: string | null;
  readonly input: string | null;
  readonly output: string | null;
  readonly sampleRate: number | null;
  /** null: the smallest buffer the device accepts — the lowest latency it offers. */
  readonly bufferSize: number | null;
  readonly inputChannels: readonly number[] | null;
  readonly outputChannels: readonly number[] | null;
  /** Headphone level, 0..1, applied after the chain: hardware volume, not tone. */
  readonly monitor: number;
}

/**
 * The device choice as the page used to keep it, before the engine owned its
 * configuration. Only for reading records saved back then (store/session.ts).
 */
export type NativeSettings = Omit<NativeConfig, 'host' | 'monitor'> & { readonly host: string };

export interface NativeOpened {
  readonly sampleRate: number;
  /** null when the host chooses the size itself and does not say. */
  readonly bufferSize: number | null;
  readonly inputChannels: number;
  readonly outputChannels: number;
  readonly inputLatencyMs: number;
  readonly outputLatencyMs: number;
  readonly input: string;
  readonly output: string;
  /** Set when the engine reopened the streams itself (a change from its tray panel): the chain is new. */
  readonly reopened?: boolean;
}

type Incoming =
  | ({ type: 'hello'; chain: boolean; config: NativeConfig } & NativeInfo)
  | ({ type: 'config' } & NativeConfig)
  | { type: 'chain'; ok: boolean; message?: string }
  | ({ type: 'devices'; host: string } & NativeDevices)
  | ({ type: 'opened' } & NativeOpened)
  | { type: 'closed' }
  | { type: 'result'; id: number; value: number; error?: string }
  | { type: 'meters'; meters: number[]; dropouts: number }
  | { type: 'autostart'; enabled: boolean }
  | { type: 'error'; context: string; message: string }
  | { type: 'replaced' };

type Of<T extends Incoming['type']> = Extract<Incoming, { type: T }>;

const BINARY_CHAIN = 0x01;
const BINARY_CALL = 0x02;
const BINARY_TUNER = 0x11;

/**
 * The one connection to the engine, shared by the settings sheet (is it
 * there, what devices does it see) and the host that plays through it.
 */
export class NativeLink {
  static #shared: NativeLink | null = null;
  static get shared(): NativeLink {
    NativeLink.#shared ??= new NativeLink();
    return NativeLink.#shared;
  }

  #ws: WebSocket | null = null;
  #connecting: Promise<NativeInfo | null> | null = null;
  #info: NativeInfo | null = null;
  #config: NativeConfig | null = null;
  #configListeners = new Set<(c: NativeConfig) => void>();
  #waiters: { type: Incoming['type']; context: string; resolve: (m: Incoming) => void; reject: (e: Error) => void }[] = [];
  #listeners = new Set<(m: Incoming) => void>();
  #binary = new Set<(bytes: Uint8Array) => void>();
  #closed = new Set<() => void>();

  get info(): NativeInfo | null { return this.#info; }
  /** The engine's device configuration, as last heard. */
  get config(): NativeConfig | null { return this.#config; }

  #setConfig(message: NativeConfig & { type?: string }): void {
    const { type: _type, ...rest } = message as NativeConfig & { type?: string; chain?: unknown };
    const config: NativeConfig = {
      host: rest.host ?? null, input: rest.input ?? null, output: rest.output ?? null,
      sampleRate: rest.sampleRate ?? null, bufferSize: rest.bufferSize ?? null,
      inputChannels: rest.inputChannels ?? null, outputChannels: rest.outputChannels ?? null,
      monitor: rest.monitor ?? 1,
    };
    this.#config = config;
    for (const listener of this.#configListeners) listener(config);
  }

  /** Changes the engine's configuration. It saves it, reopens if it must, and pushes it back. */
  configure(patch: Partial<NativeConfig>): void {
    this.send({ type: 'configure', ...patch });
  }

  onConfig(listener: (c: NativeConfig) => void): () => void {
    this.#configListeners.add(listener);
    return () => { this.#configListeners.delete(listener); };
  }
  get connected(): boolean { return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN && this.#info !== null; }

  /** Resolves with the engine's hello, or null when nothing answers. Never throws. */
  connect(timeoutMs = 1500): Promise<NativeInfo | null> {
    if (this.connected) return Promise.resolve(this.#info);
    if (this.#connecting !== null) return this.#connecting;
    this.#connecting = new Promise<NativeInfo | null>((resolve) => {
      let settled = false;
      const done = (info: NativeInfo | null): void => {
        if (settled) return;
        settled = true;
        self.clearTimeout(timer);
        this.#connecting = null;
        resolve(info);
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(NATIVE_URL);
      } catch {
        // Mixed content refused synchronously (Safari), or no WebSocket at all.
        done(null);
        return;
      }
      const timer = self.setTimeout(() => { ws.close(); done(null); }, timeoutMs);
      ws.binaryType = 'arraybuffer';
      ws.onopen = (): void => { ws.send(JSON.stringify({ type: 'hello', abi: ABI })); };
      ws.onmessage = (event: MessageEvent): void => {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data) as Incoming;
          if (message.type === 'hello' && !settled) {
            // An engine speaking another ABI is refused outright: adopting the
            // socket first would leave it `connected`, and the next connect()
            // would hand the stale engine back as if it had passed.
            if (message.abi !== ABI) {
              ws.close();
              done(null);
              return;
            }
            this.#ws = ws;
            this.#info = { version: message.version, abi: message.abi, platform: message.platform, hosts: message.hosts };
            if (message.config !== undefined) this.#setConfig(message.config);
            done(this.#info);
            return;
          }
          this.#dispatch(message);
        } else {
          const bytes = new Uint8Array(event.data as ArrayBuffer);
          for (const listener of this.#binary) listener(bytes);
        }
      };
      ws.onerror = (): void => { done(null); };
      ws.onclose = (): void => {
        done(null);
        if (this.#ws === ws) {
          this.#ws = null;
          this.#info = null;
          for (const waiter of this.#waiters.splice(0)) waiter.reject(new Error('Tonecraft Engine closed the connection'));
          for (const listener of this.#closed) listener();
        }
      };
    });
    return this.#connecting;
  }

  #dispatch(message: Incoming): void {
    if (message.type === 'config') this.#setConfig(message);
    const index = this.#waiters.findIndex((w) =>
      w.type === message.type || (message.type === 'error' && w.context === message.context));
    if (index >= 0) {
      const [waiter] = this.#waiters.splice(index, 1);
      if (message.type === 'error') waiter!.reject(new Error(message.message));
      else waiter!.resolve(message);
    }
    for (const listener of this.#listeners) listener(message);
  }

  #request<T extends Incoming['type']>(
    message: object | Uint8Array<ArrayBuffer>, type: T, context: string, timeoutMs = 10_000,
  ): Promise<Of<T>> {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Tonecraft Engine is not connected'));
    }
    return new Promise<Of<T>>((resolve, reject) => {
      const timer = self.setTimeout(() => {
        const at = this.#waiters.indexOf(waiter);
        if (at >= 0) this.#waiters.splice(at, 1);
        reject(new Error('Tonecraft Engine did not answer'));
      }, timeoutMs);
      const waiter = {
        type,
        context,
        resolve: (m: Incoming): void => { self.clearTimeout(timer); resolve(m as Of<T>); },
        reject: (e: Error): void => { self.clearTimeout(timer); reject(e); },
      };
      this.#waiters.push(waiter);
      ws.send(message instanceof Uint8Array ? message : JSON.stringify(message));
    });
  }

  send(message: object): void {
    if (this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(message));
  }

  /** A chain call, with an optional payload in a binary frame. */
  call(id: number | undefined, fn: string, args: readonly number[], data?: ArrayBufferView<ArrayBuffer>): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    if (data === undefined) {
      ws.send(JSON.stringify({ type: 'call', ...(id === undefined ? {} : { id }), fn, args }));
      return;
    }
    const header = new TextEncoder().encode(JSON.stringify({ ...(id === undefined ? {} : { id }), fn, args }));
    const frame = new Uint8Array(5 + header.length + data.byteLength);
    frame[0] = BINARY_CALL;
    new DataView(frame.buffer).setUint32(1, header.length, true);
    frame.set(header, 5);
    frame.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 5 + header.length);
    ws.send(frame);
  }

  devices(host: string): Promise<Of<'devices'>> {
    return this.#request({ type: 'devices', host }, 'devices', 'devices');
  }

  async uploadChain(wasm: ArrayBuffer): Promise<void> {
    const frame = new Uint8Array(1 + wasm.byteLength);
    frame[0] = BINARY_CHAIN;
    frame.set(new Uint8Array(wasm), 1);
    const reply = await this.#request(frame, 'chain', 'chain', 30_000);
    if (!reply.ok) throw new Error(reply.message ?? 'the chain did not compile');
  }

  /** Opens with the engine's own configuration: the page no longer keeps one. */
  open(): Promise<Of<'opened'>> {
    return this.#request({ type: 'open' }, 'opened', 'open', 20_000);
  }

  async close(): Promise<void> {
    try { await this.#request({ type: 'close' }, 'closed', 'close', 5000); } catch { /* gone already */ }
  }

  async autostart(enabled: boolean | null): Promise<boolean> {
    const reply = await this.#request({ type: 'autostart', enabled }, 'autostart', 'autostart');
    return reply.enabled;
  }

  quit(): void { this.send({ type: 'quit' }); }

  onMessage(listener: (m: Incoming) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  onBinary(listener: (bytes: Uint8Array) => void): () => void {
    this.#binary.add(listener);
    return () => { this.#binary.delete(listener); };
  }

  onClose(listener: () => void): () => void {
    this.#closed.add(listener);
    return () => { this.#closed.delete(listener); };
  }
}

const TUNER_WINDOW = 8192;
const CALL_TIMEOUT_MS = 15_000;

export class NativeHost implements ChainHost {
  readonly kind = 'native' as const;
  readonly tunerBufferSize = TUNER_WINDOW;

  readonly #link: NativeLink;
  readonly #events: HostEvents;
  #opened: NativeOpened | null = null;
  #pending = new Map<number, { resolve: (r: CallResult) => void; timer: number }>();
  #nextId = 1;
  #unsubscribe: (() => void)[] = [];
  #stopping = false;
  /** The tuner tap, as it streams in: a ring, read newest-last. */
  #tuner = new Float32Array(TUNER_WINDOW);
  #tunerAt = 0;

  constructor(link: NativeLink, events: HostEvents) {
    this.#link = link;
    this.#events = events;
  }

  get sampleRate(): number { return this.#opened?.sampleRate ?? 48_000; }
  get opened(): NativeOpened | null { return this.#opened; }

  async start(wasm: ArrayBuffer): Promise<void> {
    const info = await this.#link.connect();
    if (info === null) {
      throw new EngineError(
        { kind: 'native-unreachable' },
        'Tonecraft Engine is not running. Start it, or switch the audio engine back to the browser in the settings.',
      );
    }
    this.#unsubscribe.push(
      this.#link.onMessage((m) => this.#onMessage(m)),
      this.#link.onBinary((bytes) => this.#onBinary(bytes)),
      this.#link.onClose(() => {
        if (this.#stopping) return;
        this.#settleAll('Tonecraft Engine closed');
        this.#events.onFailure('Tonecraft Engine stopped');
      }),
    );
    try {
      // Always the page's own chain, even if the engine has one compiled: the
      // engine caches by content, so the same bytes cost nothing, and a page
      // from a newer deployment must never drive an older chain.
      await this.#link.uploadChain(wasm);
      this.#opened = await this.#link.open();
    } catch (cause) {
      this.#dispose();
      throw new EngineError(
        { kind: 'native-failed', detail: String(cause) },
        `Tonecraft Engine could not open the interface (${(cause as Error).message}). Check the device in the settings, or close the program that holds it.`,
      );
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#link.close();
    this.#dispose();
  }

  #dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    this.#settleAll('the engine stopped');
    this.#opened = null;
  }

  resume(): void {
    // A native stream is never suspended by an autoplay policy.
  }

  send(fn: string, args: readonly number[] = [], data?: ArrayBufferView<ArrayBuffer>): void {
    this.#link.call(undefined, fn, args, data);
  }

  call(fn: string, args: readonly number[] = [], data?: ArrayBufferView<ArrayBuffer>): Promise<CallResult> {
    const id = this.#nextId++;
    return new Promise<CallResult>((resolve) => {
      const timer = self.setTimeout(() => {
        this.#pending.delete(id);
        resolve({ value: 0, error: 'no answer from Tonecraft Engine' });
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, { resolve, timer });
      this.#link.call(id, fn, args, data);
    });
  }

  #onMessage(message: Incoming): void {
    switch (message.type) {
      case 'result': {
        const pending = this.#pending.get(message.id);
        if (pending === undefined) break;
        this.#pending.delete(message.id);
        self.clearTimeout(pending.timer);
        pending.resolve(message.error === undefined ? { value: message.value } : { value: message.value, error: message.error });
        break;
      }
      case 'meters':
        this.#events.onMeters(Float32Array.from(message.meters), message.dropouts);
        break;
      case 'opened':
        // The engine reopened by itself — a device picked in its tray panel.
        // The chain in there is a new one, empty until it is told everything.
        if (message.reopened === true && this.#opened !== null) {
          const { type: _type, ...opened } = message;
          this.#opened = opened;
          this.#events.onReopened?.();
        }
        break;
      case 'error':
        if (message.context === 'stream') this.#events.onFailure(message.message);
        break;
      case 'replaced':
        this.#events.onFailure('Tonecraft Engine is being used by another tab');
        break;
      default:
        break;
    }
  }

  #onBinary(bytes: Uint8Array): void {
    if (bytes[0] !== BINARY_TUNER || bytes.byteLength < 5) return;
    const count = (bytes.byteLength - 1) >> 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset + 1, count * 4);
    for (let i = 0; i < count; i++) {
      this.#tuner[this.#tunerAt] = view.getFloat32(i * 4, true);
      this.#tunerAt = (this.#tunerAt + 1) % TUNER_WINDOW;
    }
  }

  #settleAll(error: string): void {
    for (const { resolve, timer } of this.#pending.values()) {
      self.clearTimeout(timer);
      resolve({ value: 0, error });
    }
    this.#pending.clear();
  }

  setCaptureOpen(): void {
    // The chain gates the input itself; the driver's input stays open, because
    // reopening an ASIO stream to flip the power would take seconds.
  }

  setTunerTap(on: boolean): void {
    if (on) { this.#tuner.fill(0); this.#tunerAt = 0; }
    this.#link.send({ type: 'tuner', on });
  }

  readTunerInput(target: Float32Array<ArrayBuffer>): number | null {
    if (this.#opened === null || target.length !== TUNER_WINDOW) return null;
    const head = TUNER_WINDOW - this.#tunerAt;
    target.set(this.#tuner.subarray(this.#tunerAt), 0);
    target.set(this.#tuner.subarray(0, this.#tunerAt), head);
    return this.#opened.sampleRate;
  }

  /** As the driver reports them, buffers included. */
  get latencyParts(): LatencyParts | null {
    const o = this.#opened;
    return o === null ? null : { input: o.inputLatencyMs, output: o.outputLatencyMs };
  }

  get roundTripMs(): number | null {
    const parts = this.latencyParts;
    return parts === null ? null : parts.input + parts.output;
  }
}
