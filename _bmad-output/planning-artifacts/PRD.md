---
title: Tonecraft — Product Requirements Document (v1 MVP)
status: final
created: 2026-09-02
updated: 2026-09-02
---

# Tonecraft — PRD (v1 MVP)

**Inputs:** `brainstorm-intent.md` (83-entry brainstorming session, MoSCoW validated), `PRODUCT.md`, `CLAUDE.md`, `DESIGN.md`.
**Mode:** coaching path, journey-led.

---

## 1. Product summary

Tonecraft is a guitar amp and effects rig that runs entirely in a browser tab. No install, no plugin, no driver, no account, no server.

**The inversion that shapes everything:** the DSP engine is not the product, it is the renderer that makes the product. It runs at build time to produce what most visitors will hear, and in real time for the minority who plug a guitar in. Playing is one mode, and it is not the most frequent one.

The product therefore has two disjoint load paths that share a look, a sound, and almost no code at runtime:

| Path | What loads | Who it serves |
|---|---|---|
| **Listen** | An audio file rendered at build time. 0 kB JS, no WASM, no `AudioContext`, no microphone permission. | Most visitors, on any device including phones. |
| **Play** | The full engine in a single AudioWorklet. | The player with a guitar and a way to plug it in. |

---

## 2. User journeys

Four journeys. UJ-1 and UJ-3 are the same person on different hardware; they are separated because the product's behaviour diverges before the first note, not after it.

### UJ-1 — Léo tweaks a tone and passes it on *(play path)*

Léo, 22, has had the guitar in hand for ten minutes, working a passage dry through headphones, and is tired of hearing bare wood. He owns a 25 EUR guitar-to-USB cable, not an interface. He is not evaluating amp sims; he is trying not to put the guitar down.

1. He opens the tab. Onboarding detects his device, measures the round trip, and shows it. He grants microphone permission.
2. The default preset is already loaded and sounding. He plays. **He touches nothing for the first several minutes** — this is the whole point of the default preset being the product.
3. Something bothers him: too much low end, not enough bite. He moves two or three faders. The cord shows the change travelling down the chain.
4. He now has *his* tone rather than ours. He saves it locally so it survives the tab closing.
5. He sends it to someone — as a link, or as a file.

**What this journey demands:** a default that is good enough to be left alone; controls that reward being touched; persistence with no account; and an export that carries the exact tone, not an approximation of it.

**Closing note:** step 5 is the growth loop. It is the only step in v1 where one user creates another.

### UJ-2 — Inès hears the product before she owns anything *(listen path)*

Inès is on her phone. Someone shared a link, or a preset page ranked for something she searched. She has no interface, and possibly no guitar in the room.

1. The page opens. Sound is available in about a second — it is a file, not a render.
2. She presses play. She hears the tone and sees the cord move in exactly the way it moves on the play path.
3. She understands what the product is without reading a description of it.
4. She may never plug anything in. That is an acceptable outcome; she is still the majority of the audience and the place the product is judged.

**What this journey demands:** no engine, no permission, no JS beyond a play control; and a cord that is visually identical to the play path, because that identity is what makes the two paths one product rather than two sites sharing a name.

### UJ-3 — Léo plugs into the wrong hole *(play path, degraded hardware)*

Same person, same intent, wrong cable. Léo has run a guitar jack into the laptop's microphone input. A passive pickup wants a 500 kΩ–1 MΩ load; that input offers a few kΩ and injects bias voltage. The signal arrives weak, thin and treble-starved, on top of 40 ms or more from onboard audio.

**Through a high-gain amp this does not sound merely duller — it sounds bad.** High gain amplifies the deficiency along with the signal.

1. Calibration detects it before the first note: device label, measured round trip, input level, bandwidth.
2. The product states the cause in one sentence and the remedy in one sentence.
3. **It does not block.** Léo can play anyway if he wants to.

**What this journey demands:** the diagnosis must land *during onboarding*, not after Léo has already formed a judgement about how Tonecraft sounds. The user cannot tell an impedance problem from a bad DSP engine, and will blame the engine.

### UJ-4 — Inès opens Léo's custom tone with no interface *(listen path, runtime render)*

Inès receives the link from UJ-1 step 5. It encodes a chain state no build-time file exists for.

1. The engine downloads and renders a fixed DI loop through Léo's exact chain, faster than real time, via `OfflineAudioContext`.
2. The resulting buffer plays back. There is no live input and no dropout risk.
3. **It is slow to open, and that is accepted.** The alternative is a link that does nothing for the person who has no interface — which would break the growth loop at its last step.

