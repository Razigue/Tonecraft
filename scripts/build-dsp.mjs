/* =============================================================================
   scripts/build-dsp.mjs — compiles the whole chain into one WebAssembly module
   -----------------------------------------------------------------------------
   Produces public/dsp/chain.wasm from dsp/*.cpp and NeuralAmpModelerCore (MIT,
   Steven Atkinson). The browser's AudioWorklet and the native Tonecraft Engine
   (service/) both run this exact file, so it is built once, here, for both.

   Standalone: no JavaScript glue. A host instantiates it with a handful of
   imports (see public/dsp/chain-core.js and service/src/chain.rs), which is
   what lets wasmtime run it at all — Emscripten's glue only exists in a
   browser. Exceptions use the standard exnref encoding
   (-sWASM_LEGACY_EXCEPTIONS=0), the only one wasmtime implements; every
   browser the play path supports has it.

   Flags, and what each was measured to be worth on the NAM capture alone, on a
   128-frame block (median, the shipped scalar build of old took 352 us):
     -O3 -msimd128 -flto                 254 us   LLVM's own vectorisation
     + -msse4.1                          226 us   Eigen's packet math runs on
                                                  emulated SSE, the only way
                                                  Eigen vectorises under wasm
     - NAM_USE_INLINE_GEMM               120 us   NAM core's hand-inlined GEMM
                                                  is slower than Eigen's here
   EIGEN_STACK_ALLOCATION_LIMIT=0 keeps Eigen's temporaries off the (small)
   WebAssembly stack. Native exceptions cost nothing on the path that does not
   throw, and turn a malformed capture into a refused load, not a dead chain.
   Never -mrelaxed-simd and never fast-math (AD-4): both would let two engines
   running this same file disagree.

   Prerequisites: an Emscripten SDK. Either `EMSDK` points at one, or
   .toolchain/emsdk exists (gitignored), or em++ is on PATH. Git and network
   access are needed once, to fetch the pinned NAM core into .nam-src/.

   Usage:  npm run build:dsp
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '.nam-src');
const OUT = path.join(ROOT, 'public', 'dsp');

const CORE_REPO = 'https://github.com/sdatkinson/NeuralAmpModelerCore.git';
// Pinned: the engine identity a tone link relies on (AD-10). Bumping it is a
// deliberate change, re-measured with `npm run bench`.
const CORE_TAG = 'v0.5.3';

const log = (...a) => console.log(...a);

function findCompiler() {
  const exe = process.platform === 'win32' ? 'em++.exe' : 'em++';
  const candidates = [];
  if (process.env.EMSDK) candidates.push(path.join(process.env.EMSDK, 'upstream', 'emscripten', exe));
  candidates.push(path.join(ROOT, '.toolchain', 'emsdk', 'upstream', exe));
  candidates.push(path.join(ROOT, '.toolchain', 'emsdk', 'upstream', 'emscripten', exe));
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const sdk = path.resolve(path.dirname(c), path.basename(path.dirname(c)) === 'emscripten' ? '../..' : '..');
      return { bin: c, env: { ...process.env, EM_CONFIG: path.join(sdk, '.emscripten') } };
    }
  }
  return { bin: 'em++', env: process.env };
}

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
    ...glob(path.join(ROOT, 'dsp')),
  ];
}

function build() {
  const { bin, env } = findCompiler();
  const wasm = path.join(OUT, 'chain.wasm');
  fs.mkdirSync(OUT, { recursive: true });
  const args = [
    '-std=c++20', '-O3', '-msimd128', '-msse4.1', '-flto',
    '-fwasm-exceptions', '-sWASM_LEGACY_EXCEPTIONS=0', '-fno-rtti',
    // Web Audio is float32; double would halve the SIMD width for nothing.
    '-DNAM_SAMPLE_FLOAT',
    '-DEIGEN_STACK_ALLOCATION_LIMIT=0',
    '-DNAM_ENABLE_A2_FAST',
    '-I', SRC,
    '-I', path.join(SRC, 'Dependencies', 'eigen'),
    '-I', path.join(SRC, 'Dependencies', 'nlohmann'),
    '-I', path.join(ROOT, 'dsp'),
    ...sources(),
    // A reactor: no main, the host calls _initialize and then the exports.
    '--no-entry', '-sSTANDALONE_WASM=1',
    // No SharedArrayBuffer, no threads (AD-17): a plain heap that grows.
    '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=32MB',
    // JSON parsing is the deepest stack user; it lives in linear memory.
    '-sSTACK_SIZE=4MB',
    '-sFILESYSTEM=0',
    '-o', wasm,
  ];
  log(`  ${path.basename(bin)} ... (about a minute)`);
  execFileSync(bin, args, { env, stdio: 'inherit' });
  fs.copyFileSync(path.join(SRC, 'LICENSE'), path.join(OUT, 'nam-core-LICENSE.txt'));

  const bytes = fs.readFileSync(wasm);
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
  log(`  public/dsp/chain.wasm   ${(bytes.length / 1024).toFixed(0)} kB`);
  log(`  imports: ${imports.join(', ') || '(none)'}`);
}

log('\nThe chain — WebAssembly build');
execFileSync(process.execPath, ['--import', 'tsx', path.join(ROOT, 'schema', 'generate.ts')], { stdio: 'inherit' });
fetchCore();
build();
log('\nDone. `npm run bench` times it; `npm run test:chain` checks the ABI.\n');
