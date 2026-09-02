# `schema/` — the single source of truth for every parameter

**Depends on nothing.** Everything else depends on this.

`params.ts` declares each parameter with its id, unit, range, default and taper.
`generate.ts` emits `dsp/params.generated.h` from it. A hand-edited generated
header fails the build; regenerating in CI must produce no diff (AD-7).

Values are engineering units — dB, Hz, ratio, milliseconds — never normalised
fader positions (AD-9). The schema is append-only forever: parameters are added,
never removed, renamed, reordered in the wire format, or changed in meaning
(AD-8). Each stage also declares a stable meter slot id and bypass parameter id
here; nothing addresses a stage by its index in the chain (AD-21).

Arrives in story 1.2.
