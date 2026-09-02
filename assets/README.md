# `assets/` — source audio and model assets

Committed here as **sources**. Build output derived from them is never committed
(AD-15).

Three assets the product needs, none of which exists yet:

| Asset | State |
| --- | --- |
| DI loop | Not recorded. ~20 s of unprocessed **electric** guitar DI — a lead line, pickups straight in, no amp and no effects — captured through a guitar-to-USB cable at 48 kHz. Used by both the build renders and the `OfflineAudioContext` fallback, so there is exactly one file. |
| Cab impulse response | Not captured. Ours or licensed with redistribution rights, provenance documented (NFR-16). At most 2048 taps (AD-3). |
| Amp model weights | **Not trained, and not yet scoped.** `[u32 magic][u32 version][u32 count][f32 ...]`, LSTM hidden 20 (AD-14). Training requires a real amplifier, a capture rig and paired recordings — a project the epics do not currently cover. |

Every weights version ever shipped stays served at a stable URL indefinitely,
because a tone link pins the weights version it was created with (AD-10).
