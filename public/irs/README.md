# Recorded cabinet IRs

`celestion-g12-vintage.wav` is the original `celestion.wav` used by the
TONE3000 player for its **Celestion G12 Vintage** option (mono, 48 kHz).

Source: https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/ui/public/irs/celestion.wav

`mesa-412-os.wav` is the original `mesa.wav` used by the TONE3000 player for
its **Mesa 412 OS** option (mono, 48 kHz).

Source: https://github.com/tone-3000/neural-amp-modeler-wasm/blob/main/ui/public/irs/mesa.wav

The upstream repository's MIT license is included in `TONE3000-LICENSE.txt`.
`npm run vendor` retrieves the IRs and license. Tonecraft decodes each WAV at the host's
sample rate and applies the same onset/tail trimming and 1 kHz normalization
as a user-loaded cabinet IR. The original WAV is kept unchanged.