**What this journey demands:** the same engine and the same settings as real time, because a tone that sounds different for the recipient makes the link a lie.

---

## 3. Cross-journey invariant

The cord is the only element strictly identical on both load paths. On the play path it is driven by per-stage RMS computed inside the worklet and posted at 30 Hz; on the listen path by an RMS envelope computed at build time and animated from `audio.currentTime`. Two mechanisms, one behaviour, deliberately.

---

## 4. What v1 is

### 4.1 The signal chain

Fixed order. No rearranging — a power feature that costs UI complexity and buys nothing for this audience.

```
In  ->  Gate  ->  Drive  ->  Amp  ->  Cab (IR)  ->  Reverb  ->  Out (limiter)
```

| Block | v1 | Why it is in v1 |
|---|---|---|
| In | Gain trim, input meter | Nothing works without a correctly staged input, and with high gain a badly staged one is destructive. |
| Gate | Threshold, auto-release | Structural, not a comfort. A high-gain amp with no gate is unusable in a room with a computer fan in it. |
| Drive | **One** type `[ASSUMPTION A-1]`, Gain / Tone / Level | Promoted from Should. A boost in front of high gain tightens the low end and defines the attack. It is adjacent to the amp, so it shares the same oversampling window. |
| Amp | **One** model: saturated high-gain lead, built for shred and solos. Gain / Bass / Mid / Treble / Master | The one tone that has to be excellent. Long sustain, natural compression, forgiving of imprecise playing, flattering to a cheap guitar. |
| Cab | **One** IR, Mix | Ours, licence-clean. A high-gain amp without a cab is not a sound, it is a fault. |
| Reverb | One room, Mix | Promoted from Should. Dry high gain in headphones sits "inside the head" and fatigues within minutes, and a lead line with no ambience has nowhere to sustain into. This is a scene-A defect, not a matter of taste. It sits after all non-linearities, so it is never oversampled. |
| Out | Master, mute, **non-disableable limiter** | The limiter is never exposed. A digital feedback loop in headphones can injure. |

**Named by character, never by trademark.** No reference to any real amplifier, pedal, artist or existing plugin, in the product or in the repository.

### 4.2 The MVP in one sentence

One excellent high-gain lead tone, made for soloing, audible in one second by anyone on any device, playable in real time by anyone with a guitar and a way to plug it in, adjustable, saveable, and shareable as a link or a file — with no account, no server and no install.

**v1 ships exactly one preset.** One tone, one page, one thing to get right. Width is cut; depth never is.

---

## 5. Functional requirements

FR IDs are stable and globally numbered. Groups are capability clusters, not modules.

### FG-A — The listen path *(UJ-2)*

- **FR-1.** The default preset has an indexable URL at `/presets/<slug>` serving an audio file rendered at build time. v1 ships one such page; the mechanism is built to take more without code changes, since a preset is a chain state rather than a model.
- **FR-2.** A preset page ships **at most 2 kB of inline vanilla JavaScript** — a play control and the cord animation — and nothing else: no framework, no hydration, no WASM, no `AudioContext`, no microphone permission, no engine. Asserted at build time and fails the build, not stated as an intention. *(Corrected during architecture: FR-5 requires the cord animated from `audio.currentTime`, and animation synced to playback cannot be done without script. The original "0 kB" was a promise the product could not keep.)*
- **FR-3.** A preset page reaches audible sound in under one second on a mid-range phone over 4G.
- **FR-4.** A preset page renders the signal chain read-only — same modules, same fader positions, same cord — over a single play control. Nothing on it is draggable and nothing pretends to be.
- **FR-5.** The cord on a preset page is animated from an RMS envelope computed at build time and shipped as JSON, driven by `audio.currentTime`.
- **FR-6.** Build-time renders use **identical** engine settings to the real-time path. The offline render has no CPU budget and must not use the headroom that gives it.

### FG-B — Onboarding and calibration *(UJ-1, UJ-3)*

