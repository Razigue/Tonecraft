/* =============================================================================
   scripts/bench-nam.mjs — how long the amp model takes per render quantum
   -----------------------------------------------------------------------------
   Runs public/nam/nam.wasm on a capture, 128 frames at a time, exactly as the
   worklet does, and reports the time per block. The budget is one quantum:
   2.67 ms at 48 kHz. Exceeding it is not latency, it is a crackle (NFR-1).

   The glue is loaded into a sandbox shaped like an AudioWorkletGlobalScope —
   no window, no importScripts, no process — so this also proves the build
   comes up where it will actually run.

   Usage:  npm run bench:nam [-- other/dir/with/nam.wasm+nam-glue.js ...]
           Extra directories are benchmarked against public/nam and the
           outputs compared, which is how a rebuild is shown to be the same
           engine and not a different one.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 48_000;
const BLOCKS = 6000;
const QUANTUM_US = (128 / SR) * 1e6;

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/models/index.json'), 'utf8'));
const captureFile = catalog.models[0]?.file;
if (!captureFile) { console.error('no capture installed: run `npm run vendor`'); process.exit(1); }
const MODEL = fs.readFileSync(path.join(ROOT, 'public/models', captureFile), 'utf8');

function loadInSandbox(glueFile) {
  const sandbox = {
    console, WebAssembly, TextDecoder, TextEncoder, Math, JSON, Promise, Error, TypeError,
    RangeError, Object, Array, Number, String, Symbol, Map, Set, Reflect, Proxy, Function,
    RegExp, Date, Boolean, DataView, ArrayBuffer, Uint8Array, Int8Array, Uint16Array,
    Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, BigInt64Array,
    BigUint64Array, setTimeout, performance, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(glueFile, 'utf8'), sandbox, { filename: glueFile });
  if (typeof sandbox.createNamModule !== 'function') {
    throw new Error(`${glueFile} did not publish createNamModule on globalThis`);
  }
  return sandbox.createNamModule;
}

async function engine(dir) {
  const glue = ['nam-glue.js', 'nam.js'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  if (!glue) throw new Error(`no glue in ${dir}`);
  const mod = await loadInSandbox(glue)({ wasmBinary: fs.readFileSync(path.join(dir, 'nam.wasm')) });
  mod._nam_setSampleRate(SR);
  mod._nam_setMaxBufferSize(512);
  const id = mod._nam_createInstance();
  const len = mod.lengthBytesUTF8(MODEL) + 1;
  const p = mod._malloc(len);
  mod.stringToUTF8(MODEL, p, len);
  const ok = mod._nam_loadModel(id, p);
  mod._free(p);
  if (!ok) throw new Error(`${dir}: the capture did not load`);
  return { mod, id, inPtr: mod._malloc(512 * 4), outPtr: mod._malloc(512 * 4) };
}

/** A plucked low note with a little noise: what a guitar actually sends. */
function testSignal() {
  const x = new Float32Array(BLOCKS * 128);
  let seed = 12345;
  for (let i = 0; i < x.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const t = i / SR;
    x[i] = 0.08 * Math.sin(2 * Math.PI * 110 * t) * Math.exp(-(t % 1) * 3)
      + 0.002 * (seed / 0x3fffffff - 1);
  }
  return x;
}

function run(e, input) {
  const out = new Float32Array(input.length);
  const times = new Float64Array(BLOCKS);
  for (let b = 0; b < BLOCKS; b++) {
    e.mod.HEAPF32.set(input.subarray(b * 128, b * 128 + 128), e.inPtr >> 2);
    const t0 = process.hrtime.bigint();
    e.mod._nam_process(e.id, e.inPtr, e.outPtr, 128);
    times[b] = Number(process.hrtime.bigint() - t0) / 1000;
    // HEAPF32 is re-read: memory can move when it grows.
    out.set(e.mod.HEAPF32.subarray(e.outPtr >> 2, (e.outPtr >> 2) + 128), b * 128);
  }
  return { out, times };
}

const dirs = [path.join(ROOT, 'public', 'nam'), ...process.argv.slice(2).map((d) => path.resolve(d))];
const input = testSignal();
const outputs = [];

console.log(`\nNAM engine, ${catalog.models[0].name}, 128-frame blocks at 48 kHz` +
  ` (budget ${QUANTUM_US.toFixed(0)} us)\n`);
for (const dir of dirs) {
  const r = run(await engine(dir), input);
  const steady = Array.from(r.times.subarray(1000)).sort((a, b) => a - b);
  const med = steady[steady.length >> 1];
  const p99 = steady[Math.floor(steady.length * 0.99)];
  const first = Array.from(r.times.subarray(0, 10)).map((t) => t.toFixed(0)).join(' ');
  console.log(`  ${path.relative(ROOT, dir) || '.'}`);
  console.log(`    median ${med.toFixed(0).padStart(5)} us   p99 ${p99.toFixed(0).padStart(5)} us` +
    `   ${(100 * med / QUANTUM_US).toFixed(1)}% of a core at the median`);
  console.log(`    first ten blocks: ${first} us`);
  outputs.push(r.out);
}

for (let i = 1; i < outputs.length; i++) {
  const a = outputs[0], b = outputs[i];
  let maxd = 0, e = 0, ea = 0;
  for (let k = SR; k < a.length; k++) {
    const d = Math.abs(a[k] - b[k]);
    if (d > maxd) maxd = d;
    e += d * d; ea += a[k] * a[k];
  }
  console.log(`\n  ${path.relative(ROOT, dirs[i])} against public/nam: max |diff| ${maxd.toExponential(2)},` +
    ` ${(10 * Math.log10(e / ea)).toFixed(1)} dB relative to the signal`);
}
console.log();
