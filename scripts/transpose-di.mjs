/* =============================================================================
   scripts/transpose-di.mjs — transposes a DI take, keeping its timing
   -----------------------------------------------------------------------------
       node scripts/transpose-di.mjs assets/di/riff-a-12.flac -24 assets/di/riff-a-24.wav

   Pitch and time are one thing in a recording, so moving one without the other
   means rebuilding the signal: the take is stretched by the inverse of the
   pitch ratio, then resampled back, which lands the pitch where it was asked
   for and the length where it started.

   **Phase-locked, not a plain phase vocoder.** Advancing every bin's phase
   independently lets the bins of one partial drift apart between frames, and a
   guitar comes back sounding underwater — the classic vocoder smear, and it is
   worst on exactly what matters here, the pick attack. Each frame's spectrum is
   therefore split at its own peaks and every bin in a peak's region is given the
   peak's phase advance (Laroche & Dolson's identity phase locking), so a partial
   stays one thing across the whole shift.

   Even so, two octaves is a long way to move a recording, and this is not free:
   attacks soften. The alternative is worse — resampling alone is perfect and
   makes the take four times longer, which is not a transposition, it is a
   slowdown.

   Chromium decodes the input, for the reason scripts/make-di.mjs uses it: it is
   the decoder the product itself runs.

   **The result is checked against the request before it is written.** Every way
   this can be wrong is silent — the length comes out right whichever direction
   the pitch went, so a take transposed the wrong way looks correct in every
   respect except the one that matters. Down 24 came out up 24 twice while it
   was being written. The check aligns the input's and the output's spectra on a
   log-frequency axis and refuses to write a file that did not land within a
   quarter tone of what was asked for.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

import { writeWav16 } from '../render/wav.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [inFile, semitoneArg, outFile] = process.argv.slice(2);
if (!inFile || semitoneArg === undefined || !outFile) {
  console.error('\nusage: node scripts/transpose-di.mjs <in> <semitones> <out.wav>\n');
  process.exit(1);
}
const SEMITONES = Number(semitoneArg);
const RATE = 48_000;
const N = 4096;                 // ~85 ms: long enough to resolve a low guitar partial
/* Analysis reads at 75 % overlap, which is what the phase estimate needs, and
   synthesis writes at that hop times the stretch. Getting this pair the wrong
   way round is silent: writing at a hop of N leaves the output frames without
   overlap at all, and the Hann-squared normalisation then divides by nearly
   zero at every frame edge — it came out at +62 dBFS. */
const ANA_HOP = N / 4;

/* ------------------------------- decode ---------------------------------- */

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
const decoded = await page.evaluate(async ([bytes, rate]) => {
  const ctx = new OfflineAudioContext(1, 1, rate);
  const buf = await ctx.decodeAudioData(new Uint8Array(bytes).buffer);
  return { rate: buf.sampleRate, data: [...buf.getChannelData(0)] };
}, [[...fs.readFileSync(path.resolve(ROOT, inFile))], RATE]);
await browser.close();

const input = Float32Array.from(decoded.data);
/* Playing a recording at speed s multiplies its pitch by s and divides its
   length by s. So to move the pitch by `ratio` and leave the length alone:
   stretch the take BY `ratio` first, then read it back at speed `ratio`. The
   two length changes cancel and the pitch move is the read.
   Getting this backwards — stretching by 1/ratio and reading at 1/ratio — also
   lands the length exactly where it started, which is why it looks right, and
   transposes the wrong way. Down 24 came out up 24, and only the spectrum
   said so. */
const ratio = Math.pow(2, SEMITONES / 12);      // pitch factor: 0.25 at -24

/* --------------------------------- FFT ----------------------------------- */

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const xr = re[i + k + len / 2], xi = im[i + k + len / 2];
        const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/* ------------------------- stretch, then resample ------------------------- */

const window = new Float64Array(N);
for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

const synthHop = Math.max(1, Math.round(ANA_HOP * ratio));
const anaHop = ANA_HOP;
const frames = Math.max(1, Math.floor((input.length - N) / anaHop));
const stretched = new Float64Array(frames * synthHop + N);
const norm = new Float64Array(stretched.length);

const lastPhase = new Float64Array(N / 2 + 1);
const sumPhase = new Float64Array(N / 2 + 1);
const expected = (2 * Math.PI * anaHop) / N;

const re = new Float64Array(N), im = new Float64Array(N);
const mag = new Float64Array(N / 2 + 1), delta = new Float64Array(N / 2 + 1);
/* The analysis phases, kept aside. Synthesis overwrites re/im in place, and a
   locked bin needs its peak's *original* phase — reading it back out of re/im
   after the peak has been rewritten gives the synthesis phase instead, which
   is silent, self-reinforcing, and came out at +67 dBFS. */
const phaseIn = new Float64Array(N / 2 + 1);
/** Bin indices of this frame's spectral peaks, rebuilt every frame. */
const peaks = [];

