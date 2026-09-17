/* =============================================================================
   scripts/vendor-nam.mjs — fetches and prepares the external dependencies
   -----------------------------------------------------------------------------
   The application runs entirely offline, with no CDN and nothing fetched at
   runtime that is not ours. This script downloads the amp captures from
   pelennor2170/NAM_models (GNU GPL v3), VIC AUDIO and TONE3000 (T3K),
   into `public/models/`, which is what the site ships.

   The engine is not vendored any more: scripts/build-nam.mjs compiles it from
   pinned NeuralAmpModelerCore sources with SIMD, because the prebuilt
   @opendaw/nam-wasm package was scalar and 2.9x slower on the audio thread.

   Usage:  npm run vendor
   ========================================================================== */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'public', 'models');

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
   The Helga captures contain the amplifier alone. Nightmare and Super Reverb
   are full rigs; their extra IRs reproduce the requested player setups.
--------------------------------------------------------------------------- */
const PACKS = [
  { id: 'metal', name: 'Metal', order: 1 },
  { id: 'clean', name: 'Clean', order: 2 },
  // Packs to come: crunch, bass.
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
  {
    src: 'VA Nightmare (MD and Mesa Oversized).nam',
    url: 'https://api.tone3000.com/storage/v1/object/public/models/2kp9uu8orkv_a2.nam',
    sourcePage: 'https://www.tone3000.com/tones/driftwood-purple-nightmare-full-rig-61258',
    license: 'T3K', author: 'VIC AUDIO',
    name: 'VA Nightmare (MD and Mesa Oversized)', pack: 'metal', cab: 'celestion-g12-vintage',
    note: 'Driftwood Purple Nightmare full rig: Merciless Drive, Mesa Oversized, SM57 + M160.',
  },
  {
    src: 'Fender Super Reverb EQ Flat Volume 3 sm57 and AKG 414.nam',
    url: 'https://api.tone3000.com/storage/v1/object/public/models/f5on0jl7xbp_a2.nam',
    sourcePage: 'https://www.tone3000.com/tones/fender-super-reverb-1977-19',
    license: 'T3K', author: 'TONE3000',
    name: 'Fender Super Reverb: EQ Flat, Volume 3, sm57 and AKG 414',
    pack: 'clean', cab: 'mesa-412-os',
    note: '1977 Fender Super Reverb, flat EQ, volume 3; SM57 and AKG C414 blend.',
  },
];

const log = (...a) => console.log(...a);
const ensure = (d) => fs.mkdirSync(d, { recursive: true });

/* ------------------------------ the captures ----------------------------- */
async function vendorModels() {
  log('\nNAM captures (Helga: GNU GPL v3; VIC AUDIO and TONE3000: T3K — see attribution files)');
  ensure(MODELS);
  const raw = 'https://raw.githubusercontent.com/' + MODEL_REPO + '/main/';
  const index = [];

  for (const entry of MODEL_CATALOG) {
    const r = await fetch(entry.url ?? raw + encodeURIComponent(entry.src));
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + entry.src);
    const text = await r.text();
    const json = JSON.parse(text);                       // validates the file
    const slug = entry.src.replace(/\.nam$/, '').replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-|-$/g, '').toLowerCase() + '.nam';
    fs.writeFileSync(path.join(MODELS, slug), text);
    index.push({
      file: slug, source: entry.src, name: entry.name, pack: entry.pack,
      cab: entry.cab, note: entry.note,
      arch: json.architecture, weights: weightCount(json),
      ...(entry.url ? { url: entry.url, sourcePage: entry.sourcePage, license: entry.license, author: entry.author } : {}),
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

function weightCount(model) {
  return (model.weights?.length ?? 0) +
    (model.config?.submodels ?? []).reduce((n, sub) => n + weightCount(sub.model), 0);
}

async function vendorIR() {
  const raw = 'https://raw.githubusercontent.com/tone-3000/neural-amp-modeler-wasm/refs/heads/main/';
  const dir = path.join(ROOT, 'public', 'irs');
  ensure(dir);
  for (const [source, file] of [
    ['ui/public/irs/celestion.wav', 'celestion-g12-vintage.wav'],
    ['ui/public/irs/mesa.wav', 'mesa-412-os.wav'],
    ['LICENSE', 'TONE3000-LICENSE.txt'],
  ]) {
    const r = await fetch(raw + source);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + source);
    fs.writeFileSync(path.join(dir, file), new Uint8Array(await r.arrayBuffer()));
  }
}

await vendorModels();
await vendorIR();
log('\nDone. Run `npm run calibrate` next to align each capture through its cabinet.\n');
