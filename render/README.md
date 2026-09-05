# `render/` — the build-time renderer

**Depends on `engine/`.**

Drives the fixed DI loop through the chain from Node and emits the preset audio
file and its per-stage RMS envelope.

It loads the **identical** `.wasm` artifact the browser loads — not a native
build, not a second implementation — and there is no separate offline quality
setting (AD-6). Offline rendering has no CPU budget, so a bigger model and
heavier oversampling would be free here. That headroom is deliberately unused:
using it would make the demo sound better than what a player gets after
plugging in.

Arrives in epic 4.

## What is here already

The measurement half, built ahead of the preset renderer because tuning the amp
by ear alone was not converging. Same rule applies: it loads the identical
`.wasm` the browser loads.

| File | Owns |
| --- | --- |
| `wav.ts` | Reading and writing WAV. No dependency; 32-bit float in and out. |
| `offline.ts` | Pushes a file through the chain. `tsx render/offline.ts in.wav out.wav [--set id=value]...` |
| `measure.ts` | FFT, fractional-octave band energy, attack spread, active range. |
| `compare.ts` | Prints the band-by-band difference between two renders. |

Parameters are named by schema id in engineering units (AD-9), so a command
line reads the same as the wire format and does not depend on fader travel.

This is how a complaint like "it sounds thin" becomes a corner frequency: put
the same DI through our chain and through the reference, and read the
difference in decibels per third of an octave.
