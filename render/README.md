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
