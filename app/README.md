# `app/` — the Svelte island

**Depends on `engine/` and `schema/`. Never imports `dsp/`.**

A single Svelte 5 island on a single route, `client:only` (FR-21). Owns chain
state as the single source of truth; the worklet owns nothing, and
`localStorage`, the URL hash and the tone file are projections of this store
(AD-11).

Owns fader taper curves, which never reach the wire format (AD-9).

Arrives in story 1.3 as a bare harness; designed in epic 2.
