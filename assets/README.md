# `assets/` — source audio and model assets

Committed here as **sources**. Build output derived from them is never committed
(AD-15).

| Asset | State |
| --- | --- |
| DI loop | **Recorded.** Served as `public/di/demo-di.wav`: 18 s of unprocessed electric guitar DI, mono, 16-bit, 44.1 kHz, peaking at -6.8 dBFS. Converted once from a 25.5 s stereo float take whose channels were bit-identical, trimming the digital silence at each end — 6.8 MB down to 1.6 MB. It is fetched only when someone asks for it, never on page load. |
| Tab reader soundfont | **Third-party, unmodified.** Served as `public/musescore-general/MuseScore_General.sf3`: MuseScore_General v0.2.0, MIT, 39 900 972 bytes, SHA-256 `5b85b6c2c61d10b2b91cddd41efcce7b25cd31c8271d511c73afafbef20b6fa3`, from `ftp.osuosl.org/pub/musescore/soundfont/MuseScore_General/`. Committed rather than fetched in CI so the deploy stays a pure function of the commit; the cost is 40 MB in history for good. It is fetched only when a tab is opened. Its piano and "Sticks" are stereo sample pairs, which alphaTab skips; the reader retypes them as mono in memory before loading (`engine/soundfont.ts`), so the file on disk stays exactly this one. |
| `cab.tcir` | **Orphaned.** It fed the C++ cabinet stage the NAM pivot retired; the cabinet is now synthesised at runtime from a response curve in `engine/ir.ts`, with no file to download. Kept only until the listen path decides whether it wants a measured IR back. |

The DI take's provenance is not written down anywhere yet, and NFR-16 wants it
to be. It was supplied for this project; confirm who recorded it and under what
terms before the site is public.

Amp model weights are no longer an asset here: the amplifier is a NAM capture,
and the captures live in `public/models/` with their own licence.