- **FR-7.** Before any engine loads, onboarding detects browser, device, input devices and sample rate, and reports what it found.
- **FR-8.** `getUserMedia` requests the input with `echoCancellation`, `noiseSuppression`, `autoGainControl` and `voiceIsolation` all disabled, `channelCount: 1`, `latency: 0`. This is the single most common failure mode for browser audio applications and it gets an explicit automated test.
- **FR-9.** The `AudioContext` is created at the exact sample rate reported by `track.getSettings()`, read **before** the context exists, inside a user gesture.
- **FR-10.** Calibration measures round-trip latency, input level and input bandwidth, and reads the device label.
- **FR-11.** When calibration identifies a degraded input — onboard microphone input, impedance mismatch signature, or a round trip over 35 ms — the product states the cause in one sentence and the remedy in one sentence, **during onboarding, before the first note**.
- **FR-12.** **Onboarding never blocks.** Every diagnosis is informational. The user can always proceed to play.
- **FR-13.** A guitar-to-USB cable is a supported, first-class input. Nothing in the product treats it as a lesser device.

### FG-C — The signal chain *(UJ-1)*

- **FR-14.** The entire chain runs in **one** `AudioWorkletProcessor`. Not one node per effect; every node boundary is a memory copy.
- **FR-15.** `process()` performs zero allocation. All buffers are pre-allocated at init. No DOM access, no `await`, no exceptions, no logging in the audio path.
- **FR-16.** 4x oversampling covers the contiguous non-linear window — drive waveshaper through neural amp — with polyphase half-band filters. Gate, reverb, EQ and limiter are never oversampled.
- **FR-17.** The neural amp model is fixed at build time at LSTM hidden size 20. Model complexity is **never** selected at runtime from measured headroom.
- **FR-18.** The output limiter is always active and has no UI control, in any mode, on any path.
- **FR-19.** Continuous parameters reach the worklet as `AudioParam` values for sample-accurate interpolation. `postMessage` carries only discrete changes — preset switch, IR load — and the metering return.
- **FR-20.** Each block can be bypassed except the limiter. A bypassed block routes the cord straight past it.

### FG-D — The rig interface *(UJ-1)*

- **FR-21.** The application is a single Svelte island on a single route, `client:only`. Content pages ship 0 kB of JS.
- **FR-22.** Every continuous control is a vertical linear fader. There are no rotary controls anywhere in the product.
- **FR-23.** There is no `<canvas>` and no `AnalyserNode` anywhere: no spectrum analyser, no oscilloscope. The cord carries all signal visualisation.
- **FR-24.** The cord's per-segment opacity is driven by per-stage RMS computed in the worklet, written to a pre-allocated `Float32Array` and posted at 30 Hz. A clipping segment, and only that segment, turns `--ember`.
- **FR-25.** Metering is suspended while the tab is hidden.
- **FR-26.** Every control is reachable and operable by keyboard, with a visible focus ring, and announces its value.
- **FR-27.** The product's voice is plain, short and never enthusiastic. Amps and presets are named for what they sound like, never after real gear. Every preset carries exactly one lowercase description line of three to six words. Buttons name the outcome and the confirmation reuses the same word. Errors state the cause in one sentence and the fix in one sentence. The words *immersive, powerful, seamless, unleash, unlock* and *craft* as a verb never appear.

### FG-E — Tone state: adjust, keep, pass on *(UJ-1 steps 3-5, UJ-4)*

- **FR-28.** A fader the user moves reaches the audio within one render quantum (2.67 ms at 48 kHz) with no zipper noise, and is reflected in the cord on the next metering frame. This is what the `AudioParam` interpolation in FR-19 buys.
- **FR-29.** The complete chain state serialises to a single canonical object. The tone link and the tone file are two containers for that one object — same encoder, same values, no approximation and no lossy path.
- **FR-30.** **Tone link:** the state encodes into the URL hash. Opening the link reproduces the tone exactly. No server, no shortener, no stored state.
- **FR-31.** **Tone file:** the user can download the state as a versioned JSON file, and load one back in.
- **FR-32.** Import validates the file: an unknown version, a missing field or an out-of-range value produces a named error and leaves the current tone untouched. It never half-applies a tone.
- **FR-33.** Tones the user saves persist in `localStorage`. No account, no sign-up, no server, at any point.
- **FR-34.** Opening a **custom** tone link without a usable input renders the chain over a fixed DI loop through `OfflineAudioContext` and plays the resulting buffer. It is slow to open and says so.

### FG-F — Measurement and honesty *(UJ-1, UJ-3)*

