/**
 * The rig's session: everything needed to reopen the app as it was left.
 *
 * A projection of the main-thread state, never a second source of truth
 * (Architecture, "chain state lives in main-thread stores"). It is written
 * after the fact and read once, at load.
 *
 * What is *not* here, on purpose: whether the engine was running (an
 * `AudioContext` needs a gesture, so nothing may start on its own), meters,
 * latency, and anything the worklet owns.
 */

import type { Backend, InputChannel, Source } from '../engine/engine.ts';
import type { NativeSettings } from '../engine/native-host.ts';
import { PARAMS } from '../schema/params.ts';
import { STORES, dbGet, dbPut } from './db.ts';

export interface Session {
  /** Tone: engineering units, same wire meaning as a tone link (AD-9). */
  readonly values: Readonly<Record<string, number>>;
  readonly captureFile: string;
  readonly cab: string;
  readonly cabTouched: boolean;
  /** The preset the tone came from, null once edited by hand. */
  readonly preset: string | null;
  /** The preset double-click returns to, kept even after an edit. */
  readonly resetPreset: string | null;

  /** Hardware: describes the player's setup, never part of a tone link. */
  readonly deviceId: string;
  readonly outputId: string;
  readonly channel: InputChannel;
  readonly backend: Backend;
  readonly native: NativeSettings | null;

  readonly source: Source;
  /** The player's last take, as a `media` record id. */
  readonly takeId: string | null;
  readonly fileLoop: boolean;

  readonly metronomeBpm: number | null;
  readonly metronomeVolume: number;
  /** Whether the tab reader starts its bars on the click and plays at its tempo. */
  readonly metronomeSync: boolean;
  /** How loud the loop sits under the playing. The loop itself is audio, and is not kept. */
  readonly loopLevel: number;

  /** The studio's view: the amp to dial a tone, or the tab to play along. */
  readonly view: StudioView;
}

export type StudioView = 'tone' | 'play';

const KEY = 'session';
/** Bumped when a field changes meaning; `sanitizeSession` upgrades older ones. */
export const SESSION_VERSION = 1;
/** Where the previous build kept its subset. Read once, then removed. */
const LEGACY_KEY = 'tonecraft-v1';

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pair = (v: unknown): readonly [number, number] | null =>
  Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n)) ? [v[0], v[1]] : null;
const oneOf = <const T extends string>(v: unknown, allowed: readonly T[], fallback: NoInfer<T>): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/**
 * Parameter values made safe to send to the chain: unknown and deprecated ids
 * dropped, non-finite values dropped, the rest clamped to the schema's range.
 * Shared with the saved tones, which carry the same wire meaning.
 */
export function sanitizeValues(raw: Record<string, unknown>): Record<string, number> {
  const values: Record<string, number> = {};
  for (const p of PARAMS) {
    const v = raw[p.id];
    if (p.deprecated === true || typeof v !== 'number' || !Number.isFinite(v)) continue;
    values[p.id] = Math.min(p.max, Math.max(p.min, v));
  }
  return values;
}

/**
 * Whatever was read, made safe to apply. Pure, so it is tested in Node.
 *
 * Stored data is input like any other: an old build, a hand-edited record or
 * a half-written one must not reach the chain. Unknown and deprecated
 * parameters are dropped; values are clamped to the schema's range, so a
 * parameter whose range narrows can never be driven outside it from disk.
 */
