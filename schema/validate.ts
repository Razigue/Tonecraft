/**
 * Invariants the schema itself must hold. Run by the generator before it emits
 * anything, so a schema that breaks a rule fails the build rather than
 * producing a header that quietly encodes the mistake.
 */

import {
  PARAMS,
  STAGES,
  type Param,
  type Stage,
  type StageId,
} from './params.ts';

export function validateSchema(
  params: readonly Param[] = PARAMS,
  stages: readonly Stage[] = STAGES,
): void {
  const errors: string[] = [];

  // AD-9: engineering units only. A normalised 0..1 fader position in the wire
  // format would mean that retuning a taper silently changes every tone anyone
  // has ever shared. `ratio` is allowed because a mix control's unit genuinely
  // is a ratio — it is a physical quantity, not a fader position.
  for (const p of params) {
    if (p.unit === 'ratio' && !/_mix$/.test(p.id)) {
      errors.push(
        `${p.id}: unit "ratio" is reserved for mix controls, where the ratio is ` +
        `the physical quantity. Any other 0..1 value is a normalised fader ` +
        `position, which AD-9 keeps out of the wire format.`,
      );
    }
    if (p.min >= p.max) {
      errors.push(`${p.id}: min (${p.min}) must be below max (${p.max}).`);
    }
    if (p.default < p.min || p.default > p.max) {
      errors.push(`${p.id}: default ${p.default} is outside [${p.min}, ${p.max}].`);
    }
    if (p.unit === 'bool' && (p.min !== 0 || p.max !== 1)) {
      errors.push(`${p.id}: a bool parameter must range 0..1.`);
    }
  }

  // AD-8: ids are unique and stable. Reusing one would make an old tone link
  // decode into a different parameter.
  const seen = new Set<string>();
  for (const p of params) {
    if (seen.has(p.id)) errors.push(`${p.id}: duplicate parameter id.`);
    seen.add(p.id);
  }

  // Every parameter belongs to a declared stage.
  const stageIds = new Set<StageId>(stages.map((s) => s.id));
  for (const p of params) {
    if (!stageIds.has(p.stage)) {
      errors.push(`${p.id}: unknown stage "${p.stage}".`);
    }
  }

  // AD-21: meter slots are stable ids, unique, and never derived from position.
  const slots = new Set<number>();
  for (const s of stages) {
    if (slots.has(s.meterSlot)) {
      errors.push(`${s.id}: meter slot ${s.meterSlot} is already taken.`);
    }
    slots.add(s.meterSlot);
  }

  // AD-21: a declared bypass parameter must exist, and must be a bool.
  const byId = new Map<string, Param>(params.map((p) => [p.id, p]));
  for (const s of stages) {
    if (s.bypassParam === null) continue;
    const p = byId.get(s.bypassParam);
    if (p === undefined) {
      errors.push(`${s.id}: bypass parameter "${s.bypassParam}" is not declared.`);
    } else if (p.unit !== 'bool') {
      errors.push(`${s.id}: bypass parameter "${s.bypassParam}" must be a bool.`);
    }
  }

  // AD-2: the oversampling window is one contiguous run. Splitting it would
  // mean a second polyphase resampling chain — the cost that made promoting
  // the drive to Must affordable in the first place.
  const runs = stages.reduce<number>(
    (n, s, i) => (s.oversampled && !(stages[i - 1]?.oversampled ?? false) ? n + 1 : n),
    0,
  );
  if (runs > 1) {
    errors.push(
      `The 4x oversampling window is split across ${runs} runs of the chain. ` +
      `AD-2 requires exactly one contiguous window: a second run means a second ` +
      `upsampler and downsampler, and the CPU budget has no room for it.`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `schema/params.ts violates ${errors.length} invariant(s):\n` +
      errors.map((e) => `  - ${e}`).join('\n'),
    );
  }
}
