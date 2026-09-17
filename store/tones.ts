/**
 * The tones the player saved, kept on their machine.
 *
 * A saved tone has exactly the shape of a factory preset — a capture file, a
 * cabinet id and parameter values in engineering units (AD-9) — so applying
 * one goes through the same path, and a tone link can later carry one as is.
 * Hardware (device, input channel, headphone volume) is never part of it.
 *
 * One record in `state`, the whole list at once: a player keeps tens of tones,
 * not thousands, and a single key needs no migration.
 */

import { STORES, dbGet, dbPut } from './db.ts';
import { isObject, sanitizeValues } from './session.ts';

export interface SavedTone {
  readonly id: string;
  readonly name: string;
  readonly capture: string;
  readonly cab: string;
  readonly values: Readonly<Record<string, number>>;
  readonly savedAt: number;
}

const KEY = 'tones';
const VERSION = 1;
/** Long enough for "Crunch — bridge pickup, low action", short enough for the dropdown. */
export const TONE_NAME_MAX = 48;

/** A name as it will be shown: trimmed, whitespace collapsed, bounded. Empty when unusable. */
export function cleanToneName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, TONE_NAME_MAX);
}

/**
 * Whatever was read, made safe to apply. Pure, so it is tested in Node.
 * A malformed entry is dropped alone; the others survive it.
 */
export function sanitizeTones(raw: unknown): SavedTone[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedTone[] = [];
  const ids = new Set<string>();
  for (const t of raw) {
    if (!isObject(t) || !isObject(t['values'])) continue;
    const { id, capture, cab, savedAt } = t;
    const name = typeof t['name'] === 'string' ? cleanToneName(t['name']) : '';
    if (typeof id !== 'string' || ids.has(id) || name === ''
      || typeof capture !== 'string' || typeof cab !== 'string') continue;
    ids.add(id);
    out.push({
      id, name, capture, cab,
      values: sanitizeValues(t['values']),
      savedAt: typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0,
    });
  }
  return out;
}

export async function loadTones(): Promise<SavedTone[]> {
  const stored = await dbGet<{ version: number; tones: unknown }>(STORES.state, KEY);
  return sanitizeTones(stored?.tones);
}

/** Resolves `false` when this browser kept nothing, so the page can say so. */
export function saveTones(tones: readonly SavedTone[]): Promise<boolean> {
  return dbPut(STORES.state, { version: VERSION, tones }, KEY);
}
