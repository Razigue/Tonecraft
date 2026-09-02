/**
 * Emits `dsp/params.generated.h` from `schema/params.ts` (AD-7).
 *
 *   npm run schema:generate   write the header
 *   npm run schema:check      fail if the header on disk is stale or hand-edited
 *
 * The header is build output and is never committed (AD-15). `--check` compares
 * the file on disk against what this generator produces right now, so it catches
 * both a stale header and one somebody edited by hand.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PARAMS,
  STAGES,
  INTERNAL_SAMPLE_RATE,
  BLOCK_FRAMES,
  OVERSAMPLE_FACTOR,
  OVERSAMPLED_BLOCK_FRAMES,
  OVERSAMPLED_SAMPLE_RATE,
  LSTM_HIDDEN_SIZE,
  MAX_IR_TAPS,
  type Param,
  type Stage,
} from './params.ts';
import { validateSchema } from './validate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(HERE, '..', 'dsp', 'params.generated.h');

/** `drive_gain` -> `PARAM_DRIVE_GAIN` */
const paramEnum = (p: Param): string => `PARAM_${p.id.toUpperCase()}`;
/** `drive` -> `STAGE_DRIVE` */
const stageEnum = (s: Stage): string => `STAGE_${s.id.toUpperCase()}`;

/** C++ needs a float literal that round-trips exactly. */
const f = (n: number): string => {
  const s = Object.is(n, Math.trunc(n)) ? `${n}.0` : `${n}`;
  return `${s}f`;
};

