/* =============================================================================
   scripts/vendor-nam.mjs — fetches and prepares the external dependencies
   -----------------------------------------------------------------------------
   The application runs entirely offline, with no CDN and nothing fetched at
   runtime that is not ours. This script downloads the amp captures from
   pelennor2170/NAM_models (GNU GPL v3) with their licence and attribution,
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

/* ------------------------------ the captures ----------------------------- */
async function vendorModels() {
  log('\nNAM captures (' + MODEL_REPO + ', GNU GPL v3)');
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

await vendorModels();
log('\nDone. Run `npm run calibrate` next: the captures carry no loudness\n' +
    'metadata, and without a measured trim they are 8.8 dB apart.\n');
