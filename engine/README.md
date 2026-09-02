# `engine/` — composition, WASM lifetime, parameter bridge, meter reader

**Depends on `schema/` and `dsp/` output.**

Owns the single `AudioWorkletProcessor` that holds the entire chain (AD-1), the
WASM module's lifetime inside the `AudioWorkletGlobalScope`, the conversion
between the device sample rate and the fixed internal 48 kHz (AD-18), and the
metering channel.

Continuous parameters cross as `AudioParam` values and are smoothed exactly once
here, at the worklet boundary (AD-20). `postMessage` carries only discrete
changes and the metering return. Metering is one-way and lossy-tolerant: a
dropped frame must never affect audio, state or correctness (AD-12).

Arrives in story 1.3.
