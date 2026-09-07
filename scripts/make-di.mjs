/* =============================================================================
   scripts/make-di.mjs — builds the demo DI from the source takes
   -----------------------------------------------------------------------------
   Mixes the riff takes in assets/di/ on top of each other and writes
   public/di/demo-di.wav, which is what the demo path plays and what
   npm run calibrate and the latency harness measure against.

   They are layers, not a sequence: the same performance an octave apart, so
   every note rings against its own octave. That only works if they are aligned
   to the sample, and the transposed take comes back from the vocoder a little
   longer than it went in — so the offset is measured here by cross-correlating
   the two envelopes, not assumed to be zero.

   **Chromium is the decoder**, through Playwright, which the test suite already
   depends on. It is not a workaround for a missing ffmpeg: it is the same
   decoder the product itself uses on the take at runtime, so what is measured
   offline and what a visitor hears come from one implementation rather than
   two that agree until they do not.

   Mono, 48 kHz, 16-bit signed:

     - **mono** because the chain is mono end to end, and because these takes
       are dual mono anyway (the script says so if that ever stops being true);
     - **48 kHz** because that is the rate the captures were trained at. The
       take this replaced was 44.1 kHz, so every play of the demo resampled it
       on the way in, for nothing;
     - **16-bit** because a DI is 16-bit at the source and the file is
       downloaded by every visitor on the demo path. render/wav.ts writes float
       for renders that are measured; this one is shipped.

   Usage:  npm run make:di
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { writeWav16 } from '../render/wav.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'assets', 'di');
const OUT = path.join(ROOT, 'public', 'di', 'demo-di.wav');
const RATE = 48_000;

/* The layers, and how loud each sits in the mix. Named rather than globbed: what
   the demo sounds like is a decision, not an accident of the filesystem.

   The first entry is the reference — everything else is aligned to it and the
   finished mix is levelled back to it, so changing the layers cannot quietly
   change how hard the demo drives the amp.

   **Both layers come from the same take**, and they have to. `riff-a.flac` and
   `riff-a-12.flac` are two separate performances of the riff rather than one
   performance recorded twice: their onsets correlate at 0.074, where two takes
   of one performance correlate near one. Mixing those two would not be an
   octave harmony, it would be a flam on every note, and no global offset fixes
   a performance that was played differently.

   So the octave is made from the root: `riff-a-down12.wav` is `riff-a.flac`
   transposed down twelve semitones by scripts/transpose-di.mjs. Alignment is
   then a property of how the file was made rather than something to hope for,
   and what is left to measure is only the vocoder's own delay.

   The octave sits under the root rather than beside it: an octave down carries
   most of its energy where a guitar cabinet is already loudest, and at equal
   level it stops sounding like a harmony and starts sounding like mud. */
const LAYERS = [
  { file: 'riff-a.flac', gainDb: 0 },
  { file: 'riff-a-down12.wav', gainDb: -4 },
];

const missing = LAYERS.map((l) => l.file).filter((f) => !fs.existsSync(path.join(SRC, f)));
if (missing.length > 0) {
  console.error(`\nmake:di — missing from assets/di/: ${missing.join(', ')}\n`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

const takes = [];
for (const { file: name } of LAYERS) {
  const bytes = [...fs.readFileSync(path.join(SRC, name))];
  const info = await page.evaluate(async ([data, rate]) => {
    const ctx = new OfflineAudioContext(1, 1, rate);
    const buf = await ctx.decodeAudioData(new Uint8Array(data).buffer);
    const chans = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push([...buf.getChannelData(c)]);
    return { rate: buf.sampleRate, frames: buf.length, channels: chans };
  }, [bytes, RATE]);
  takes.push({ name, ...info });
}
await browser.close();

/* Dual mono or a real stereo take: worth knowing, because collapsing a real
   stereo image by taking one side would quietly change the demo. */
function collapse(channels) {
  if (channels.length === 1) return { data: Float32Array.from(channels[0]), how: 'mono source' };
  const [l, r] = channels;
  let diff = 0;
  for (let i = 0; i < l.length; i++) { const d = Math.abs(l[i] - r[i]); if (d > diff) diff = d; }
  if (diff < 1e-6) return { data: Float32Array.from(l), how: 'dual mono, left taken' };
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = 0.5 * (l[i] + r[i]);
  return { data: out, how: `true stereo (channels differ by ${diff.toFixed(4)}), summed` };
}

console.log('\nmake:di\n');
const parts = [];
for (const take of takes) {
  if (take.rate !== RATE) {
    console.error(`  ${take.name}: decoded at ${take.rate} Hz, expected ${RATE}`);
    process.exit(1);
  }
  const { data, how } = collapse(take.channels);
  let peak = 0;
  for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
  console.log(`  ${take.name.padEnd(18)} ${(data.length / RATE).toFixed(2).padStart(6)} s   ` +
    `peak ${(20 * Math.log10(peak || 1e-9)).toFixed(1).padStart(6)} dBFS   ${how}`);
  parts.push(data);
}

/* ------------------------- align, then mix ------------------------------- */

/**
 * Where a take sits against the reference, in samples.
 *
 * Two takes an octave apart share almost no waveform — that is the whole point
 * of them — but they share their phrasing exactly, so the alignment has to be
 * made on what a performance does rather than on what it sounds like.
 *
 * This is a **fine** alignment and nothing more. The vocoder's delay is
 * arithmetic and scripts/transpose-di.mjs already takes it out, so what is left
 * here is a few milliseconds of residue — and a few milliseconds between two
 * copies of one note is a comb filter, which is exactly the sound this mix must
 * not have.
 *
 * On the envelope rather than on onsets: a transposition smears attacks badly
 * enough that the onset function correlates at 0.2 between a take and its own
 * octave, where the envelope holds 0.7. There is no note-start left to find,
 * only a shape.
 */
function onsets(x, decimate) {
  const n = Math.floor(x.length / decimate);
  const env = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (let k = i * decimate; k < (i + 1) * decimate; k++) {
      const a = x[k] < 0 ? -x[k] : x[k];
      if (a > peak) peak = a;
    }
    env[i] = peak;
  }
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n || 1;
  for (let i = 0; i < n; i++) env[i] -= mean;
  return env;
}

function offsetAgainst(reference, take, maxSeconds) {
  const D = 16;                                    // 48 kHz -> 3 kHz, ~0.3 ms
  const a = onsets(reference, D), b = onsets(take, D);
  const limit = Math.round((maxSeconds * RATE) / D);
  let best = -Infinity, at = 0;
  for (let s = -limit; s <= limit; s++) {
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + s;
      if (j < 0 || j >= b.length) continue;
      num += a[i] * b[j]; da += a[i] * a[i]; db += b[j] * b[j];
    }
    const c = num / Math.sqrt(da * db || 1);
    if (c > best) { best = c; at = s; }
  }
  return { samples: at * D, correlation: best };
}