for (let f = 0; f < frames; f++) {
  const at = f * anaHop;
  for (let i = 0; i < N; i++) { re[i] = input[at + i] * window[i]; im[i] = 0; }
  fft(re, im, false);

  for (let k = 0; k <= N / 2; k++) {
    mag[k] = Math.hypot(re[k], im[k]);
    const phase = Math.atan2(im[k], re[k]);
    phaseIn[k] = phase;
    /* True frequency of this bin, from how far its phase actually moved
       against how far a bin at the centre frequency would have. */
    let d = phase - lastPhase[k] - k * expected;
    d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
    // Angular frequency of this bin, in radians per sample.
    delta[k] = (k * 2 * Math.PI) / N + d / anaHop;
    lastPhase[k] = phase;
  }

  /* Identity phase locking, in three passes.
     Every bin follows the nearest spectral peak instead of itself, so the bins
     that belong to one partial stay in step and the pick attack survives.

     The passes exist because getting this wrong is not subtle. Advancing
     `sumPhase` only at the peaks leaves every other bin's phase history frozen
     at whenever it last happened to be a peak, and a bin that becomes one again
     then resumes from a stale value: at unity ratio, where this should
     reconstruct the input exactly, it produced spikes four times full scale and
     an RMS 27 dB below the input. Every bin's phase is therefore written back,
     peak or not. */
  peaks.length = 0;
  for (let k = 1; k < N / 2; k++) {
    if (mag[k] > mag[k - 1] && mag[k] > mag[k + 1] &&
        mag[k] >= (mag[k - 2] ?? 0) && mag[k] >= (mag[k + 2] ?? 0)) peaks.push(k);
  }
  if (peaks.length === 0) peaks.push(0);

  // The peaks advance first, because every other bin is measured from one.
  for (const k of peaks) {
    sumPhase[k] += delta[k] * synthHop;
    sumPhase[k] -= 2 * Math.PI * Math.round(sumPhase[k] / (2 * Math.PI));
  }

  let nearest = 0;
  for (let k = 0; k <= N / 2; k++) {
    // Peaks are ascending, so the nearest one only ever moves forward.
    while (nearest + 1 < peaks.length &&
           Math.abs(peaks[nearest + 1] - k) <= Math.abs(peaks[nearest] - k)) nearest++;
    const p = peaks[nearest];
    const phase = k === p ? sumPhase[p] : sumPhase[p] + (phaseIn[k] - phaseIn[p]);
    sumPhase[k] = phase;
    re[k] = mag[k] * Math.cos(phase);
    im[k] = mag[k] * Math.sin(phase);
    if (k > 0 && k < N / 2) { re[N - k] = re[k]; im[N - k] = -im[k]; }
  }

  fft(re, im, true);
  const out = f * synthHop;
  for (let i = 0; i < N; i++) {
    stretched[out + i] += re[i] * window[i];
    norm[out + i] += window[i] * window[i];
  }
}
for (let i = 0; i < stretched.length; i++) if (norm[i] > 1e-9) stretched[i] /= norm[i];

/* Read it back at `ratio` speed, which moves the pitch and puts the length
   back where it started. Cubic Hermite: a linear read at a fourfold rate
   change would roll the top off audibly. */
const outLength = Math.round(stretched.length / ratio);
let shifted = new Float32Array(outLength);
for (let i = 0; i < outLength; i++) {
  const pos = i * ratio;
  const i1 = Math.floor(pos), t = pos - i1;
  const p0 = stretched[i1 - 1] ?? 0, p1 = stretched[i1] ?? 0;
  const p2 = stretched[i1 + 1] ?? 0, p3 = stretched[i1 + 2] ?? 0;
  const a = 0.5 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3;
  const c = 0.5 * (-p0 + p2);
  shifted[i] = ((a * t + b) * t + c) * t + p1;
}

/* --------------------------- did it land? -------------------------------- */