- **FR-35.** `baseLatency + outputLatency` is computed, displayed permanently and logged. Under 20 ms nothing is said; from 20 to 35 ms the number is shown and clicking it explains; over 35 ms the hardware cause is named.
- **FR-36.** A dropout is any `process()` call that misses its render deadline. They are counted continuously for the session and the count is visible in the UI.
- **FR-37.** **The product never refuses the play path on performance grounds.** There is no CPU benchmark gate and no engine-load refusal. When dropouts occur the product names the likely cause and offers the listen path as an alternative — as an offer, never as a redirect.
- **FR-38.** Latency jitter is instrumented alongside the absolute figure. A varying delay is the failure, not a constant one.

### FG-G — Tuner *(UJ-1, before step 2)*

- **FR-39.** A chromatic tuner with a cents readout, accurate to within ±1 cent from the low E of a 6-string in standard tuning upward, reachable from a discreet icon and opening as a sheet over the rig.
- **FR-40.** Tuner accuracy does not degrade with round-trip latency. Pitch is detected on the input before the chain, so a 40 ms output path shifts only when the reading appears, never what it reads.

### FG-H — Content, language and discovery *(UJ-2)*

- **FR-41.** French and English from the first day, with correct `hreflang` on every page.
- **FR-42.** JSON-LD on every content page: `SoftwareApplication` on the home page, `FAQPage` on the FAQ, `HowTo` on guides.
- **FR-43.** Sitemap and Open Graph images are generated at build time.
- **FR-44.** **The long-tail guides are launch deliverables, not post-launch content.** With one preset there is one preset page, so the guides carry the entire indexable surface at launch: playing guitar on a PC with no audio interface, reducing latency without ASIO, free guitar amp in the browser. Each ships in both languages.
- **FR-45.** Adding a preset later requires no application code: a set of parameter values, a build-time render, and a page generated from them.
- **FR-46.** All hosting is static. No server, no serverless function, no database, no custom HTTP header, at any point and for any feature.

### FG-I — Measurement *(cuts across every journey)*

Every target in §7 has to come from somewhere. With no server and no account, that somewhere is a cookieless third-party analytics endpoint — `CLAUDE.md` §2 names GoatCounter and Cloudflare Web Analytics, both free and both usable from a static host.

- **FR-47.** The play path emits anonymous, cookieless, aggregate-only events sufficient to compute every metric in §7: session start with device class and measured round trip, dropout count, latency jitter, time to first audible note, session length, fader touched, tone link created, tone link opened.
- **FR-48.** No event carries an identifier, a cookie, a fingerprint or anything that could link two sessions to one person. Aggregates only.
- **FR-49.** Measurement is disclosed in one plain sentence and is refusable. Refusing it changes nothing about the product's behaviour.
- **FR-50.** Tone file sharing is **deliberately unmeasured** `[ASSUMPTION A-3]`. A downloaded file leaves the product; measuring where it goes would require exactly the tracking FR-48 forbids.

---

## 6. Non-functional requirements

### Performance

- **NFR-1.** CPU: under 25% of one core on a 2019-2020 mid-range laptop, whole chain. **The CPU budget is the dropout budget** — in an AudioWorklet the quantum is fixed at 128 frames, so there is no buffer setting to trade latency against CPU. Exceeding the budget does not produce delay, it produces a glitch.
- **NFR-2.** Under 400 KB for first interactive. The default preset's assets — the one amp model, the one IR, the one drive — are inside that budget because the default preset must sound before anything else loads. Everything else is lazy-loaded.
- **NFR-3.** Median time to first audible note under 8 seconds from cold load, including permission grant.
- **NFR-4.** The main thread never blocks for more than 8 ms. A UI jank becomes an audible dropout.
- **NFR-5.** Core Web Vitals 100/100 on every content page.

### Accessibility floor

- **NFR-6.** Every interactive target is at least 40px in its smaller dimension, whatever its visual width.
- **NFR-7.** `--celadon` never carries information on its own. It is always paired with position or a label, so a red-green colour vision deficiency cannot make the cord useless.
- **NFR-8.** Any component that cannot hold 30 fps is simplified rather than optimised. The UI thread never competes with the audio thread.

### Determinism

- **NFR-9.** The same tone state produces the same audio on every machine that can run the engine. Quality never adapts to available headroom — an adaptive engine would make the tone link lie, and the tone link is the only mechanism in v1 by which one user creates another.

### Compatibility

- **NFR-10.** Listen path: every browser, every device, phones included. No requirement of any kind.
- **NFR-11.** Play path: Chromium, Firefox and Safari on desktop. Firefox has no `setSinkId`; Safari has higher latency. Both are supported, not degraded.
- **NFR-12.** Play path is not supported on mobile, and says so plainly. The listen path on the same URL is fully functional there.
- **NFR-13.** No `SharedArrayBuffer`, no WASM threads, no COOP/COEP, no `coi-serviceworker`, no cross-origin isolation anywhere. GitHub Pages cannot provide the headers and the product does not need them.

