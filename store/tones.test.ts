import { PARAMS } from '../schema/params.ts';
import { TONE_NAME_MAX, cleanToneName, sanitizeTones } from './tones.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name}`);
  if (!ok) failures.push(name);
};

const live = PARAMS.find((p) => p.deprecated !== true)!;
const tone = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a', name: 'Crunch', capture: 'x.nam', cab: 'v30mod', values: {}, savedAt: 1, ...extra,
});

check('garbage restores no tone', sanitizeTones('nope').length === 0 && sanitizeTones(undefined).length === 0);
check('a well-formed tone is kept', sanitizeTones([tone()])[0]?.name === 'Crunch');

const [clamped] = sanitizeTones([tone({ values: { [live.id]: live.max + 1000, nope: 1 } })]);
check('tone values are clamped to the schema range', clamped?.values[live.id] === live.max);
check('unknown parameter ids are dropped from a tone', clamped !== undefined && !('nope' in clamped.values));

const mixed = sanitizeTones([tone(), tone({ id: 'b', name: '   ' }), tone({ id: 'c', capture: 3 }), 7, tone({ id: 'd' })]);
check('a malformed entry is dropped alone', mixed.map((t) => t.id).join() === 'a,d');
check('a duplicated id is kept once', sanitizeTones([tone(), tone({ name: 'Other' })]).length === 1);
check('a missing date reads as zero', sanitizeTones([tone({ savedAt: 'today' })])[0]?.savedAt === 0);

check('names are trimmed and their whitespace collapsed', cleanToneName('  Big \n  lead ') === 'Big lead');
check('names are bounded', cleanToneName('x'.repeat(200)).length === TONE_NAME_MAX);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