const reference = parts[0];
const aligned = [reference];
/* Half the window the vocoder's own compensation could plausibly be out by.
   A layer that needs more than this is not a residue, it is a different
   performance, and no offset makes those two into an octave harmony. */
const FINE_WINDOW_MS = 25;
for (let i = 1; i < parts.length; i++) {
  const { samples, correlation } = offsetAgainst(reference, parts[i], FINE_WINDOW_MS / 1000);
  console.log(`  ${LAYERS[i].file.padEnd(20)} trimmed ${String(samples).padStart(5)} samples ` +
    `(${(samples / RATE * 1000).toFixed(1)} ms), envelopes correlate ${correlation.toFixed(3)}`);
  if (Math.abs(samples) >= (FINE_WINDOW_MS / 1000) * RATE - 1) {
    console.error(`\n  ${LAYERS[i].file} is still ${(samples / RATE * 1000).toFixed(0)} ms out ` +
      `at the edge of a ${FINE_WINDOW_MS} ms search, which means it is not the same ` +
      'performance as ' + LAYERS[0].file + ' rather than a delay to trim.\n');
    process.exit(1);
  }
  /* A positive offset means the take runs ahead of the reference, so it is read
     from further in. Length is settled below by the shortest layer. */
  const shifted = new Float32Array(parts[i].length);
  for (let k = 0; k < shifted.length; k++) shifted[k] = parts[i][k + samples] ?? 0;
  aligned.push(shifted);
}

const length = Math.min(...aligned.map((p) => p.length));
const out = new Float32Array(length);
for (let i = 0; i < aligned.length; i++) {
  const g = Math.pow(10, LAYERS[i].gainDb / 20);
  const layer = aligned[i];
  for (let k = 0; k < length; k++) out[k] += layer[k] * g;
}

/* Levelled back to the reference take's RMS.
   How hard the DI drives the capture is the average, not the loudest sample,
   and it is baked into things measured elsewhere — the per-capture trims from
   npm run calibrate and the A/B makeup gain in engine.ts. Summing two layers
   without putting the level back would move both. */
let refSq = 0, mixSq = 0;
for (let i = 0; i < length; i++) refSq += reference[i] * reference[i];
for (let i = 0; i < length; i++) mixSq += out[i] * out[i];
const refRms = Math.sqrt(refSq / length), mixRms = Math.sqrt(mixSq / length);
let gain = mixRms > 1e-9 ? refRms / mixRms : 1;

let rawPeak = 0;
for (let i = 0; i < length; i++) { const a = Math.abs(out[i]); if (a > rawPeak) rawPeak = a; }
/* A DI is limited nowhere downstream, so a sample over full scale is a click. */
const CEILING = Math.pow(10, -1 / 20);
let heldBack = false;
if (rawPeak * gain > CEILING) { gain = CEILING / rawPeak; heldBack = true; }
for (let i = 0; i < length; i++) out[i] *= gain;

let peak = 0, outSq = 0;
for (let i = 0; i < out.length; i++) {
  const a = Math.abs(out[i]);
  if (a > peak) peak = a;
  outSq += out[i] * out[i];
}
const db = (v) => (20 * Math.log10(v || 1e-9)).toFixed(1);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
writeWav16(OUT, RATE, [out]);
const bytes = fs.statSync(OUT).size;
console.log(`\n  public/di/demo-di.wav   ${(out.length / RATE).toFixed(2)} s   ` +
  `mono ${RATE} Hz 16-bit   ${(bytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  peak ${db(peak)} dBFS   rms ${db(Math.sqrt(outSq / out.length))} dBFS   ` +
  `(reference rms ${db(refRms)} dBFS` +
  (heldBack ? ', held under -1 dBFS so the mix falls short' : '') + ')\n');