function averageSpectrum(x) {
  const W = 8192, mag = new Float64Array(W / 2);
  const re = new Float64Array(W), im = new Float64Array(W);
  let frames = 0;
  for (let s = 0; s + W <= x.length; s += W / 2) {
    let e = 0;
    for (let i = 0; i < W; i++) e += x[s + i] * x[s + i];
    if (e / W < 1e-6) continue;                       // silence says nothing
    for (let i = 0; i < W; i++) {
      re[i] = x[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W));
      im[i] = 0;
    }
    fft(re, im, false);
    for (let k = 0; k < W / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  for (let k = 0; k < W / 2; k++) mag[k] /= frames || 1;
  return mag;
}

/** Onto a log-frequency axis, where a transposition is a translation. */
function logAxis(mag) {
  const BINS_PER_OCTAVE = 48, LOW = 30, HIGH = 6000;
  const M = Math.round(BINS_PER_OCTAVE * Math.log2(HIGH / LOW));
  const out = new Float64Array(M);
  for (let i = 0; i < M; i++) {
    const k = (LOW * Math.pow(2, i / BINS_PER_OCTAVE) * 8192) / RATE;
    const k0 = Math.floor(k), t = k - k0;
    out[i] = (mag[k0] ?? 0) * (1 - t) + (mag[k0 + 1] ?? 0) * t;
  }
  let max = 0;
  for (const v of out) if (v > max) max = v;
  for (let i = 0; i < M; i++) out[i] /= max || 1;
  return { out, BINS_PER_OCTAVE };
}

const before = logAxis(averageSpectrum(input));
const after = logAxis(averageSpectrum(shifted));
let bestCorr = -1, bestBins = 0;
for (let s = -before.BINS_PER_OCTAVE * 4; s <= before.BINS_PER_OCTAVE * 4; s++) {
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < before.out.length; i++) {
    const j = i + s;
    if (j < 0 || j >= after.out.length) continue;
    num += before.out[i] * after.out[j];
    da += before.out[i] * before.out[i];
    db += after.out[j] * after.out[j];
  }
  const c = num / Math.sqrt(da * db || 1);
  if (c > bestCorr) { bestCorr = c; bestBins = s; }
}
const landed = (bestBins / before.BINS_PER_OCTAVE) * 12;
if (Math.abs(landed - SEMITONES) > 0.5) {
  console.error(`\ntranspose: asked for ${SEMITONES} semitones and landed on ` +
    `${landed.toFixed(2)} (correlation ${bestCorr.toFixed(3)}). Nothing written.\n`);
  process.exit(1);
}

/* ------------------------ put it back in time ---------------------------- */
/* The vocoder delays what it is given, and by a knowable amount.
   Analysis frame f covers input samples f*anaHop..+N, so its content sits at
   f*anaHop + N/2. It is written at f*synthHop and then read at `ratio`, which
   puts it at f*anaHop + N/(2*ratio). The difference is the delay, and it grows
   with the shift: half a window at -12 semitones, three halves at -24.

   Compensated here rather than measured downstream. Two layers cut from one
   take have to line up to the sample or every note flams, and an alignment
   recovered by correlating a smeared transposition against a clean root is a
   guess — the onset correlation between them is 0.2, which is no basis for
   placing a mix. Trimming a delay that is arithmetic is not. */
const delay = Math.round((N / 2) * (1 / ratio - 1));
const timed = new Float32Array(input.length);
for (let i = 0; i < timed.length; i++) timed[i] = shifted[i + delay] ?? 0;
shifted = timed;

let inPeak = 0, outPeak = 0, inSq = 0, outSq = 0;
for (const v of input) { inPeak = Math.max(inPeak, Math.abs(v)); inSq += v * v; }
for (const v of shifted) { outPeak = Math.max(outPeak, Math.abs(v)); outSq += v * v; }

/* Levelled on RMS, not on peak.
   What a DI does to an amp is set by how hard it drives it, and that is the
   average, not the loudest sample. Two octaves of shift spreads every transient
   and costs about 10 dB of crest factor, so matching the peaks instead would
   leave this take audibly weaker into the same capture than the one it plays
   next to — the demo would sound like the amp changed at the join.
   The peak is then held under -1 dBFS, because a DI is not limited anywhere
   downstream and a sample over full scale is a click. */
const inRmsRaw = Math.sqrt(inSq / input.length);
const outRmsRaw = Math.sqrt(outSq / shifted.length);
let gain = outRmsRaw > 1e-9 ? inRmsRaw / outRmsRaw : 1;
const CEILING = Math.pow(10, -1 / 20);
let heldBack = false;
if (outPeak * gain > CEILING) { gain = CEILING / outPeak; heldBack = true; }
for (let i = 0; i < shifted.length; i++) shifted[i] *= gain;

writeWav16(path.resolve(ROOT, outFile), RATE, [shifted]);
const db = (v) => (20 * Math.log10(v || 1e-9)).toFixed(1);
console.log(`\ntranspose ${path.basename(inFile)} by ${SEMITONES >= 0 ? '+' : ''}${SEMITONES} semitones\n`);
console.log(`  landed on ${landed >= 0 ? '+' : ''}${landed.toFixed(2)} semitones, ` +
  `spectra correlate ${bestCorr.toFixed(3)}`);
console.log(`  in    ${(input.length / RATE).toFixed(2)} s   peak ${db(inPeak)} dBFS   rms ${db(inRmsRaw)} dBFS`);
console.log(`  delay compensated: ${delay} samples (${(delay / RATE * 1000).toFixed(1)} ms)`);
console.log(`  out   ${(shifted.length / RATE).toFixed(2)} s   peak ${db(outPeak * gain)} dBFS   ` +
  `rms ${db(outRmsRaw * gain)} dBFS   ` +
  (heldBack ? '(held under -1 dBFS, so the RMS falls short)' : '(levelled to the input\'s RMS)'));
console.log(`  ${outFile}\n`);
