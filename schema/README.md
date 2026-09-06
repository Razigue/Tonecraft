# `schema/` — the single source of truth for every parameter

**Depends on nothing.** Everything else depends on this.

`params.ts` declares each parameter with its id, stage, unit, range, default and
taper, and each stage with its label, meter slot and bypass parameter.

Values are engineering units — dB, Hz, ratio, milliseconds — never normalised
fader positions (AD-9). Tapers are a presentation concern owned by `app/` and
never reach the wire format, so retuning a taper cannot change how an existing
shared tone sounds.

The schema is append-only forever: parameters are added, never removed, renamed,
reordered in the wire format, or changed in meaning (AD-8). A parameter that no
longer drives anything is marked `deprecated` and ignored by the engine, which
is what the whole `amp_*` block is now — those controls drove the Faust cascade
the NAM pivot retired, and reusing their ids would make an old tone link decode
into something else.

Nothing addresses a stage by its index in the chain (AD-21).

`validate.ts` holds the rules the schema must satisfy on its own.
`scripts/check-schema.ts` runs those and then the ones that span files: that
`engine/` applies every live parameter, that `app/` shows one, and that every
preset names a capture and a cabinet that exist. All of those fail silently in
the product — a preset naming a missing capture does not throw, it plays the
wrong amplifier.