### Build

- **NFR-14.** WASM compiled with `-O3 -msimd128 -flto -fno-exceptions -fno-rtti`.
- **NFR-15.** The parameter schema has one source of truth in TypeScript; the C++ header is generated from it, never hand-copied.

### Legal and privacy

- **NFR-16.** All impulse responses are ours or licensed with redistribution rights, with documented provenance.
- **NFR-17.** No visual, naming or marketing association with any artist, any real amplifier or any existing plugin — in the product, the marketing or the repository.
- **NFR-18.** The product stores no personal data, no identifier and no cookie, anywhere. Tones live in the user's own `localStorage`; measurement (FG-I) is anonymous and aggregate-only and can be refused. Nothing the product holds can be traced to a person.

---

## 7. Success metrics

| Metric | Target at 3 months |
|---|---|
| **Reported audio dropouts per session** | **under 0.2** |
| Latency jitter, standard deviation over a session | under 2 ms |
| Time to first audible note, median | under 8 s |
| Preset page: time to audible sound | under 1 s |
| Sessions reaching audible sound, where an input device exists | over 70% |
| Median session length | over 12 min |
| Sessions where at least one fader is moved | over 50% |
| Tone links opened per link created | over 1.5 |

**Absolute latency is deliberately absent.** It is measured and shown, but it is dominated by hardware we do not control, and its stability matters more than its value.

**Counter-metrics** — watched so the metrics above are not gamed:

| Counter-metric | Watch for |
|---|---|
| Share of sessions that abandon during onboarding | Diagnosis honesty (FR-11) turning into discouragement. |
| Share of sessions that move a fader in the first 30 seconds | A high number means the default preset is not good enough to be left alone, which contradicts principle 3. |
| Bandwidth consumed per month | The one real ceiling: ~100 GB/month on GitHub Pages, roughly 400k demo listens. |
| Median CPU load on the play path | NFR-1 has essentially no headroom left after the Drive and Reverb promotions. |

---

## 8. Explicitly out of v1

Accounts, any paid tier, any sync · a server, a serverless function, a database or a custom HTTP header, ever · delay · recording and export of audio · user IR upload · chain reordering, dual amps, stereo rigs · spectrum analyser and oscilloscope · playing on mobile · metronome (v1.1) · amps 2 and 3, drives 2 and 3, compressor (v1.1) · the twelve factory presets beyond the default (v1.1) · dark mode (v1.2)

---

## 9. Open items

| # | Item | Blocks |
|---|---|---|
| OI-1 | The positioning line. *"Branche ta guitare ou juste écoute"* — *juste* demotes listening to a consolation prize, contradicting the decision that made it the primary path. Both languages. | Marketing, home page copy. Not a phase blocker. |
| OI-2 | The default preset's identity and name. *"Crimson Room, clean, wide, a little dark"* described a clean amp and is now dead. The tone that **is** the product needs a name and a one-line description. | UX copy. Not a phase blocker. |
| ~~OI-3~~ | **Resolved.** v1 ships one preset: a high-gain lead for shred and solos. Consequence: the launch indexable surface moves off preset pages and onto the long-tail guides (FR-44). | — |
| OI-4 | **The cab: `ConvolverNode` or convolution inside the worklet.** `CLAUDE.md` asks for both a native `ConvolverNode` and a single worklet for the whole chain; those are incompatible. See addendum §D. | Architecture. Must be settled before the worklet is written. |
| ~~OI-5~~ | **Resolved.** The DI loop is recorded in-house — roughly 20 seconds of **electric** guitar DI — an unprocessed lead line, pickups straight in, no amp and no effects — captured through a guitar-to-USB cable at the 48 kHz internal design rate. The high gain and the reverb are what the chain adds to it; they are never in the recording. Provenance is ours, like the IR. It is a source asset committed to `assets/`, and it is a **prerequisite for Epic 4 and for FR-34**, both of which render through it. It must be a lead line rather than a chord strum: with one shred preset, that recording is what most visitors will judge the product by. | — |
| OI-6 | **Trademark clearance.** `PRODUCT.md` §7 requires INPI, EUIPO class 9 and 42, and US TESS searches on "Tonecraft" before any launch spend. "Tone" is a crowded namespace in music software. Not started. | Launch, domain purchase, GitHub org name. |
| OI-7 | Which analytics endpoint (FG-I): GoatCounter or Cloudflare Web Analytics. Both are free and cookieless; they differ in custom-event support, which FR-47 needs. | FG-I implementation. |

