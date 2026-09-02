/**
 * Bundles engine/processor.ts into public/tonecraft-processor.js.
 *
 * An AudioWorklet module is loaded by URL and evaluated in its own global
 * scope, so it cannot go through Astro's page pipeline. esbuild emits one plain
 * ES module with no framework, no hydration runtime and no imports left to
 * resolve — which is also what keeps the audio path free of anything that could
 * allocate behind our back.
 */

import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const result = await build({
  entryPoints: [join(HERE, 'processor.ts')],
  outfile: join(ROOT, 'public', 'tonecraft-processor.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  // Nothing in the audio path may depend on anything we did not write.
  external: [],
  metafile: true,
  logLevel: 'warning',
});

const outputs = Object.values(result.metafile.outputs);
const bytes = outputs.reduce((n, o) => n + o.bytes, 0);
process.stdout.write(`engine: wrote public/tonecraft-processor.js (${bytes} bytes)\n`);
