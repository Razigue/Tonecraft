/* =============================================================================
   scripts/vendor-nam.mjs — fetches and prepares the external dependencies
   -----------------------------------------------------------------------------
   The application runs entirely offline, with no CDN and nothing fetched at
   runtime that is not ours. This script is the only moment the network is used.
   It:

     1. downloads @opendaw/nam-wasm from npm (MIT, a build of Steven Atkinson's
        NeuralAmpModelerCore);
     2. adapts the Emscripten glue to the AudioWorklet context: `import.meta`
        and `export` are removed, and the factory is published on globalThis so
        it stays visible from nam-processor.js;
     3. downloads the amp captures from pelennor2170/NAM_models (GNU GPL v3)
        with their licence and attribution.

   Everything lands in `public/`, which is what the site ships.

   Usage:  npm run vendor
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAM = path.join(ROOT, 'public', 'nam');
const MODELS = path.join(ROOT, 'public', 'models');
const TMP = path.join(ROOT, '.vendor-tmp');

const NAM_PKG = '@opendaw/nam-wasm@1.2.0';
const MODEL_REPO = 'pelennor2170/NAM_models';

/* ---------------------------------------------------------------------------
   The catalogue of embedded captures.

   Adding a family of sounds later (clean, crunch, bass) is adding entries here
   and in app/presets.ts, then re-running:
       npm run vendor && npm run calibrate
   The rest of the application reads public/models/index.json and adapts on its
   own: the interface groups captures by `pack` and every level is aligned.

   `pack` : the family shown in the interface.
   `cab`  : the cabinet offered by default with this capture.
   Every one of these is a capture of the amplifier WITHOUT a cabinet; the
   cabinet is convolved downstream (see engine/ir.ts).
--------------------------------------------------------------------------- */
const PACKS = [
  { id: 'metal', name: 'Metal', order: 1 },
  // Packs to come: clean, crunch, bass.
];

const MODEL_CATALOG = [
  {
    src: 'Helga B 5150 BlockLetter - Boosted.nam',
    name: '5150 Block Letter — boosted', pack: 'metal', cab: 'v30mod',
    note: 'The modern metal standard. Sharp attack, tight bottom.',
  },
  {
    src: 'Helga B 5150 BlockLetter - NoBoost.nam',
    name: '5150 Block Letter — raw', pack: 'metal', cab: 'v30mod',
    note: 'The same amp with nothing in front: more open, and it answers the boost.',
  },
  {
    src: 'Helga B 6505+ Red ch - MXR Drive.nam',
    name: '6505+ red channel — MXR', pack: 'metal', cab: 'v30mod',
    note: 'More midrange, and very legible in a busy mix.',
  },
  {
    src: 'Helga B JSX Ultra - OD808.nam',
    name: 'JSX Ultra — OD808', pack: 'metal', cab: 'v30mod',
    note: 'High, singing gain. Made for solos.',
  },
];

const log = (...a) => console.log(...a);
const ensure = (d) => fs.mkdirSync(d, { recursive: true });

