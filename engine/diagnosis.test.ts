/**
 * The judgements, not the measurements.
 *
 * Deciding that 28 ms deserves a number and 41 ms deserves an explanation is
 * the part of FR-11 and FR-35 that can be wrong without anything failing, and
 * the part nobody would ever exercise by hand — it would mean plugging real
 * guitars into real bad inputs. So it is a pure function, and this is it.
 */

import {
  judgeLatency, judgeDropouts, jitterOf, judgeInput,
  LATENCY_QUIET_MS, LATENCY_NAMED_MS, PEAK_TOO_LOW, BRIGHTNESS_DULL,
  type Calibration,
} from './diagnosis.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

/** Cause and remedy are each exactly one sentence, and neither apologises. */
const oneSentence = (s: string | undefined): boolean =>
  s !== undefined && s.trim().length > 0 &&
  (s.match(/[.!?]/g) ?? []).length === 1 && s.trim().endsWith('.') &&
  !/sorry|apolog|unfortunately|we regret/i.test(s);

// --- latency, three tiers (FR-35) -----------------------------------------

check('under 20 ms the product says nothing',
  judgeLatency(12, 'interface').tier === 'quiet' &&
  judgeLatency(12, 'interface').cause === undefined);
check('the boundary itself is quiet, not explained',
  judgeLatency(LATENCY_QUIET_MS - 0.001, 'interface').tier === 'quiet');
check('at 20 ms the figure starts explaining itself',
  judgeLatency(LATENCY_QUIET_MS, 'interface').tier === 'explained');
check('28 ms explains without naming hardware',
  judgeLatency(28, 'interface').tier === 'explained');
check('at 35 ms the cause is named',
  judgeLatency(LATENCY_NAMED_MS, 'onboard').tier === 'named');
check('onboard audio is named as the cause when it is one',
  /built-in|built‑in/i.test(judgeLatency(50, 'onboard').cause ?? ''));
check('a real interface gets a different cause than onboard audio',
  judgeLatency(50, 'onboard').cause !== judgeLatency(50, 'interface').cause);

for (const [ms, kind] of [[25, 'interface'], [50, 'onboard'], [50, 'guitar-usb']] as const) {
  const v = judgeLatency(ms, kind);
  check(`${ms} ms on ${kind}: one sentence of cause, one of remedy`,
    oneSentence(v.cause) && oneSentence(v.remedy),
    `${v.cause ?? ''} / ${v.remedy ?? ''}`);
}

// --- dropouts, and the refusal that must not exist (FR-36, FR-37) ----------

check('a clean session says nothing about dropouts',
  judgeDropouts(0, 300).audible === false);
check('one dropout in five minutes is not worth a message',
  judgeDropouts(1, 300).audible === false);
check('a session breaking up constantly is named',
  judgeDropouts(60, 60).audible === true);
check('and it offers the listen path rather than redirecting to it',
  /preset pages|as a file/i.test(judgeDropouts(60, 60).remedy ?? ''));
check('the dropout verdict has no way to express a refusal',
  !('blocked' in judgeDropouts(999, 1)) && !('refuse' in judgeDropouts(999, 1)));

// --- jitter (FR-38) --------------------------------------------------------

const steady = new Array(50).fill(33.3) as number[];
check('a steady stream reports no jitter', jitterOf(steady).deviationMs < 1e-9);
const jumpy = steady.map((v, i) => (i % 2 === 0 ? v - 8 : v + 8));
check('an unsteady one reports it', jitterOf(jumpy).deviationMs > 7);
check('jitter is reported alongside the mean, not instead of it',
  Math.abs(jitterOf(jumpy).meanMs - 33.3) < 0.01);
check('too few samples is reported as too few rather than as zero jitter',
  jitterOf([33.3]).samples === 1);

// --- the input (FR-10, FR-11) ---------------------------------------------

const base: Calibration = {
  deviceKind: 'interface', deviceLabel: 'Scarlett Solo',
  roundTripMs: 9, peak: 0.4, brightness: 0.3,
};

check('a healthy interface hears nothing about hardware at all',
  judgeInput(base).problem === null &&
  judgeInput(base).cause === undefined);

const micInput: Calibration = {
  ...base, deviceKind: 'onboard', deviceLabel: 'Realtek High Definition Audio',
  roundTripMs: 48, peak: PEAK_TOO_LOW / 2, brightness: BRIGHTNESS_DULL / 2,
};
const verdict = judgeInput(micInput);
check('a guitar in a microphone input is recognised as an impedance mismatch',
  verdict.problem === 'impedance');
check('and is told the cause and the remedy in one sentence each',
  oneSentence(verdict.cause) && oneSentence(verdict.remedy),
  `${verdict.cause ?? ''} / ${verdict.remedy ?? ''}`);
check('the remedy names what to buy, not what to read',
  /cable|interface/i.test(verdict.remedy ?? ''));

check('quiet but bright is a gain problem, not an impedance one',
  judgeInput({ ...micInput, brightness: 0.3 }).problem === 'level-low');
check('a clipping input is named as clipping',
  judgeInput({ ...base, peak: 0.99 }).problem === 'level-clipping');

// A guitar-to-USB cable is fully supported (FR-13). Quiet playing through one
// must never be reported as an impedance problem — that would put a warning on
// a device the product says it supports.
check('a quiet, dull signal on a guitar cable is not blamed on impedance',
  judgeInput({ ...micInput, deviceKind: 'guitar-usb' }).problem !== 'impedance');

// FR-12: nothing here can stop anyone playing.
for (const c of [base, micInput, { ...base, peak: 0.99 }, { ...micInput, brightness: 0.3 }]) {
  check(`${c.deviceLabel} at peak ${c.peak}: still playable`, judgeInput(c).canPlay === true);
}

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
