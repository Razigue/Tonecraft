/* =============================================================================
   scripts/build-nam.mjs — compiles the NAM engine to WebAssembly, with SIMD
   -----------------------------------------------------------------------------
   Produces public/nam/nam.wasm and public/nam/nam-glue.js from
   NeuralAmpModelerCore (MIT, Steven Atkinson) and dsp/nam-engine.cpp.

   Why we build it rather than vendor it: the prebuilt @opendaw/nam-wasm binary
   is scalar. On the shipped captures this build runs the model in 2.9x less
   time (scripts/bench-nam.mjs measures both), and the CPU budget is the
   dropout budget — a weak laptop that crackled on the vendored engine holds
   with this one. NFR-14 also asks for -msimd128, which the vendored build
   did not satisfy.

   Flags, and what each one was measured to be worth on a 128-frame block of
   the JSX Ultra capture (median, this machine; the shipped scalar build took
   352 us):
     -O3 -msimd128 -flto                 254 us   LLVM's own vectorisation
     + -msse4.1                          226 us   Eigen's packet math runs on
                                                  emulated SSE, which is the
                                                  only way Eigen vectorises
                                                  under WebAssembly
     - NAM_USE_INLINE_GEMM               120 us   NAM core's hand-inlined GEMM
                                                  is slower than Eigen's here;
                                                  it is off
     -mavx instead of -msse4.1           same     not worth the emulation
   EIGEN_STACK_ALLOCATION_LIMIT=0 keeps Eigen's temporaries off the (small)
   WebAssembly stack; it costs nothing measurable. -fwasm-exceptions is native
   exception handling, zero-cost when nothing throws: a malformed capture is a
   refused load rather than a dead engine. See dsp/nam-engine.cpp.

   Prerequisites: an Emscripten SDK. Either `EMSDK` points at one, or
   .toolchain/emsdk exists (gitignored), or em++ is on PATH. Git and network
   access are needed once, to fetch the pinned NAM core sources into .nam-src/
   (gitignored).

   Usage:  npm run build:nam
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '.nam-src');
const OUT = path.join(ROOT, 'public', 'nam');

const CORE_REPO = 'https://github.com/sdatkinson/NeuralAmpModelerCore.git';
// Pinned: the engine identity a tone link relies on (AD-10). Bumping it is a
// deliberate change, re-measured with scripts/bench-nam.mjs.
const CORE_TAG = 'v0.5.3';

const log = (...a) => console.log(...a);

/* ------------------------------ the compiler ----------------------------- */
function findCompiler() {
  const exe = process.platform === 'win32' ? 'em++.exe' : 'em++';
  const candidates = [];
  if (process.env.EMSDK) candidates.push(path.join(process.env.EMSDK, 'upstream', 'emscripten', exe));
  candidates.push(path.join(ROOT, '.toolchain', 'emsdk', 'upstream', 'emscripten', exe));
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const sdk = path.resolve(c, '..', '..', '..');
      return { bin: c, env: { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') } };
    }
  }
  return { bin: 'em++', env: process.env };
}

/* ------------------------------- the sources ----------------------------- */
function fetchCore() {
  if (fs.existsSync(path.join(SRC, 'NAM', 'dsp.h'))) return;
  log(`  cloning NeuralAmpModelerCore ${CORE_TAG} into .nam-src/ ...`);
  execSync(
    `git clone --quiet --recursive --depth 1 --branch ${CORE_TAG} ${CORE_REPO} "${SRC}"`,
    { stdio: 'inherit' },
  );
}

function sources() {
  const glob = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.cpp')).map((f) => path.join(dir, f));
  return [
    ...glob(path.join(SRC, 'NAM')),
    ...glob(path.join(SRC, 'NAM', 'wavenet')),
    path.join(ROOT, 'dsp', 'nam-engine.cpp'),
  ];
}