/* ------------------------------ 1. the engine ---------------------------- */
function vendorEngine() {
  log('\n[1/2] NAM WebAssembly engine');
  ensure(TMP); ensure(NAM);
  log('  npm pack ' + NAM_PKG + ' ...');
  const out = execSync('npm pack ' + NAM_PKG, { cwd: TMP, encoding: 'utf8' });
  const tgz = out.trim().split('\n').pop().trim();
  execSync('tar xzf "' + tgz + '"', { cwd: TMP });
  const dist = path.join(TMP, 'package', 'dist');

  const wasm = fs.readFileSync(path.join(dist, 'nam.wasm'));
  fs.writeFileSync(path.join(NAM, 'nam.wasm'), wasm);
  log('  public/nam/nam.wasm             ' + (wasm.length / 1024).toFixed(0) + ' kB');

  let glue = fs.readFileSync(path.join(dist, 'nam.js'), 'utf8');
  const subs = [
    ['var _scriptDir = import.meta.url;', 'var _scriptDir = "";'],
    ['new URL("nam.wasm",import.meta.url).href', '"nam.wasm"'],
  ];
  for (const [from, to] of subs) {
    if (!glue.includes(from)) throw new Error('pattern not found in nam.js: ' + from);
    glue = glue.replace(from, to);
  }
  glue = glue.replace(/export default createNamModule;\s*$/, '');
  if (glue.includes('import.meta')) throw new Error('import.meta survives in the glue');
  if (/^\s*export\s/m.test(glue)) throw new Error('an export survives in the glue');

  /* The crucial point: AudioWorklet.addModule() evaluates its scripts as ES
     *modules*. A top-level `var` therefore stays inside the module scope and is
     NOT visible from the other scripts added to the same AudioWorklet. We
     publish the factory on globalThis explicitly, which works whether the
     script is treated as a module or as a classic script. Without this line,
     nam-processor.js cannot find the engine and simply passes the signal
     through — silently, which is the worst possible failure. */
  glue += '\n;globalThis.createNamModule = createNamModule;\n';

  const header = '/* @opendaw/nam-wasm ' + NAM_PKG.split('@').pop() + ' — MIT, (c) Steven Atkinson.\n' +
    '   A build of NeuralAmpModelerCore. Generated by scripts/vendor-nam.mjs:\n' +
    '   `import.meta` and `export` removed, the factory published on globalThis\n' +
    '   so nam-processor.js can see it. Do not edit by hand. */\n';
  fs.writeFileSync(path.join(NAM, 'nam-glue.js'), header + glue);
  log('  public/nam/nam-glue.js          ' + (glue.length / 1024).toFixed(0) + ' kB  (patched)');

  const lic = fs.readFileSync(path.join(TMP, 'package', 'LICENSE'), 'utf8');
  fs.writeFileSync(path.join(NAM, 'nam-wasm-LICENSE.txt'), lic);
  log('  public/nam/nam-wasm-LICENSE.txt (MIT)');

  fs.rmSync(TMP, { recursive: true, force: true });
}

/* ----------------------------- 2. the captures --------------------------- */
async function vendorModels() {
  log('\n[2/2] NAM captures (' + MODEL_REPO + ', GNU GPL v3)');
  ensure(MODELS);
  const raw = 'https://raw.githubusercontent.com/' + MODEL_REPO + '/main/';
  const index = [];

  for (const entry of MODEL_CATALOG) {
    const r = await fetch(raw + encodeURIComponent(entry.src));
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + entry.src);
    const text = await r.text();
    const json = JSON.parse(text);                       // validates the file
    const slug = entry.src.replace(/\.nam$/, '').replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '').toLowerCase() + '.nam';
    fs.writeFileSync(path.join(MODELS, slug), text);
    index.push({
      file: slug, source: entry.src, name: entry.name, pack: entry.pack,
      cab: entry.cab, note: entry.note,
      arch: json.architecture, weights: json.weights.length,
    });
    log('  ' + slug.padEnd(46) + (text.length / 1024).toFixed(0) + ' kB');
  }

  for (const f of ['COPYING', 'README.md']) {
    const r = await fetch(raw + f);
    if (r.ok) fs.writeFileSync(path.join(MODELS, f === 'README.md' ? 'UPSTREAM-README.md' : f), await r.text());
  }
  fs.writeFileSync(path.join(MODELS, 'index.json'),
    JSON.stringify({ packs: PACKS, models: index }, null, 2));
  log('  COPYING (GPL v3) + UPSTREAM-README.md + index.json');
}

vendorEngine();
await vendorModels();
log('\nDone. Run `npm run calibrate` next: the captures carry no loudness\n' +
    'metadata, and without a measured trim they are 8.8 dB apart.\n');
