# `render/` — measurement, and the build-time renderer

**Depends on `engine/`.**

The measurement half, kept from the period when the amplifier was ours and had
to be tuned by numbers: `wav.ts` reads and writes files, `measure.ts` produces a
tone curve and an attack list, `compare.ts` prints the difference between two
renders band by band, normalised at 1 kHz so the table is about tone rather than
level.

**The offline renderer is not here yet.** The one that existed drove the C++
chain that the NAM pivot retired; the listen path needs a new one, built on the
NAM engine the way `scripts/calibrate-models.ts` already runs it from Node.

When it is written, one rule carries over unchanged: offline rendering has no
CPU budget, so a bigger model and heavier oversampling would be free. That
headroom stays deliberately unused (AD-6). Using it would make the demo sound
better than what a player gets after plugging in, and would make a shared tone
mean two different things.
