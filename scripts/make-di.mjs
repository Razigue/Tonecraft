/* =============================================================================
   scripts/make-di.mjs — builds the demo DI from its source take
   -----------------------------------------------------------------------------
   Converts the take in assets/di/ to public/di/demo-di.wav, which is what the
   demo path plays and what npm run calibrate and the browser test's A/B are
   measured against.

   Mono, 48 kHz, 16-bit signed:

     - **mono** because the chain is mono end to end. The script says whether it
       collapsed a dual-mono file or summed a genuinely stereo one, because
       those are not the same thing happening;
     - **48 kHz** because that is the rate the captures were trained at. An
       earlier take was 44.1 kHz, so every play of the demo resampled it on the
       way in, for nothing;
     - **16-bit** because the file is downloaded by every visitor on the demo
       path. render/wav.ts writes float for renders that are measured; this one
       is shipped.

   Nothing is aligned, mixed or transposed here any more. That machinery existed
   to build one take out of two, and it is gone with the takes it served: the
   source is now a finished performance.

   Usage:  npm run make:di
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWav, writeWav16 } from '../render/wav.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'di', 'demo-di.wav');
const RATE = 48_000;

/* Named rather than globbed: which take the demo plays is a decision, not an
   accident of the filesystem. */
const SOURCE = 'octave-lead.wav';

const source = path.join(ROOT, 'assets', 'di', SOURCE);
if (!fs.existsSync(source)) {
  console.error(`\nmake:di — assets/di/${SOURCE} is missing\n`);
  process.exit(1);
}

const wav = readWav(source);
if (wav.rate !== RATE) {
  console.error(`\nmake:di — ${SOURCE} is ${wav.rate} Hz and the captures were ` +
    `trained at ${RATE}. Export it again rather than resampling it here: a ` +
    `resampler in the build is one the demo would carry silently.\n`);
  process.exit(1);
}

/**
 * Dual mono or a real stereo take. Collapsing the second by taking one side
 * would quietly change the demo, so which happened is reported.
 *
 * The two are told apart by how far the difference signal sits below the take
 * itself, not by an absolute epsilon: a mono part exported as a float stereo
 * file carries a few parts in ten million of difference between its sides, and
 * an absolute threshold called that a stereo recording. This one measures
 * -112 dB, which is arithmetic, not an image. Anything above -60 dB is
 * something somebody did on purpose.
 */
const STEREO_FLOOR_DB = -60;

function collapse(channels) {
  if (channels.length === 1) return { data: Float32Array.from(channels[0]), how: 'mono source' };
  const [left, right] = channels;
  let diffSq = 0, leftSq = 0;
  for (let i = 0; i < left.length; i++) {
    const d = left[i] - right[i];
    diffSq += d * d;
    leftSq += left[i] * left[i];
  }
  const spread = 20 * Math.log10(
    Math.sqrt(diffSq / left.length) / (Math.sqrt(leftSq / left.length) || 1e-12) || 1e-12,
  );
  if (spread < STEREO_FLOOR_DB) {
    return { data: Float32Array.from(left), how: `dual mono (sides ${spread.toFixed(0)} dB apart), left taken` };
  }
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) out[i] = 0.5 * (left[i] + right[i]);
  return { data: out, how: `true stereo (sides ${spread.toFixed(0)} dB apart), summed` };
}

const { data, how } = collapse(wav.channels);

let peak = 0, sumSq = 0;
for (let i = 0; i < data.length; i++) {
  const a = Math.abs(data[i]);
  if (a > peak) peak = a;
  sumSq += data[i] * data[i];
}

/* A DI is limited nowhere downstream, so a sample over full scale is a click.
   Nothing else is touched: the level of the take is the level the player
   recorded, and it is what the per-capture trims and the A/B makeup gain are
   measured against. */
const CEILING = Math.pow(10, -1 / 20);
let held = false;
if (peak > CEILING) {
  const g = CEILING / peak;
  for (let i = 0; i < data.length; i++) data[i] *= g;
  held = true;
}

const db = (v) => (20 * Math.log10(v || 1e-9)).toFixed(1);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
writeWav16(OUT, RATE, [data]);
const bytes = fs.statSync(OUT).size;

console.log(`\nmake:di\n`);
console.log(`  ${SOURCE.padEnd(20)} ${(data.length / RATE).toFixed(2)} s   ` +
  `${wav.channels.length} ch in   ${how}`);
console.log(`\n  public/di/demo-di.wav   ${(data.length / RATE).toFixed(2)} s   ` +
  `mono ${RATE} Hz 16-bit   ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  peak ${db(held ? CEILING : peak)} dBFS   ` +
  `rms ${db(Math.sqrt(sumSq / data.length))} dBFS` +
  (held ? '   (brought under -1 dBFS)' : '') + '\n');