export function sanitizeSession(raw: unknown): Partial<Session> {
  if (!isObject(raw)) return {};
  const out: { -readonly [K in keyof Session]?: Session[K] } = {};

  if (isObject(raw['values'])) out.values = sanitizeValues(raw['values']);
  if (typeof raw['captureFile'] === 'string') out.captureFile = raw['captureFile'];
  if (typeof raw['cab'] === 'string') out.cab = raw['cab'];
  if (typeof raw['cabTouched'] === 'boolean') out.cabTouched = raw['cabTouched'];
  if ('preset' in raw) out.preset = strOrNull(raw['preset']);
  if ('resetPreset' in raw) out.resetPreset = strOrNull(raw['resetPreset']);

  // Carry the untouched factory Guilt sound over to its new amp and IR.
  // Custom tones and explicitly chosen cabinets keep their saved sound.
  if (out.preset === 'Lead' && out.captureFile === 'helga-b-jsx-ultra-od808.nam'
      && out.cab === 'v30mod' && out.cabTouched !== true) {
    out.captureFile = 'engl-e530.nam';
    out.cab = 'celestion-g12-vintage';
  }

  if (typeof raw['deviceId'] === 'string') out.deviceId = raw['deviceId'];
  if (typeof raw['outputId'] === 'string') out.outputId = raw['outputId'];
  if ('channel' in raw) out.channel = oneOf(raw['channel'], ['left', 'right', 'sum', 'follow'], 'follow');
  if ('backend' in raw) out.backend = oneOf(raw['backend'], ['browser', 'native'], 'browser');
  // The legacy record called it nativeSettings.
  const native = raw['native'] ?? raw['nativeSettings'];
  if (isObject(native) && typeof native['host'] === 'string') {
    out.native = {
      host: native['host'],
      input: strOrNull(native['input']),
      output: strOrNull(native['output']),
      sampleRate: numOrNull(native['sampleRate']),
      bufferSize: numOrNull(native['bufferSize']),
      inputChannels: pair(native['inputChannels']),
      outputChannels: pair(native['outputChannels']),
    };
  }

  if ('source' in raw) out.source = oneOf(raw['source'], ['live', 'file'], 'live');
  if ('takeId' in raw) out.takeId = strOrNull(raw['takeId']);
  if (typeof raw['fileLoop'] === 'boolean') out.fileLoop = raw['fileLoop'];

  if ('metronomeBpm' in raw) out.metronomeBpm = numOrNull(raw['metronomeBpm']);
  const volume = numOrNull(raw['metronomeVolume']);
  if (volume !== null) out.metronomeVolume = Math.min(1, Math.max(0, volume));
  if (typeof raw['metronomeSync'] === 'boolean') out.metronomeSync = raw['metronomeSync'];
  const loop = numOrNull(raw['loopLevel']);
  if (loop !== null) out.loopLevel = Math.min(1, Math.max(0, loop));
  if ('view' in raw) out.view = oneOf(raw['view'], ['tone', 'play'], 'tone');

  return out;
}

/**
 * The saved session, or `{}` when there is none. On first run after this
 * change, the old `localStorage` record is carried over and removed, so the
 * two can never disagree.
 */
export async function loadSession(): Promise<Partial<Session>> {
  const stored = await dbGet<{ version: number; session: unknown }>(STORES.state, KEY);
  if (stored !== undefined) return sanitizeSession(stored.session);
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) {
      const session = sanitizeSession(JSON.parse(legacy));
      if (await dbPut(STORES.state, { version: SESSION_VERSION, session }, KEY)) {
        localStorage.removeItem(LEGACY_KEY);
      }
      return session;
    }
  } catch { /* unreadable, so ignored */ }
  return {};
}

/**
 * Debounced writer. A fader drag calls this at pointer rate; one write per
 * quiet quarter second is plenty, and the pending one is flushed when the tab
 * is hidden or closed — `pagehide` is the last event a page reliably gets.
 */
const SAVE_DELAY_MS = 250;
let pending: Session | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let listening = false;

function flush(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (pending === null) return;
  const session = pending;
  pending = null;
  void dbPut(STORES.state, { version: SESSION_VERSION, session }, KEY);
}

export function saveSession(session: Session): void {
  pending = session;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flush, SAVE_DELAY_MS);
  if (!listening && typeof addEventListener === 'function') {
    listening = true;
    addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  }
}