function render(): string {
  const lines: string[] = [];
  const w = (s = ''): void => void lines.push(s);

  w('// GENERATED FILE — DO NOT EDIT.');
  w('//');
  w('// Produced by schema/generate.ts from schema/params.ts, which is the single');
  w('// source of truth for every parameter (AD-7). Edits here are discarded on the');
  w('// next build, and `npm run schema:check` fails if this file has been touched.');
  w('//');
  w('// To change a parameter, edit schema/params.ts and run:');
  w('//');
  w('//     npm run schema:generate');
  w('');
  w('#pragma once');
  w('');
  w('#include <cstdint>');
  w('');
  w('namespace tonecraft {');
  w('');

  w('// --- Chain constants ------------------------------------------------------');
  w('');
  w('// AD-18: the one internal design rate. Stages are designed for this and never');
  w('// read the device rate; engine/ converts at the chain boundary.');
  w(`constexpr uint32_t kInternalSampleRate = ${INTERNAL_SAMPLE_RATE};`);
  w('');
  w('// AD-19: frames per process() call. Fixed by the AudioWorklet render quantum');
  w('// outside the oversampling window, and by the oversampling factor inside it.');
  w(`constexpr uint32_t kBlockFrames = ${BLOCK_FRAMES};`);
  w(`constexpr uint32_t kOversampleFactor = ${OVERSAMPLE_FACTOR};`);
  w(`constexpr uint32_t kOversampledBlockFrames = ${OVERSAMPLED_BLOCK_FRAMES};`);
  w('');
  w('// The rate a stage INSIDE the window runs at. A filter designed for the');
  w('// internal rate and run here has its corner four times too high.');
  w(`constexpr uint32_t kOversampledSampleRate = ${OVERSAMPLED_SAMPLE_RATE};`);
  w('');
  w('// AD-5: fixed at build time for the floor machine. Never selected at runtime');
  w('// from measured headroom — an adaptive engine would make a tone link lie.');
  w(`constexpr uint32_t kLstmHiddenSize = ${LSTM_HIDDEN_SIZE};`);
  w('');
  w('// AD-3: the cab is a direct-form SIMD FIR, not a ConvolverNode. A longer IR');
  w('// reopens that decision rather than silently switching algorithm.');
  w(`constexpr uint32_t kMaxIrTaps = ${MAX_IR_TAPS};`);
  w('');

  w('// --- Stages ---------------------------------------------------------------');
  w('//');
  w('// AD-21: meter slots are stable declared ids, never a stage\'s index in the');
  w('// chain. Inserting a stage must not shift what any other slot means.');
  w('');
  w('enum StageIndex : uint32_t {');
  for (const s of STAGES) w(`  ${stageEnum(s)},`);
  w('  kStageCount,');
  w('};');
  w('');
  w('enum MeterSlot : uint32_t {');
  for (const s of STAGES) w(`  METER_${s.id.toUpperCase()} = ${s.meterSlot},`);
  w(`  kMeterSlotCount = ${STAGES.length},`);
  w('};');
  w('');
  w('struct StageInfo {');
  w('  const char* id;');
  w('  uint32_t meter_slot;');
  w('  int32_t bypass_param;  // -1 where bypass is forbidden');
  w('  bool oversampled;');
  w('};');
  w('');
  w('constexpr StageInfo kStages[kStageCount] = {');
  for (const s of STAGES) {
    const bypass = s.bypassParam === null
      ? '-1'
      : String(PARAMS.findIndex((p) => p.id === s.bypassParam));
    w(`  { "${s.id}", ${s.meterSlot}, ${bypass}, ${s.oversampled} },`);
  }
  w('};');
  w('');

  w('// --- Parameters -----------------------------------------------------------');
  w('//');
  w('// AD-8: this order is the wire order and is append-only. A parameter is never');
  w('// removed, renamed or reordered, so a tone link made today still decodes');
  w('// correctly years from now.');
  w('//');
  w('// AD-9: values are engineering units. Taper curves belong to the UI and are');
  w('// deliberately absent here — dsp/ never sees a fader position.');
  w('');
  w('enum ParamIndex : uint32_t {');
  for (const p of PARAMS) w(`  ${paramEnum(p)},`);
  w('  kParamCount,');
  w('};');
  w('');
  w('struct ParamInfo {');
  w('  const char* id;');
  w('  const char* unit;');
  w('  float min_value;');
  w('  float max_value;');
  w('  float default_value;');
  w('  uint32_t stage;');
  w('  bool deprecated;  // still decoded, ignored by the engine (AD-8)');
  w('};');
  w('');
  w('constexpr ParamInfo kParams[kParamCount] = {');
  const widest = Math.max(...PARAMS.map((p) => p.id.length));
  for (const p of PARAMS) {
    const stage = STAGES.find((s) => s.id === p.stage);
    if (stage === undefined) throw new Error(`unreachable: ${p.id} has no stage`);
    const pad = ' '.repeat(widest - p.id.length);
    w(
      `  { "${p.id}",${pad} "${p.unit}", ${f(p.min)}, ${f(p.max)}, ` +
      `${f(p.default)}, ${stageEnum(stage)}, ${p.deprecated === true} },`,
    );
  }
  w('};');
  w('');
  w('}  // namespace tonecraft');

  return lines.join('\n') + '\n';
}

function main(): void {
  validateSchema();
  const generated = render();
  const check = process.argv.includes('--check');

  if (!check) {
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, generated, 'utf8');
    process.stdout.write(
      `schema: wrote dsp/params.generated.h — ${PARAMS.length} parameters, ${STAGES.length} stages\n`,
    );
    return;
  }

  if (!existsSync(OUTPUT)) {
    process.stderr.write(
      'schema: dsp/params.generated.h is missing.\n' +
      'It is build output and is never committed (AD-15). Run:\n\n' +
      '    npm run schema:generate\n\n',
    );
    process.exit(1);
  }

  if (readFileSync(OUTPUT, 'utf8') !== generated) {
    process.stderr.write(
      'schema: dsp/params.generated.h does not match schema/params.ts.\n' +
      'It was either edited by hand or left stale. It is generated code and the\n' +
      'schema is the single source of truth (AD-7) — change schema/params.ts,\n' +
      'never this header, then run:\n\n' +
      '    npm run schema:generate\n\n',
    );
    process.exit(1);
  }

  process.stdout.write('schema: dsp/params.generated.h is in sync\n');
}

main();
