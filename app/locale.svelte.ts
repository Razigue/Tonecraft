/**
 * The language, as state every component reads. It was a variable inside the
 * rig and handed down to the welcome and the tutorial only, so choosing French
 * in the settings changed those and left the rest of the studio in English.
 */
import { MESSAGES, detectLocale, saveLocale, type Locale } from './i18n.ts';
import { UI } from './strings.ts';
import type { EngineFailure } from '../engine/chain-host.ts';

const state = $state({ locale: detectLocale() });

export const lang = {
  get locale(): Locale { return state.locale; },
  /** The welcome and the tutorial. */
  get messages() { return MESSAGES[state.locale]; },
  /** Everything else the studio says. */
  get ui() { return UI[state.locale]; },
  set(next: Locale): void {
    state.locale = next;
    saveLocale(next);
  },
};

/** A message thrown by the engine, in the page's language when it is known. */
export function engineMessage(message: string): string {
  return UI[state.locale].engineMessages[message] ?? message;
}

/** Cause and remedy for a start that failed, by the engine's failure kind. */
export function failure(kind: EngineFailure['kind'] | 'unknown'): { cause: string; fix: string } {
  const [cause, fix] = UI[state.locale].failures[kind] ?? UI[state.locale].failures.unknown!;
  return { cause, fix };
}