/* --------------------------------- build --------------------------------- */
function build() {
  const { bin, env } = findCompiler();
  const tmp = fs.mkdtempSync(path.join(ROOT, '.nam-build-'));
  const js = path.join(tmp, 'nam.js');
  const args = [
    '-std=c++20', '-O3', '-msimd128', '-msse4.1', '-flto',
    '-fwasm-exceptions', '-fno-rtti',
    // Web Audio is float32; double would halve the SIMD width for nothing.
    '-DNAM_SAMPLE_FLOAT',
    '-DEIGEN_STACK_ALLOCATION_LIMIT=0',
    '-DNAM_ENABLE_A2_FAST',
    '-I', SRC,
    '-I', path.join(SRC, 'Dependencies', 'eigen'),
    '-I', path.join(SRC, 'Dependencies', 'nlohmann'),
    ...sources(),
    '--no-entry',
    // A classic script: the worklet's global scope has no module loader for
    // this, and nam-processor.js reads the factory off globalThis.
    '-sMODULARIZE=1', '-sEXPORT_NAME=createNamModule',
    '-sENVIRONMENT=web,worker,node',
    // No SharedArrayBuffer, no threads (NFR-13): a plain heap that grows.
    '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=32MB',
    // JSON parsing is the deepest stack user; it lives in linear memory.
    '-sSTACK_SIZE=4MB',
    '-sINCOMING_MODULE_JS_API=wasmBinary,locateFile,instantiateWasm,onRuntimeInitialized,print,printErr',
    '-sEXPORTED_FUNCTIONS=_malloc,_free',
    '-sEXPORTED_RUNTIME_METHODS=stringToUTF8,lengthBytesUTF8,UTF8ToString,HEAPF32,HEAPU8',
    // Models arrive as strings; no filesystem, no eval in the glue.
    '-sFILESYSTEM=0', '-sDYNAMIC_EXECUTION=0',
    '-o', js,
  ];
  log(`  ${path.basename(bin)} ... (about a minute)`);
  try {
    execFileSync(bin, args, { env, stdio: 'inherit' });
  } finally {
    if (!fs.existsSync(js)) fs.rmSync(tmp, { recursive: true, force: true });
  }

  const wasm = fs.readFileSync(path.join(tmp, 'nam.wasm'));
  let glue = fs.readFileSync(js, 'utf8');
  if (/import\.meta/.test(glue)) throw new Error('import.meta in the glue: it must be a classic script');
  if (/^\s*export\s/m.test(glue)) throw new Error('an export survives in the glue');

  /* AudioWorklet.addModule() evaluates its scripts as ES modules, so a
     top-level `var` stays inside the module scope and is not visible from the
     other scripts added to the same worklet. The factory is published on
     globalThis explicitly. Without this, nam-processor.js cannot find the
     engine and passes the signal through — silently, the worst failure. */
  glue += '\n;globalThis.createNamModule = createNamModule;\n';

  const header =
    `/* NeuralAmpModelerCore ${CORE_TAG} — MIT, (c) Steven Atkinson — compiled to\n` +
    '   WebAssembly with SIMD by scripts/build-nam.mjs, from dsp/nam-engine.cpp.\n' +
    '   The factory is published on globalThis so nam-processor.js can see it.\n' +
    '   Generated: do not edit by hand. */\n';

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'nam.wasm'), wasm);
  fs.writeFileSync(path.join(OUT, 'nam-glue.js'), header + glue);
  fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(OUT, 'nam-wasm-LICENSE.txt'));
  fs.rmSync(tmp, { recursive: true, force: true });

  log(`  public/nam/nam.wasm             ${(wasm.length / 1024).toFixed(0)} kB`);
  log(`  public/nam/nam-glue.js          ${(glue.length / 1024).toFixed(0)} kB`);
  log('  public/nam/nam-wasm-LICENSE.txt (MIT)');
}

log('\nNAM engine — WebAssembly build');
fetchCore();
build();
log('\nDone. `npm run bench:nam` measures it; `npm run calibrate` is not needed:\n' +
    'the trims are properties of the captures, not of the build.\n');
