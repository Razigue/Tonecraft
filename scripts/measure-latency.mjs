/* =============================================================================
   scripts/measure-latency.mjs — what the chain itself adds, in samples
   -----------------------------------------------------------------------------
   The round trip on screen is dominated by the operating system and the
   device. This measures the part that is ours: what each node type delays a
   signal by inside Chromium, and what the boost's oversampler delays it by
   inside the frontend worklet. Both are measured, not read off a datasheet,
   because the number that mattered most was not on one: a WaveShaperNode at
   '4x' delays by 192 frames, and nothing in the specification says so.

   Two parts:

     1. Chromium, through an OfflineAudioContext: an impulse through each node
        the graph uses, and the position of the peak on the way out. Needs
        `npx playwright install chromium` once.
     2. The frontend worklet, in Node: a 1 kHz burst through the boost path,
        cross-correlated with itself on the way out.

   Usage:  npm run measure:latency
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;

/* ----------------------------- 1. the browser ---------------------------- */

async function browserLatencies() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  const result = await page.evaluate(async (sr) => {
    const N = 4096;
    async function lag(build) {
      const ctx = new OfflineAudioContext(1, N, sr);
      const buf = ctx.createBuffer(1, N, sr);
      buf.getChannelData(0)[100] = 0.5;     // inside every stage's linear range
      const src = new AudioBufferSourceNode(ctx, { buffer: buf });
      const node = build(ctx);
      src.connect(node);
      node.connect(ctx.destination);
      src.start(0);
      const out = (await ctx.startRendering()).getChannelData(0);
      let peak = 0, at = -1;
      for (let i = 0; i < N; i++) if (Math.abs(out[i]) > peak) { peak = Math.abs(out[i]); at = i; }
      return at - 100;
    }
    const curve = new Float32Array(4096);
    for (let i = 0; i < 4096; i++) {
      const x = (i / 4095) * 2 - 1, a = Math.abs(x), t = 0.7;
      curve[i] = a <= t ? x : Math.sign(x) * (t + (1 - t) * Math.tanh((a - t) / (1 - t)));
    }
    const shaper = (oversample) => (ctx) => new WaveShaperNode(ctx, { curve, oversample });
    const convolver = (seconds) => (ctx) => {
      const c = new ConvolverNode(ctx, { disableNormalization: true });
      const ir = ctx.createBuffer(2, Math.floor(sr * seconds), sr);
      ir.getChannelData(0)[0] = 1; ir.getChannelData(1)[0] = 1;
      c.buffer = ir;
      return c;
    };
    return {
      'GainNode': await lag((ctx) => new GainNode(ctx)),
      'BiquadFilterNode': await lag((ctx) => new BiquadFilterNode(ctx, { type: 'peaking', frequency: 650, Q: 0.9 })),
      'ConvolverNode, 1024-tap cabinet': await lag(convolver(1024 / sr)),
      'ConvolverNode, 1.3 s reverb': await lag(convolver(1.3)),
      "WaveShaperNode, oversample 'none'": await lag(shaper('none')),
      "WaveShaperNode, oversample '2x'": await lag(shaper('2x')),
      "WaveShaperNode, oversample '4x' (the old limiter)": await lag(shaper('4x')),
    };
  }, SR);
  await browser.close();
  return result;
}

/* ----------------------------- 2. the worklet ---------------------------- */

function loadFrontend() {
  const registry = {};
  const sandbox = {
    sampleRate: SR, Math, console, Float32Array, Float64Array, Uint8Array,
    AudioWorkletProcessor: class { port = { postMessage() {}, onmessage: null }; },
    registerProcessor: (n, c) => { registry[n] = c; },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/nam/frontend-worklet.js'), 'utf8'), sandbox);
  return registry.frontend;
}

/** Delay through the boost path, in samples, by cross-correlation. */
function frontendLatency(boost) {
  const Processor = loadFrontend();
  const p = new Processor();
  const inputs = [[new Float32Array(128)]], outputs = [[new Float32Array(128)]];
  const params = { inputGain: [1], gate: [-100], boost: [boost], boostTone: [1] };
  for (let b = 0; b < 400; b++) p.process(inputs, outputs, params);   // settle the smoothers

  const N = 128 * 40, x = new Float64Array(N), y = new Float64Array(N);
  for (let b = 0; b < 40; b++) {
    for (let i = 0; i < 128; i++) {
      const n = b * 128 + i;
      // A quiet burst: the stage must stay linear for the correlation to mean a delay.
      x[n] = n > 2000 && n < 3000 ? 0.001 * Math.sin(2 * Math.PI * 1000 * n / SR) : 0;
      inputs[0][0][i] = x[n];
    }
    p.process(inputs, outputs, params);
    for (let i = 0; i < 128; i++) y[b * 128 + i] = outputs[0][0][i];
  }
  const corr = (l) => { let s = 0; for (let n = 2000; n < 3100; n++) { const m = n + l; if (m >= 0 && m < N) s += x[n] * y[m]; } return s; };
  let best = -Infinity, lag = 0;
  for (let l = -5; l < 200; l++) { const s = corr(l); if (s > best) { best = s; lag = l; } }
  const a = corr(lag - 1), b = corr(lag), c = corr(lag + 1);
  const frac = (a - c) / (2 * (a - 2 * b + c));
  return lag + (Number.isFinite(frac) ? frac : 0);
}

/* --------------------------------- report -------------------------------- */

const ms = (frames) => `${frames.toFixed(1).padStart(6)} frames = ${((frames / SR) * 1000).toFixed(2).padStart(5)} ms at 48 kHz`;

console.log('\nChromium, impulse through one node:\n');
for (const [name, frames] of Object.entries(await browserLatencies())) {
  console.log(`  ${name.padEnd(52)} ${ms(frames)}`);
}

console.log('\nFrontend worklet, boost path (the 4x oversampler):\n');
console.log(`  ${'boost off (bypassed)'.padEnd(52)} ${ms(frontendLatency(0))}`);
console.log(`  ${'boost at 5% (linear, the oversampler alone)'.padEnd(52)} ${ms(frontendLatency(0.05))}`);
console.log();
