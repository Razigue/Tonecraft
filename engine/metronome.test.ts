import { bpmFromFourTaps, voiceForBeat } from './metronome.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name}`);
  if (!ok) failures.push(name);
};

check('four half-second taps resolve to 120 BPM',
  bpmFromFourTaps([1000, 1500, 2000, 2500]) === 120);
check('the three intervals are averaged before rounding',
  bpmFromFourTaps([0, 490, 1005, 1500]) === 120);
check('fewer than four taps do not produce a tempo',
  bpmFromFourTaps([0, 500, 1000]) === null);
check('a pause outside the playable range resets the measure',
  bpmFromFourTaps([0, 500, 1000, 4000]) === null);
check('four taps can reach the 450 BPM ceiling',
  bpmFromFourTaps([0, 400 / 3, 800 / 3, 400]) === 450);
check('beats one through three share one voice',
  voiceForBeat(0) === voiceForBeat(1) && voiceForBeat(1) === voiceForBeat(2));
check('the fourth beat has a distinct voice',
  voiceForBeat(3).frequency !== voiceForBeat(2).frequency
    && voiceForBeat(3).type !== voiceForBeat(2).type);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
