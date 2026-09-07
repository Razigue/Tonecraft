/**
 * Checks the amp kernel against NeuralAmpModelerCore itself.
 *
 * `dsp/model/wavenet.h` is our own implementation of NAM's Standard WaveNet,
 * and every way it can be wrong is silent: a transposed weight matrix, a
 * reversed convolution tap or a misread head scale all load without complaint
 * and play a different amplifier. So the check is not a unit test of the parts,
 * it is the whole thing against the reference.
 *
 * `assets/golden/*.f32` holds what the vendored NAM core build (@opendaw/nam-wasm
 * 1.2.0, the engine this kernel replaced on 2026-09-07) produced from three
 * seconds of `public/di/demo-di.wav` — the last 16 384 samples of it, so the
 * window covers steady state and the history handling behind it rather than the
 * prewarm alone. The vectors are committed precisely so that running this test
 * does not need a checkout of NAM core.
 *
 * The threshold is deliberately far from the failure modes rather than close to
 * the noise floor: float32 accumulation order alone puts the two above 100 dB,
 * where a transposed weight matrix scores about -5 dB. Anything under 80 dB is
 * not a rounding difference, it is a different amplifier.
 *
 * Usage:  npm run model:verify
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Model } from '../render/model.ts';
import { readWav } from '../render/wav-read.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
const FRAMES = 3 * SR;
const MIN_SNR_DB = 80;

const di = readWav(path.join(ROOT, 'public/di/demo-di.wav')).data;
const input = di.subarray(0, FRAMES);

const model = await Model.load();
let worst = Infinity;

console.log('\nAmp kernel against NeuralAmpModelerCore (3 s of the demo DI)\n');

for (const file of fs.readdirSync(path.join(ROOT, 'assets/golden')).filter((f) => f.endsWith('.f32'))) {
  const stem = file.replace(/\.f32$/, '');
  const raw = fs.readFileSync(path.join(ROOT, 'assets/golden', file));
  const golden = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);

  model.loadBlob(path.join(ROOT, 'public/models', `${stem}.tcnm`));
  const ours = model.render(input).subarray(FRAMES - golden.length, FRAMES);

  let signal = 0, noise = 0, peak = 0;
  for (let i = 0; i < golden.length; i++) {
    const d = ours[i]! - golden[i]!;
    signal += golden[i]! * golden[i]!;
    noise += d * d;
    const a = d < 0 ? -d : d;
    if (a > peak) peak = a;
  }
  const snr = 10 * Math.log10(signal / Math.max(noise, 1e-300));
  if (snr < worst) worst = snr;
  console.log(`  ${stem.padEnd(38)} ${snr.toFixed(1).padStart(6)} dB SNR   peak error ${peak.toExponential(2)}`);
}

console.log(`\nworst ${worst.toFixed(1)} dB, floor ${MIN_SNR_DB} dB\n`);
if (worst < MIN_SNR_DB) {
  console.error('FAIL: the kernel no longer agrees with NAM. See dsp/model/README.md.\n');
  process.exit(1);
}
