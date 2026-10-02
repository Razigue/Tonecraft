# TONE3000 effects in Tonecraft

Source: https://github.com/tone-3000/tone3000-plugin
Pinned commit: `ef6f178ae1ac6412b55fec6f058d86e640e5aaaf`.

Adapted files:

- `plugin/include/NoiseGate.h` → `NoiseGate.h`.
- `plugin/include/PitchShift.h` → `PitchShift.h`.
- `plugin/src/PitchShift.cpp` → `../tone3000-pitch.cpp`.

These files are MIT licensed, copyright (c) 2026 TONE3000. The complete
license is in `LICENSE.txt` and ships as `/dsp/tone3000-LICENSE.txt` alongside
the compiled WebAssembly. `scripts/build-dsp.mjs` copies it on each build.
Use, modification and commercial redistribution are permitted provided the
copyright and permission notice accompany copies or substantial portions.

## Adaptation

Only the effect algorithms are incorporated. No JUCE source, plugin UI,
branding assets, API client, model captures or third-party DSP dependencies
are imported. JUCE buffer access, constants and scalar math helpers are
replaced by standard C++20 and a mono pointer interface. `LinearRamp.h` is
Tonecraft's own linear ramp replacing the JUCE smoothing utility.

The gate retains upstream's band-limited detector, 5 dB hysteresis, 0.2 ms
attack, 25 ms detector fall, 20 ms hold, 50 ms release and 80 dB range. It
processes the selected mono input after trim/DC blocking. Threshold and
bypass retain the existing Tonecraft controls. The meter now reports the
actual applied gain. The release intentionally differs from the former
hard-closing gate; this gate is a downward expander and does not force zero.

The pitch algorithm retains upstream's correlation search, Hermite reads,
onset re-sync, adaptive crossfades and 30 ms default window. The optional
JUCE tonality crossover is omitted (upstream defaults to tonality off).
Tonecraft exposes its existing ±12 semitones and dry/wet control through
`../pitch.h` and `../pitch.cpp`. Pitch shifting and transposition are the
same processing stage. Upstream's 25 ms power blend is retained; the host's
mix control is smoothed separately. Zero shift and bypass fade back to a
zero-delay dry wire. Active nominal latency is 16 ms at 48 kHz, as reported
by upstream (the mean delay; actual onset/tap delay varies).

Both the browser and native service consume the rebuilt `chain.wasm`.
No parameter IDs, preset format or ABI layout changed; existing presets
using these effects intentionally acquire the new processing behavior.

## Validation

`npm run build:dsp` rebuilds the shared module. `npm run test:chain` checks
the integrated gate, pitch accuracy, steady-note level, latency, bypass,
and host block-size independence. Audio quality on a real guitar still
requires listening; the tests do not establish a subjective improvement.

Measured locally on 2026-10-02: the ENGL default chain with the transposer
one octave down used 656 µs median / 1319 µs p99 per 128-frame block at
48 kHz (2667 µs available). The default chain with pitch bypassed used
612 µs median / 1131 µs p99. These are measurements of this machine, not a
cross-device guarantee. `npm run build` and `npm run test:chain` passed.
Native-host parity was not run: the native release executable is absent.
