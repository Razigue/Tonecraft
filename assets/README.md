# `assets/` — source audio and model assets

Committed here as **sources**. Build output derived from them is never committed
(AD-15).

| Asset | State |
| --- | --- |
| DI loop | Not recorded. ~20 s of unprocessed **electric** guitar DI — a lead line, pickups straight in, no amp and no effects — captured through a guitar-to-USB cable at 48 kHz. Needed by the build-time renders for the listen path. |
| `cab.tcir` | **Orphaned.** It fed the C++ cabinet stage the NAM pivot retired; the cabinet is now synthesised at runtime from a response curve in `engine/ir.ts`, with no file to download. Kept only until the listen path decides whether it wants a measured IR back. |

Amp model weights are no longer an asset here: the amplifier is a NAM capture,
and the captures live in `public/models/` with their own licence.
