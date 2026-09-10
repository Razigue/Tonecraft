import { detectPitch, noteFromFrequency } from './tuner.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

function guitarNote(frequency: number, level = 0.12): Float32Array {
  const rate = 48_000;
  const signal = new Float32Array(8192);
  for (let i = 0; i < signal.length; i += 1) {
    const phase = 2 * Math.PI * frequency * i / rate;
    signal[i] = level * (
      Math.sin(phase) +
      0.48 * Math.sin(phase * 2 + 0.2) +
      0.22 * Math.sin(phase * 3 + 0.5)
    );
  }
  return signal;
}

for (const [name, frequency] of [['E2', 82.4069], ['A2', 110], ['D3', 146.832], ['E4', 329.628]] as const) {
  const found = detectPitch(guitarNote(frequency), 48_000);
  const shown = found === null ? 'none' : `${found.note}${found.octave}, ${found.cents.toFixed(1)} cents`;
  check(`${name} is found through guitar harmonics`,
    found !== null && `${found.note}${found.octave}` === name && Math.abs(found.cents) < 2,
    shown);
}

const flatA = detectPitch(guitarNote(435), 48_000);
check('a flat A reports a negative deviation',
  flatA !== null && flatA.note === 'A' && flatA.cents < -15 && flatA.cents > -25,
  flatA === null ? 'none' : `${flatA.cents.toFixed(1)} cents`);

check('silence does not invent a note', detectPitch(new Float32Array(8192), 48_000) === null);
check('note names use letter notation', noteFromFrequency(277.183).note === 'C♯');

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
