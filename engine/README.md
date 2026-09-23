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

`ir.ts` synthesises the stock cabinets and reverb as plain samples at the
chain's rate. Recorded cabinets, including the Celestion G12 Vintage WAV,
are decoded by `builtInCabIRAt` in `engine.ts`, then trimmed and normalized
like user-loaded IRs. Both hosts and processed exports receive these same
samples; saved takes can also be exported before starting the audio engine.

The metronome keeps its own AudioContext in the browser, because it ticks with
the engine off. Under Tonecraft Engine it hands its voices to the chain's click
generator instead (`dsp/click.h`): with ASIO the browser's output is not where
the headphones are.

`diagnosis.ts` turns measurements into sentences and nothing else. Every
function in it is pure, and no verdict it can return stops anyone playing.
Nothing displays those sentences at the moment; `engine.health` still computes
them for whoever wants them back.

## A tab through the amplifier

`di-bank.ts`, `di-palm.ts`, `di-sampler.ts`, `tab-guitar.ts`, `tab-render.ts`,
`tab-audio.ts`, `tab-audio-worker.ts`, `tab-playback.ts`.

A tab can be played through the rig instead of through the soundfont. It is
rendered first, never live:

```
score -> tab-guitar    the tab as gestures: string, fret, pick or hammer,
                       palm mute, pinch, bend — read from the model, on
                       alphaTab's own order of play, so repeats land where
                       alphaTab puts them
      -> di-sampler    one voice per string, playing real DI notes from the
                       bank; a new pick stops the string, a hammer-on only
                       moves its pitch
      -> tab-render    the same chain an exported take goes through, kept open
                       across chunks so a ringing note and a reverb tail cross
                       the boundary intact
      -> tab-playback  a row of buffers per track, placed on one clock, with
                       alphaTab in external-media mode following it
```

Everything that is not a guitar — bass, drums, keys — is rendered by alphaTab's
own synthesiser and arrives as one more track. Every track keeps its own
buffers and its own gain, so the reader's mixer, its solos and its mutes stay
gains rather than another render.

**Why it is rendered and not played live.** One amped track costs about what
the player's own guitar costs: 28% of a core without reverb, 34% with, measured
by `npm run bench` on a 2017 laptop. Three tracks live would be the CPU budget
gone and the dropouts with it. Rendered in workers, none of it touches the
audio thread, and falling behind only means waiting.

**Why it plays before it is finished.** A whole song is minutes of work, and
nobody should watch a bar move for that long. Tracks are rendered a chunk at a
time, in the order they will be heard, across as many workers as the machine
has cores to spare (one is always left; five at most, since each holds its own
40 MB of bank). Playback starts on a head start rather than on the end of the
render, and how much of one is decided by the render's own measured speed: if
it makes `v` seconds of music per second, starting with `r` rendered is safe
when `r >= (1 - v) * total`. Above real time that is nothing, and the 20-second
minimum applies.

**Measured on that 2017 dual-core laptop**, worst case first: Archspire's *Drain
of Incarnation*, seven guitar tracks over 4:17, renders at about half real time
— playable after 4.3 minutes, all there in 8.2. Two tracks of an 80-second tab
are playable after a fifth of the render. A modern four- or eight-core machine
runs several tracks at once and starts on the 20-second minimum.

**Speed is a render, not a resampling.** Slowing a tab down — the practice move
the reader exists for — renders it again at that speed: the guitars' events are
stretched and the band is exported from a score whose tempo marks are scaled
for the microseconds it takes to generate its MIDI. Resampling instead would
drop the whole song a tone. alphaTab is told the speed in both modes, since its
own time-to-tick conversion is scaled by it, and the tab picks up where it was
as soon as that far is rendered again. Syncing to the metronome is the same
thing with the ratio the click asks for.

**What that costs elsewhere.** The gain into the amplifier cannot wait for the
whole track to exist, and one that changed halfway would change the tone, since
what follows it is not linear — so it is estimated from the notes themselves
(`estimateRms`), within about a dB of the rendered level. The bank is 15 MB of
16-bit samples, fetched on the first tab played through the amp and never
before. The playback speed is fixed while the amp plays a tab: slowing a render
is another render, and resampling it would drop the song a tone. The reader
says so and disables the control rather than ignoring it.

**Where the candidates were compared.** The sampler was chosen by ear against a
physical model of the strings, and the measurements that settled it — the palm
mask against real mutes, the level estimate against rendered tracks, the two
candidates through the same amplifier — live on the `poc/tab-di` branch, with a
README of their own. Nothing there is imported by the site; it is the bench,
kept off `main` because it holds a second copy of what `engine/` now does.

**The bank is built and committed** (`scripts/build-di-bank.ts`, 47 MB under
`public/di-bank/`): the deploy stays a pure function of the commit, as the
40 MB soundfont beside it already decided, and CI neither needs a 23 GB dataset
nor a network call to produce it. Building it measures which note
each file sounds, where its pick lands, how loud it is against its neighbours,
where it can be looped, and what the palm does to each string, so nothing is
analysed on the player's machine.

It is built from **EG-IPT** (Fiorini, Brochec, Borg, Pasini,
zenodo.org/records/15205644), **CC BY-4.0**: a 2005 Gibson SG through a BSS
AR-133 DI box at 96 kHz, one file per note. The bridge humbucker's DI channel
gives 138 picked notes and **a real palm mute at every fret of every string**,
plus the guitar's own harmonics. The licence is why it is this dataset: a bank
cut from a no-derivatives one could never be published, whatever it sounded
like. Attribution is owed and is carried in `assets/README.md`.

What the bank cannot hold is a string the guitar does not have — a
seven-string's low B, an eight's F#. Past three semitones the palm mask takes
over from the recorded mute, because dragging one that far down takes its pick
click and its pickup resonance with it: 14.9 dB from a real mute, where two
real takes of the same mute are 12.2 dB apart.
