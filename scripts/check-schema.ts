/**
 * The invariants that have no other home.
 *
 * `schema/validate.ts` holds the rules the schema must satisfy on its own. This
 * adds the ones that span files, and that used to be caught only by playing:
 *
 * - every live parameter is reachable in the interface and applied by the
 *   engine, so a fader cannot exist that drives nothing, and a parameter cannot
 *   exist that no fader reaches;
 * - every preset names parameters, a capture and a cabinet that exist.
 *
 * Each of these fails silently in the product. A preset naming a capture that
 * is not installed does not throw — it plays the wrong amplifier.
 *
 * Usage:  npm run check
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PARAMS, STAGES } from '../schema/params.ts';
import { validateSchema } from '../schema/validate.ts';
import { PRESETS, DEFAULT_PRESET } from '../app/presets.ts';
import { CABS } from '../engine/ir.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors: string[] = [];

validateSchema();

const declared = new Set(PARAMS.map((p) => p.id));
const bypass = new Set(STAGES.map((s) => s.bypassParam).filter((s): s is string => s !== null));

/** Controls are declared directly or in a Svelte each block. */
const rig = readFileSync(join(ROOT, 'app/Rig.svelte'), 'utf8');
const onFaders = [
  ...[...rig.matchAll(/<Knob\s+param=\{param\('([^']+)'\)\}/g)].map(m => m[1]!),
  ...[...rig.matchAll(/\{#each \[([^\]]+)\] as id\}<Knob/g)]
    .flatMap(m => [...m[1]!.matchAll(/'([^']+)'/g)].map(x => x[1]!)),
];

/** What the engine actually applies, read the same way. */
const engine = readFileSync(join(ROOT, 'engine/engine.ts'), 'utf8');
const applied = new Set([...engine.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!));

for (const id of onFaders) {
  if (!declared.has(id)) errors.push(`the rig shows a control for "${id}", which the schema does not declare`);
}
for (const id of applied) {
  if (!declared.has(id)) errors.push(`the engine applies "${id}", which the schema does not declare`);
}
for (const p of PARAMS) {
  if (p.deprecated === true || bypass.has(p.id) || p.unit === 'bool') continue;
  if (!onFaders.includes(p.id)) errors.push(`"${p.id}" is live in the schema but has no control in the rig`);
  if (!applied.has(p.id)) errors.push(`"${p.id}" is live in the schema but the engine never applies it`);
}

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'public/models/index.json'), 'utf8'),
) as { models: { file: string }[] };
const captures = new Set(catalog.models.map((m) => m.file));
const cabs = new Set(CABS.map((c) => c.id));

for (const preset of PRESETS) {
  for (const id of Object.keys(preset.values)) {
    if (!declared.has(id)) errors.push(`preset "${preset.name}" sets "${id}", which the schema does not declare`);
    const p = PARAMS.find((q) => q.id === id)!;
    const v = preset.values[id]!;
    if (v < p.min || v > p.max) {
      errors.push(`preset "${preset.name}" sets ${id} to ${v}, outside [${p.min}, ${p.max}]`);
    }
  }
  if (!captures.has(preset.capture)) {
    errors.push(`preset "${preset.name}" names capture "${preset.capture}", which is not installed`);
  }
  if (!cabs.has(preset.cab)) {
    errors.push(`preset "${preset.name}" names cabinet "${preset.cab}", which does not exist`);
  }
}

/**
 * The schema's defaults are the default preset. Both files say so in prose, and
 * prose does not fail a build: drifting apart means a fader's double-click
 * resets to a value the preset never had.
 */
const fallback = PRESETS.find((p) => p.name === DEFAULT_PRESET);
if (fallback === undefined) {
  errors.push(`DEFAULT_PRESET names "${DEFAULT_PRESET}", which is not in PRESETS`);
} else {
  for (const [id, v] of Object.entries(fallback.values)) {
    const p = PARAMS.find((q) => q.id === id);
    if (p !== undefined && p.default !== v) {
      errors.push(`${id} defaults to ${p.default}, but the "${DEFAULT_PRESET}" preset sets ${v}`);
    }
  }
}

/** Every capture names a cabinet that exists, and carries a measured trim. */
const full = JSON.parse(readFileSync(join(ROOT, 'public/models/index.json'), 'utf8')) as {
  models: { file: string; name: string; cab: string; trimDb?: number }[];
};
for (const m of full.models) {
  if (!cabs.has(m.cab)) errors.push(`capture "${m.file}" names cabinet "${m.cab}", which does not exist`);
  if (typeof m.trimDb !== 'number') {
    errors.push(`capture "${m.file}" has no measured trim — run \`npm run calibrate\``);
  }
}

if (errors.length > 0) {
  console.error(`\n${errors.length} invariant(s) broken:\n${errors.map((e) => `  - ${e}`).join('\n')}\n`);
  process.exit(1);
}
console.log(`check: ${PARAMS.length} parameters, ${STAGES.length} stages, ${PRESETS.length} presets, ` +
  `${full.models.length} captures, ${CABS.length} cabinets — consistent`);
