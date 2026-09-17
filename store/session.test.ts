import { PARAMS } from '../schema/params.ts';
import { sanitizeSession } from './session.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name}`);
  if (!ok) failures.push(name);
};

const live = PARAMS.find((p) => p.deprecated !== true)!;

const oldGuilt = {
  preset: 'Lead', resetPreset: 'Lead', captureFile: 'helga-b-jsx-ultra-od808.nam',
  cab: 'v30mod', cabTouched: false, values: { out_master: -12.4 },
};
const updatedGuilt = sanitizeSession(oldGuilt);
check('the previous factory Guilt session opens on ENGL E530 and Celestion',
  updatedGuilt.captureFile === 'engl-e530.nam' && updatedGuilt.cab === 'celestion-g12-vintage'
    && updatedGuilt.values?.out_master === -12.4);
for (const custom of [{ preset: null }, { preset: 'saved:my-lead' }, { cab: 'custom' }, { cabTouched: true }]) {
  const restored = sanitizeSession({ ...oldGuilt, ...custom });
  check(`Guilt migration preserves custom choices ${JSON.stringify(custom)}`,
    restored.captureFile === oldGuilt.captureFile && restored.cab === ('cab' in custom ? custom.cab : oldGuilt.cab));
}

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
check('the loop level is clamped to 0..1',
  sanitizeSession({ loopLevel: 4 }).loopLevel === 1 && sanitizeSession({ loopLevel: -1 }).loopLevel === 0);
check('a loop level that is not a number is left out',
  !('loopLevel' in sanitizeSession({ loopLevel: 'loud' })));
check('a known view is kept and an unknown one opens on the amp',
  sanitizeSession({ view: 'play' }).view === 'play' && sanitizeSession({ view: 'focus' }).view === 'tone');
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
