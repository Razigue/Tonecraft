# `engine/` — what the product does with the chain

**Depends on `schema/`.**

Recording uses `dsp/recorder.h` to keep the selected raw mono input before
trim and effects (up to five minutes). `Engine.startRecording/stopRecording`
return a take via bounded `tc_read_recording` payloads; the capture stays open
while recording even when output Power is off. Completed takes survive normal
engine stops. `recording.ts` encodes float32 WAV without normalizing the DI;
`render-recording.ts` runs the current tone through the same WASM in an export
worker, preserving reverb and pitch tails. Neither score audio, the metronome
nor looper playback enters the recording tap. Native recording needs the
payload-return support documented in `service/PROTOCOL.md`.

What that costs, measured: the five-minute buffer is 57 MB and is allocated on
the audio thread by the first `tc_record_start`, 35 ms — one dropout when
Record is first pressed, before the take begins. It is then kept, so every
later take starts in 0.00 ms. The tap itself is a copy of the block: about
4 µs per 128 frames while the fresh pages are first touched, 1.5% of a core,
and nothing measurable after that. Export renders in a worker, so it costs the
audio thread nothing at all.

The chain itself is one WebAssembly module, `public/dsp/chain.wasm`, compiled
from `dsp/` by `npm run build:dsp`:

```
source (live DI or an audio file, played by the chain itself)
  -> frontend      channel choice, trim, gate
  -> pitch         a transposer, an octave either way; bypassed by default
  -> boost         TS style, 4x + ADAA
  -> amp           the NAM capture — NeuralAmpModelerCore
  -> capture trim  measured offline, so captures match each other
  -> cabinet       IR synthesised in ir.ts, zero-latency convolution
  -> four-band correction, the Web Audio biquad formulas exactly
  -> reverb, in parallel, computed only while audible
  -> looper        records what leaves the rig; the click is added after it
  -> master
  -> limiter       always on, no control anywhere; then peak, RMS, meter frame
```

It has two hosts, and this directory is what keeps them from drifting apart:

| File | Role |
|---|---|
| `engine.ts` | Everything the product decides: parameters, power, the tuner's silence, the source, the capture, the cabinet. Sends the same `tc_*` calls to either host. |
| `chain-host.ts` | The interface a host implements. Hosts move samples and forward calls; they carry no feature. |
| `web-host.ts` | The browser: one AudioContext, the single AudioWorklet (`public/dsp/chain-processor.js`), the input, the output device. |
| `native-host.ts` | Tonecraft Engine (`service/`), for ASIO: a loopback WebSocket to the native program that runs the same `chain.wasm`. The engine owns its device configuration; the page edits it with `configure` and re-sends the chain's state when the engine reopens. Protocol: `service/PROTOCOL.md`. |

A feature added to `dsp/` or to `engine.ts` is in both hosts the moment it
exists, because neither host has anywhere to put one. `npm run test:parity`
holds them to it: the same calls through `chain-core.js` (V8) and through
`tonecraft-engine render` (wasmtime) must produce bit-identical output.

**Nothing in the chain adds latency.** The cabinet and reverb are split into a
direct-form head and a partitioned tail whose delay is exactly the head's
length, so both are zero-latency at any host block size; the limiter runs
sample by sample. `npm run test:chain` asserts it and `npm run measure:latency`
prints it: 0 frames for the chain, 4.6 frames (0.1 ms) inside the boost's
oversampler. What is left is the host's buffer — the browser's render quantum
and output device, or the ASIO buffer the player chose.

The transposer is the exception, and only while it is engaged: aligning a
shifted waveform means waiting for it to come round again, which measures 8.6 ms
an octave down and 14.1 ms an octave up. It reports that in the meter frame
(`pitch_delay_ms`), and `app/` adds it to the round trip it shows.

The looper is not a second source of truth either: `engine.ts` sends presses,
the chain owns what they mean, and what the interface draws is the state the
chain reports. A loop is audio, so it dies with the chain — stopping the engine
empties it.

Parameters cross as raw engineering units (AD-9) and the chain glides to them
itself (`dsp/smooth.h`, AD-20): the native host has no AudioParam, and one
smoothing layer for both is what makes them sound the same while a fader moves.
Metering is one-way and lossy-tolerant (AD-12): a frame of `schema/chain.ts`'s
layout, about 30 times a second, from whichever host is running.

The output device follows the input's hardware (`groupId`) unless the player
chose one: the headphones are in the interface, and one clock in and out means
no drift. `canChooseOutput()` is false on Firefox, which has no `setSinkId` on
AudioContext. Under Tonecraft Engine the driver decides, and with ASIO input
and output are the same device by construction.

`ir.ts` synthesises both impulse responses as plain samples at the chain's
rate — no `.wav`, and a minimum-phase cabinet, the most compact transient a
given magnitude admits. One synthesis for both hosts: the native engine
receives the samples.

The metronome keeps its own AudioContext in the browser, because it ticks with
the engine off. Under Tonecraft Engine it hands its voices to the chain's click
generator instead (`dsp/click.h`): with ASIO the browser's output is not where
the headphones are.

`diagnosis.ts` turns measurements into sentences and nothing else. Every
function in it is pure, and no verdict it can return stops anyone playing.
Nothing displays those sentences at the moment; `engine.health` still computes
them for whoever wants them back.
