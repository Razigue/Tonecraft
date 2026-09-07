/* =============================================================================
   scripts/make-di.mjs — builds the demo DI from the source takes
   -----------------------------------------------------------------------------
   Joins the riff takes in assets/di/ end to end and writes public/di/demo-di.wav,
   which is what the demo path plays and what npm run calibrate and the latency
   harness measure against.

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

/* The order they are played in. Named rather than globbed: the take order is a
   decision about what the demo sounds like, not an accident of the filesystem.

   `riff-a-24.wav` is `riff-a-12.flac` transposed down two octaves by
   scripts/transpose-di.mjs, which puts it an octave below the base riff. Kept
   as a file rather than transposed here, because it takes minutes to make and
   the result is a source the demo is built from, not a step in building it. */
const TAKES = ['riff-a.flac', 'riff-a-24.wav'];

/* A short silence between takes. Two performances butted together click, and a
   click through a high-gain capture is not a click, it is a crack. */
const GAP_SECONDS = 0.35;

const missing = TAKES.filter((f) => !fs.existsSync(path.join(SRC, f)));
if (missing.length > 0) {
  console.error(`\nmake:di — missing from assets/di/: ${missing.join(', ')}\n`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');

const takes = [];
for (const name of TAKES) {
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

const gap = Math.round(GAP_SECONDS * RATE);
const total = parts.reduce((n, p) => n + p.length, 0) + gap * (parts.length - 1);
const out = new Float32Array(total);
let at = 0;
for (let i = 0; i < parts.length; i++) {
  out.set(parts[i], at);
  at += parts[i].length + (i < parts.length - 1 ? gap : 0);
}

/* The join is silent by construction, but a take that does not end at zero
   still steps. A 5 ms ramp either side of every gap costs nothing audible and
   cannot click. */
const ramp = Math.round(0.005 * RATE);
at = 0;
for (let i = 0; i < parts.length; i++) {
  const start = at, end = at + parts[i].length;
  for (let k = 0; k < ramp; k++) {
    const g = k / ramp;
    if (i > 0) out[start + k] *= g;
    if (i < parts.length - 1) out[end - 1 - k] *= g;
  }
  at = end + (i < parts.length - 1 ? gap : 0);
}

let peak = 0;
for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }

fs.mkdirSync(path.dirname(OUT), { recursive: true });
writeWav16(OUT, RATE, [out]);
const bytes = fs.statSync(OUT).size;
console.log(`\n  public/di/demo-di.wav   ${(out.length / RATE).toFixed(2)} s   ` +
  `mono ${RATE} Hz 16-bit   peak ${(20 * Math.log10(peak || 1e-9)).toFixed(1)} dBFS   ` +
  `${(bytes / 1024 / 1024).toFixed(2)} MB\n`);