## 10. Upstream documents to reconcile

Decisions in this PRD contradict text currently in the repository. These are not errors in the PRD; they are documents that have not caught up.

| Document | Line | Now says |
|---|---|---|
| `PRODUCT.md` §5 | "a machine that cannot hold the budget gets an honest refusal" | No refusal path exists (FR-37). |
| `PRODUCT.md` §4 | Drive and Reverb marked Should; drives lazy-loaded | Both Must; one drive is in the first-interactive bundle. |
| `PRODUCT.md` §4 | "Tuner is non-negotiable… the single most used feature" | Tuner ships in v1 but behind a discreet icon; the metronome moves to v1.1. |
| `PRODUCT.md` §4, `DESIGN.md` §9 | Default preset "Crimson Room, clean, wide, a little dark" | The v1 amp is a saturated high-gain lead. |
| `PRODUCT.md` §4 | Sharing is the tone link | Sharing is the tone link **and** a downloadable tone file. |
| `CLAUDE.md` §2, §3 | `ConvolverNode` for the cab, one worklet for the whole chain | Incompatible. See OI-4. |
| `CLAUDE.md` §6 | "the launch indexable surface comes from the 12 preset pages" | v1 ships one preset page. The guides carry the launch surface (FR-44). |
| `PRODUCT.md` §4 | "the 12 curated factory tones and their preset pages" (Should) | One preset in v1. More are content, added without code (FR-45). |

---

## 11. Glossary

Every term below is load-bearing and is used identically in every FR, journey and metric.

| Term | Definition |
|---|---|
| **Play path** | The load path where the full engine runs in real time on live guitar input. |
| **Listen path** | The load path where no engine loads and the visitor hears an audio file rendered ahead of time. |
| **Chain state** | The complete set of parameter values for every block in the signal chain. One canonical object; the tone link and the tone file are two containers for it. |
| **Tone link** | A chain state encoded into a URL hash. Shareable, openable by anyone, stored nowhere. |
| **Tone file** | The same chain state as a versioned JSON file the user downloads and can load back. |
| **Preset** | A named chain state, plus a one-line description and a build-time render. Not a model — adding one requires no application code. |
| **The cord** | The 1px hairline connecting the modules, whose per-segment opacity tracks the signal amplitude at that point. The product's entire signal visualisation, on both paths. |
| **Render quantum** | The AudioWorklet's fixed processing block: 128 frames, 2.67 ms at 48 kHz. Not configurable. |
| **Dropout** | A `process()` call that misses its render deadline. Audible as a click or a crackle. The product's primary failure metric. |
| **Oversampling window** | The contiguous region of the chain processed at 4x — drive waveshaper through neural amp. Nothing outside it is oversampled. |
| **DI loop** | The fixed dry guitar recording played through the chain for build-time renders and for the `OfflineAudioContext` fallback. |
| **Round trip** | `baseLatency + outputLatency`, measured on the user's actual hardware. |
| **Floor machine** | The lowest-spec machine the engine is tuned for. Model complexity is chosen for it at build time and never adapts upward. |

---

## 12. Assumptions

Inferences made while drafting that the user did not directly confirm.

| # | Assumption | Where | If wrong |
|---|---|---|---|
| **A-1** | v1 ships **one** drive type, the one the default preset uses. `PRODUCT.md` §4 describes three lazy-loaded pedals; promoting Drive to Must puts at least one inside the 400 KB first-interactive budget, and a shred preset needs only a boost in front of the amp. | §4.1, FR-14..FR-20 | Two more drives move from v1.1 into v1, adding bundle weight but no new oversampling cost — they share the existing window. |
| **A-3** | Tone **file** sharing is not measured, only tone links. The growth loop is credited to links alone in §7, which understates it if files turn out to be the common carrier. | §7, FR-50 | A file-share counter would need per-file identifiers, which FR-48 forbids. The honest alternative is to accept an unmeasured channel rather than weaken FR-48. |
| **A-2** | Stakes are launch-grade rather than hobby. `PRODUCT.md` carries three-month success metrics, an SEO strategy and trademark clearance steps. PRD length and rigour are calibrated to that. | Whole document | A hobby-stakes reading would cut §7, §10 and most of the addendum. |
