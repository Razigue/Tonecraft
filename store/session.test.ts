import { PARAMS } from '../schema/params.ts';
import { sanitizeSession } from './session.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name}`);
  if (!ok) failures.push(name);
};

const live = PARAMS.find((p) => p.deprecated !== true)!;

check('garbage restores nothing',
  Object.keys(sanitizeSession('nope')).length === 0 && Object.keys(sanitizeSession(null)).length === 0);

const s = sanitizeSession({
  values: { [live.id]: live.max + 1000, nope: 3, other: Number.NaN },
  channel: 'diagonal',
  backend: 'native',
  metronomeVolume: 7,
  metronomeBpm: 'fast',
  cabTouched: 'yes',
});
check('values are clamped to the schema range', s.values?.[live.id] === live.max);
check('unknown parameter ids are dropped', s.values !== undefined && !('nope' in s.values));
check('non-finite values are dropped', s.values !== undefined && !('other' in s.values));
check('an unknown channel falls back to follow', s.channel === 'follow');
check('a known backend is kept', s.backend === 'native');
check('the metronome volume is clamped to 0..1', s.metronomeVolume === 1);
check('a non-numeric tempo means no tempo', s.metronomeBpm === null);
check('a mistyped boolean is omitted rather than coerced', !('cabTouched' in s));

const deprecated = PARAMS.find((p) => p.deprecated === true);
if (deprecated !== undefined) {
  check('deprecated parameters never reach the chain',
    !(deprecated.id in (sanitizeSession({ values: { [deprecated.id]: deprecated.default } }).values ?? {})));
}

const legacy = sanitizeSession({
  channel: 'right', deviceId: 'abc', nativeSettings: { host: 'asio', bufferSize: 64, inputChannels: [1, 2] },
});
check('the legacy localStorage record is understood',
  legacy.channel === 'right' && legacy.deviceId === 'abc' && legacy.native?.host === 'asio'
    && legacy.native.bufferSize === 64 && legacy.native.inputChannels?.[1] === 2
    && legacy.native.output === null);
check('a malformed channel pair becomes null',
  sanitizeSession({ native: { host: 'asio', inputChannels: [1] } }).native?.inputChannels === null);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
