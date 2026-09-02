---
stepsCompleted: ['step-01-validate-prerequisites', 'step-02-design-epics', 'step-03-create-stories', 'step-04-final-validation']
inputDocuments:
  - '_bmad-output/planning-artifacts/PRD.md'
  - '_bmad-output/planning-artifacts/Architecture.md'
  - 'DESIGN.md'
  - 'CLAUDE.md'
  - '_bmad-output/planning-artifacts/prds/prd-tonecraft-2026-09-02/addendum.md'
---

# Tonecraft v1 MVP - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for Tonecraft v1 MVP, decomposing the requirements from the PRD, UX Design if it exists, and Architecture requirements into implementable stories.

## Requirements Inventory

### Functional Requirements

IDs are the PRD's own and are preserved verbatim — the 21 architecture decisions reference them in their `Binds` fields, so renumbering would break traceability.

**FG-A · Listen path (UJ-2)**

FR-1: The default preset has an indexable URL at `/presets/<slug>` serving an audio file rendered at build time. v1 ships one such page; the mechanism is built to take more without code changes, since a preset is a chain state rather than a model.
FR-2: A preset page ships **at most 2 kB of inline vanilla JavaScript** — a play control and the cord animation — and nothing else: no framework, no hydration, no WASM, no `AudioContext`, no microphone permission, no engine. Asserted at build time and fails the build, not stated as an intention.
FR-3: A preset page reaches audible sound in under one second on a mid-range phone over 4G.
FR-4: A preset page renders the signal chain read-only — same modules, same fader positions, same cord — over a single play control. Nothing on it is draggable and nothing pretends to be.
FR-5: The cord on a preset page is animated from an RMS envelope computed at build time and shipped as JSON, driven by `audio.currentTime`.
FR-6: Build-time renders use **identical** engine settings to the real-time path. The offline render has no CPU budget and must not use the headroom that gives it.

**FG-B · Onboarding and calibration (UJ-1, UJ-3)**

FR-7: Before any engine loads, onboarding detects browser, device, input devices and sample rate, and reports what it found.
FR-8: `getUserMedia` requests the input with `echoCancellation`, `noiseSuppression`, `autoGainControl` and `voiceIsolation` all disabled, `channelCount: 1`, `latency: 0`. This is the single most common failure mode for browser audio applications and it gets an explicit automated test.
FR-9: The `AudioContext` is created at the exact sample rate reported by `track.getSettings()`, read **before** the context exists, inside a user gesture.
FR-10: Calibration measures round-trip latency, input level and input bandwidth, and reads the device label.
FR-11: When calibration identifies a degraded input — onboard microphone input, impedance mismatch signature, or a round trip over 35 ms — the product states the cause in one sentence and the remedy in one sentence, **during onboarding, before the first note**.
FR-12: **Onboarding never blocks.** Every diagnosis is informational. The user can always proceed to play.
FR-13: A guitar-to-USB cable is a supported, first-class input. Nothing in the product treats it as a lesser device.

**FG-C · The signal chain (UJ-1)**

FR-14: The entire chain runs in **one** `AudioWorkletProcessor`. Not one node per effect; every node boundary is a memory copy.
FR-15: `process()` performs zero allocation. All buffers are pre-allocated at init. No DOM access, no `await`, no exceptions, no logging in the audio path.
FR-16: 4x oversampling covers the contiguous non-linear window — drive waveshaper through neural amp — with polyphase half-band filters. Gate, reverb, EQ and limiter are never oversampled.
FR-17: The neural amp model is fixed at build time at LSTM hidden size 20. Model complexity is **never** selected at runtime from measured headroom.
FR-18: The output limiter is always active and has no UI control, in any mode, on any path.
FR-19: Continuous parameters reach the worklet as `AudioParam` values for sample-accurate interpolation. `postMessage` carries only discrete changes — preset switch, IR load — and the metering return.
FR-20: Each block can be bypassed except the limiter. A bypassed block routes the cord straight past it.

**FG-D · The rig interface (UJ-1)**

FR-21: The application is a single Svelte island on a single route, `client:only`. Content pages ship 0 kB of JS.
FR-22: Every continuous control is a vertical linear fader. There are no rotary controls anywhere in the product.
FR-23: There is no `<canvas>` and no `AnalyserNode` anywhere: no spectrum analyser, no oscilloscope. The cord carries all signal visualisation.
FR-24: The cord's per-segment opacity is driven by per-stage RMS computed in the worklet, written to a pre-allocated `Float32Array` and posted at 30 Hz. A clipping segment, and only that segment, turns `--ember`.
FR-25: Metering is suspended while the tab is hidden.
FR-26: Every control is reachable and operable by keyboard, with a visible focus ring, and announces its value.
FR-27: The product's voice is plain, short and never enthusiastic. Amps and presets are named for what they sound like, never after real gear. Every preset carries exactly one lowercase description line of three to six words. Buttons name the outcome and the confirmation reuses the same word. Errors state the cause in one sentence and the fix in one sentence. The words *immersive, powerful, seamless, unleash, unlock* and *craft* as a verb never appear.

**FG-E · Tone state: adjust, keep, pass on (UJ-1, UJ-4)**

FR-28: A fader the user moves reaches the audio within one render quantum (2.67 ms at 48 kHz) with no zipper noise, and is reflected in the cord on the next metering frame. This is what the `AudioParam` interpolation in FR-19 buys.
FR-29: The complete chain state serialises to a single canonical object. The tone link and the tone file are two containers for that one object — same encoder, same values, no approximation and no lossy path.
FR-30: **Tone link:** the state encodes into the URL hash. Opening the link reproduces the tone exactly. No server, no shortener, no stored state.
FR-31: **Tone file:** the user can download the state as a versioned JSON file, and load one back in.
FR-32: Import validates the file: an unknown version, a missing field or an out-of-range value produces a named error and leaves the current tone untouched. It never half-applies a tone.
FR-33: Tones the user saves persist in `localStorage`. No account, no sign-up, no server, at any point.
FR-34: Opening a **custom** tone link without a usable input renders the chain over a fixed DI loop through `OfflineAudioContext` and plays the resulting buffer. It is slow to open and says so.

**FG-F · Measurement and honesty**

FR-35: `baseLatency + outputLatency` is computed, displayed permanently and logged. Under 20 ms nothing is said; from 20 to 35 ms the number is shown and clicking it explains; over 35 ms the hardware cause is named.
FR-36: A dropout is any `process()` call that misses its render deadline. They are counted continuously for the session and the count is visible in the UI.
FR-37: **The product never refuses the play path on performance grounds.** There is no CPU benchmark gate and no engine-load refusal. When dropouts occur the product names the likely cause and offers the listen path as an alternative — as an offer, never as a redirect.
FR-38: Latency jitter is instrumented alongside the absolute figure. A varying delay is the failure, not a constant one.

**FG-G · Tuner**

FR-39: A chromatic tuner with a cents readout, accurate to within ±1 cent from the low E of a 6-string in standard tuning upward, reachable from a discreet icon and opening as a sheet over the rig.
FR-40: Tuner accuracy does not degrade with round-trip latency. Pitch is detected on the input before the chain, so a 40 ms output path shifts only when the reading appears, never what it reads.

**FG-H · Content, language and discovery (UJ-2)**

FR-41: French and English from the first day, with correct `hreflang` on every page.
FR-42: JSON-LD on every content page: `SoftwareApplication` on the home page, `FAQPage` on the FAQ, `HowTo` on guides.
FR-43: Sitemap and Open Graph images are generated at build time.
FR-44: **The long-tail guides are launch deliverables, not post-launch content.** With one preset there is one preset page, so the guides carry the entire indexable surface at launch: playing guitar on a PC with no audio interface, reducing latency without ASIO, free guitar amp in the browser. Each ships in both languages.
FR-45: Adding a preset later requires no application code: a set of parameter values, a build-time render, and a page generated from them.
FR-46: All hosting is static. No server, no serverless function, no database, no custom HTTP header, at any point and for any feature.

**FG-I · Measurement**

FR-47: The play path emits anonymous, cookieless, aggregate-only events sufficient to compute every metric in §7: session start with device class and measured round trip, dropout count, latency jitter, time to first audible note, session length, fader touched, tone link created, tone link opened.
FR-48: No event carries an identifier, a cookie, a fingerprint or anything that could link two sessions to one person. Aggregates only.
FR-49: Measurement is disclosed in one plain sentence and is refusable. Refusing it changes nothing about the product's behaviour.
FR-50: Tone file sharing is **deliberately unmeasured** `[ASSUMPTION A-3]`. A downloaded file leaves the product; measuring where it goes would require exactly the tracking FR-48 forbids.

### NonFunctional Requirements


**Performance**

NFR-1: CPU: under 25% of one core on a 2019-2020 mid-range laptop, whole chain. **The CPU budget is the dropout budget** — in an AudioWorklet the quantum is fixed at 128 frames, so there is no buffer setting to trade latency against CPU. Exceeding the budget does not produce delay, it produces a glitch.
NFR-2: Under 400 KB for first interactive. The default preset's assets — the one amp model, the one IR, the one drive — are inside that budget because the default preset must sound before anything else loads. Everything else is lazy-loaded.
NFR-3: Median time to first audible note under 8 seconds from cold load, including permission grant.
NFR-4: The main thread never blocks for more than 8 ms. A UI jank becomes an audible dropout.
NFR-5: Core Web Vitals 100/100 on every content page.

**Accessibility floor**

NFR-6: Every interactive target is at least 40px in its smaller dimension, whatever its visual width.
NFR-7: `--celadon` never carries information on its own. It is always paired with position or a label, so a red-green colour vision deficiency cannot make the cord useless.
NFR-8: Any component that cannot hold 30 fps is simplified rather than optimised. The UI thread never competes with the audio thread.

**Determinism**

NFR-9: The same tone state produces the same audio on every machine that can run the engine. Quality never adapts to available headroom — an adaptive engine would make the tone link lie, and the tone link is the only mechanism in v1 by which one user creates another.

**Compatibility**

NFR-10: Listen path: every browser, every device, phones included. No requirement of any kind.
NFR-11: Play path: Chromium, Firefox and Safari on desktop. Firefox has no `setSinkId`; Safari has higher latency. Both are supported, not degraded.
NFR-12: Play path is not supported on mobile, and says so plainly. The listen path on the same URL is fully functional there.
NFR-13: No `SharedArrayBuffer`, no WASM threads, no COOP/COEP, no `coi-serviceworker`, no cross-origin isolation anywhere. GitHub Pages cannot provide the headers and the product does not need them.

**Build**

NFR-14: WASM compiled with `-O3 -msimd128 -flto -fno-exceptions -fno-rtti`.
NFR-15: The parameter schema has one source of truth in TypeScript; the C++ header is generated from it, never hand-copied.

**Legal and privacy**

NFR-16: All impulse responses are ours or licensed with redistribution rights, with documented provenance.
NFR-17: No visual, naming or marketing association with any artist, any real amplifier or any existing plugin — in the product, the marketing or the repository.
NFR-18: The product stores no personal data, no identifier and no cookie, anywhere. Tones live in the user's own `localStorage`; measurement (FG-I) is anonymous and aggregate-only and can be refused. Nothing the product holds can be traced to a person.

### Additional Requirements

Extracted from `Architecture.md` (21 ADs, conventions, stack, structural seed) and `CLAUDE.md`.

**Starter template.** The Architecture binds Astro 7.2.x with a Svelte 5 island rather than naming a bespoke scaffold, so the paved path applies: `npm create astro@latest` with the Svelte integration is the starting point for Epic 1 Story 1. Nothing else in the stack has a starter — `dsp/`, `engine/` and `render/` are hand-assembled.

**Project structure and dependency direction (AD paradigm).** Six top-level directories with one-way dependencies: `schema/` depends on nothing; `dsp/` and `engine/` depend on `schema/`; `app/` depends on `engine/` and `schema/`; `site/` depends on `app/` and `render/` output. `dsp/` never imports TypeScript. `app/` never imports `dsp/`. `site/` never imports `engine/`.

**Toolchain, versions pinned and web-verified 2026-09-02.** Astro 7.2.x · Svelte 5.57.x · TypeScript 5.x strict · nanostores 1.5.x · Tailwind 4.3.x · Emscripten 6.0.x pinned exactly in CI · RTNeural 1.0.0 header-only, compile-time API · Node 24 LTS (Krypton) for build and render only · GoatCounter hosted.

**Compile flags.** `-O3 -msimd128 -flto -fno-exceptions -fno-rtti`. `-mrelaxed-simd` is forbidden (AD-4): it permits engine-specific float rounding, which breaks determinism and makes a shared tone link render differently per browser.

**Code generation.** `schema/params.ts` is the single source of truth; `schema/generate.ts` emits `dsp/params.generated.h`. A hand-edited generated header fails the build. Regenerating in CI must produce no diff (AD-7).

**Stage interface contract (AD-19).** `void process(const float* in, float* out, uint32_t frames)`, mono float32, never in place, buffers never aliasing. `frames` is 128 outside the oversampling window and 512 inside it.

**Fixed internal sample rate (AD-18).** Every stage is designed for and runs at 48 kHz. Weights, half-band coefficients and the cab FIR are defined at that rate and no other. `engine/` converts explicitly at the chain boundary with our own deterministic resampler when the device runs at another rate. A stage may not read the device rate.

**Cab convolution (AD-3).** SIMD direct-form FIR compiled into the WASM, capped at 2048 taps. `ConvolverNode` is not used anywhere in the product.

**Model weights format (AD-14).** Binary Float32 blob, `[u32 magic][u32 version][u32 count][f32 ...]`, loaded into RTNeural at init. Not embedded in the WASM, not JSON.

**Tone state wire formats (AD-8, AD-9, AD-10).** Engineering units only (dB, Hz, ratio, ms), never normalised fader positions. Link: base64url of a packed binary layout in the URL hash. File: JSON with the schema's field names plus `schemaVersion`, `ampId`, `weightsVersion`. The schema is append-only forever — parameters are never removed, renamed, reordered in the wire format, or changed in meaning. Every weights version ever shipped stays served at a stable URL indefinitely.

**Parameter smoothing (AD-20).** Smoothed once, by `AudioParam` interpolation at the worklet boundary. A `dsp/` stage receives an already-smoothed value and adds none of its own.

**Meter and bypass addressing (AD-21).** Each stage declares a stable meter slot id and bypass parameter id in `schema/`. Nothing addresses a stage by its index in the chain.

**Build and deployment (AD-6, AD-15).** One environment: production. GitHub Actions compiles the WASM with a pinned Emscripten, runs the Node renderer against that same `.wasm` artifact to produce the audio file and RMS envelope JSON, builds Astro, deploys to GitHub Pages on a custom domain. No `.wasm`, rendered audio or RMS JSON is ever committed. Source assets — IRs, weights, the DI loop — are. Rollback is a revert and a rebuild.

**Build-time budget assertions.** Two budgets fail the build rather than being stated as intentions: the preset page's 2 kB inline-JS ceiling (AD-16) and the 400 KB first-interactive budget (NFR-2).

**Analytics integration.** GoatCounter, cookieless, custom events. Custom-event support verified; Cloudflare Web Analytics recorded as unverified for custom events rather than rejected.

**i18n.** FR and EN from the first commit. No string literal in a component.

**Audio-thread error model (AD-13).** With `-fno-exceptions`, the flat C interface returns status codes; every failure is resolved at init. `process()` always produces audio — silence at worst, never nothing.

### UX Design Requirements

Extracted from `DESIGN.md`, treated as the UX design contract. Each item is scoped to generate a story with testable acceptance criteria.

UX-DR1: Implement the six-token colour system as CSS custom properties — `--ink #16181B`, `--chalk #E7E8E2`, `--bone #F4F4F0`, `--graphite #767A78`, `--celadon #8FB09A`, `--iris #4A46D9`, `--ember #B24A34`. No colour value is hardcoded in any component. `--iris` is focus rings and keyboard navigation only, never decorative; `--ember` is clipping and destructive confirmation only.

UX-DR2: Self-host all three typefaces as subset `woff2` with `font-display: swap` and preload — Anybody (display), Inter Tight (body), IBM Plex Mono (utility). No request to Google Fonts or any external font host.

UX-DR3: Implement the seven-step type scale as tokens: wordmark 28/1 tracked `0.32em`; module label 11/1.2 tracked `0.24em` uppercase; heading 20/1.3; body 15/1.5; small 13/1.4; readout large 44/1; readout 13/1. Sentence case everywhere except the display face, which is always uppercase.

UX-DR4: Build the Fader component — vertical, 96px travel, 2px hairline in `--graphite`, 20 × 6px flat cap in `--ink`, active fill above the cap in `--celadon`. Drag, scroll wheel, arrow keys, shift for fine, double-click to reset to preset default. Value in Plex Mono below the fader only while dragging. Hit area 40px wide regardless of visual width. Never animated during drag — direct manipulation is 1:1 with the pointer.

UX-DR5: Build the Module card component — `--bone` on `--chalk`, 2px radius, one elevation shadow at `0 1px 2px rgba(22,24,27,0.06)`, module name in Anybody top left, bypass toggle top right. A bypassed module drops to 40% opacity and its cord segment routes straight past it.

UX-DR6: Build the segmented Toggle/selector — no rounded pills, no filled background. The selected segment gets a 2px `--ink` underline.

UX-DR7: Build the Latency badge — top right, always visible, Plex Mono. Under 20 ms `--graphite` and silent; 20–35 ms `--graphite` with a subtle underline opening an explanation on click; over 35 ms `--ember` with the hardware cause named. Never nags, never hides, never blocks.

UX-DR8: Build the Tuner sheet — full-screen over `--chalk`, note name in Anybody at 120px, cents in Plex Mono at 44px, one horizontal hairline shifting left and right of centre. In tune is `--celadon` and holds 400 ms. No strobe, no needle.

UX-DR9: Build the Meters — two segments only, input and output, 4px vertical bars in `--celadon` with an `--ember` cap on clip held for 1.5 s. No peak-hold lines, no printed dB scale.

UX-DR10: Build the cord as a continuous 1px hairline between modules, opacity per segment driven by amplitude at that point. Grey between input and gate when the gate is closed; brighter after the drive; a clipping segment and only that segment turns `--ember`. Under `prefers-reduced-motion` it holds a steady average instead of tracking transients. Two data sources, one identical behaviour: worklet RMS on the play path, build-computed envelope on the listen path.

UX-DR11: Implement the chain layout — signal path left to right across the full viewport width in processing order, vertically centred in roughly the middle third, 8px base grid, 24px gaps filled by the cord. No navigation, no sidebar, no tabs. Below 1100px the chain wraps to two rows with the cord continuing across the break; below 720px it becomes a vertical stack with a notice that playing on a phone is not supported.

UX-DR12: Implement the preset page layout — the chain rendered read-only with the same modules, fader positions and cord, over a single play control. Nothing draggable, nothing pretending to be.

UX-DR13: Implement the motion system — page load fades modules up in signal order, 40 ms apart, 240 ms each, `cubic-bezier(0.2, 0, 0, 1)`, under 600 ms total. Sheets slide up 16px and fade in over 200 ms. No hover animation on controls: hover changes the cursor and lifts the label to `--ink`, nothing more. The cord is the only continuous animation. `prefers-reduced-motion` disables the load sequence entirely.

UX-DR14: Meet the accessibility floor — every control keyboard-reachable and operable with a visible `--iris` focus ring at 2px offset 2px; faders respond to arrow keys and announce their value; every interactive target at least 40px in its smaller dimension; `--graphite` used only at 13px and above and only for non-essential text; `--celadon` never carries information alone, always paired with position or a label.

UX-DR15: Design the empty and failure states rather than defaulting them. "No input device found" is a screen with one instruction and a link to the listen path, not an alert box.

UX-DR16: Enforce the copy rules — amps and presets named for what they sound like, never after real gear; exactly one lowercase three-to-six-word description per preset with no exclamation marks; buttons name the outcome and the confirmation reuses the same word ("Copy tone link" → "Tone link copied"); errors state cause and fix in one sentence each; the words *immersive, powerful, seamless, unleash, unlock* and *craft* as a verb never appear.

### FR Coverage Map

Every one of the 50 functional requirements maps to exactly one epic. None is orphaned.

FR-1: Epic 4 — Preset page at an indexable URL, build-rendered audio
FR-2: Epic 4 — 2 kB inline-JS ceiling, asserted at build time
FR-3: Epic 4 — Under one second to audible on a mid-range phone
FR-4: Epic 4 — Read-only chain over a single play control
FR-5: Epic 4 — Cord animated from the build-computed RMS envelope
FR-6: Epic 4 — Build renders use identical engine settings
FR-7: Epic 1 — Pre-engine detection of browser, device, inputs, rate
FR-8: Epic 1 — getUserMedia with the WebRTC voice pipeline disabled
FR-9: Epic 1 — AudioContext created at the device's exact sample rate
FR-10: Epic 1 — Calibration measures latency, level, bandwidth, label
FR-11: Epic 1 — Degraded input named before the first note
FR-12: Epic 1 — Onboarding never blocks
FR-13: Epic 1 — Guitar-to-USB cable is a first-class input
FR-14: Epic 1 — One AudioWorkletProcessor holds the whole chain
FR-15: Epic 1 — Zero allocation in process()
FR-16: Epic 1 — 4x oversampling on the contiguous non-linear window only
FR-17: Epic 1 — Neural amp fixed at build time, LSTM hidden 20
FR-18: Epic 1 — Output limiter always active, no UI control
FR-19: Epic 1 — AudioParam for continuous, postMessage for discrete
FR-20: Epic 1 — Per-block bypass except the limiter
FR-21: Epic 2 — Single Svelte island on a single route
FR-22: Epic 2 — Vertical linear faders only, no rotary controls
FR-23: Epic 2 — No canvas, no AnalyserNode, no spectrum, no scope
FR-24: Epic 2 — Cord opacity from worklet RMS posted at 30 Hz
FR-25: Epic 2 — Metering suspended while the tab is hidden
FR-26: Epic 2 — Full keyboard operation with visible focus
FR-27: Epic 2 — Product voice and copy rules
FR-28: Epic 2 — Fader reaches audio within one render quantum
FR-29: Epic 3 — One canonical chain-state object, two containers
FR-30: Epic 3 — Tone link in the URL hash
FR-31: Epic 3 — Versioned tone file, download and load
FR-32: Epic 3 — Import validates and never half-applies
FR-33: Epic 3 — localStorage persistence, no account
FR-34: Epic 3 — OfflineAudioContext render for a link without input
FR-35: Epic 1 — Round trip computed and displayed on three tiers
FR-36: Epic 1 — Dropout defined and counted, visible in the UI
FR-37: Epic 1 — Never refuses the play path on performance grounds
FR-38: Epic 1 — Latency jitter instrumented alongside the absolute figure
FR-39: Epic 2 — Chromatic tuner, ±1 cent, behind a discreet icon
FR-40: Epic 2 — Tuner accuracy independent of round-trip latency
FR-41: Epic 5 — FR and EN from day one with correct hreflang
FR-42: Epic 5 — JSON-LD on every content page
FR-43: Epic 5 — Sitemap and OG images generated at build time
FR-44: Epic 5 — The three long-tail guides as launch deliverables
FR-45: Epic 4 — Adding a preset requires no application code
FR-46: Epic 1 — Static hosting only, no server or custom header
FR-47: Epic 5 — Anonymous cookieless events for every §7 metric
FR-48: Epic 5 — No identifier, cookie or fingerprint in any event
FR-49: Epic 5 — Measurement disclosed in one sentence and refusable
FR-50: Epic 5 — Tone file sharing deliberately unmeasured

## Epic List

### Epic 1: Plug in and play, honestly

Someone with a guitar and a way to plug it in opens the URL, grants microphone permission, and hears an excellent high-gain tone in real time — and knows why it sounds and feels the way it does on their hardware. Sound comes out, it does not glitch, the round trip is on screen, and a degraded input is named before the first note rather than blamed on the engine.

Delivers the whole real-time path: the Astro + Svelte scaffold, the parameter schema and its generated C++ header, all seven DSP stages, the single contiguous oversampling window, the AudioWorklet, the WASM build in CI, GitHub Pages deployment, calibration, diagnosis, the latency badge and the dropout counter.

**FRs covered:** FR-7, FR-8, FR-9, FR-10, FR-11, FR-12, FR-13, FR-14, FR-15, FR-16, FR-17, FR-18, FR-19, FR-20, FR-35, FR-36, FR-37, FR-38, FR-46
**NFRs:** NFR-1, NFR-2, NFR-9, NFR-11, NFR-13, NFR-14, NFR-15

### Epic 2: Make the tone yours

The rig becomes something the player operates rather than accepts. Faders that reward being touched, the cord showing the signal travel down the chain, bypass, the tuner behind its discreet icon, and full keyboard operation.

This is where the whole UX design contract lands: the six colour tokens, the three self-hosted typefaces, the type scale, every component, the motion system, the accessibility floor and the copy rules.

**FRs covered:** FR-21, FR-22, FR-23, FR-24, FR-25, FR-26, FR-27, FR-28, FR-39, FR-40
**NFRs:** NFR-4, NFR-6, NFR-7, NFR-8
**UX-DRs:** UX-DR1 through UX-DR16

### Epic 3: Keep it and pass it on

A tone survives the tab closing and travels to someone else. `localStorage` persistence, the tone link, the downloadable tone file, validating import, and the `OfflineAudioContext` render for a recipient with no interface.

This epic is the entire growth loop — the only mechanism in v1 by which one user creates another.

**FRs covered:** FR-29, FR-30, FR-31, FR-32, FR-33, FR-34

### Epic 4: Hear it without a guitar

The listen path, which most visitors will use. The Node renderer driving the same `.wasm` artifact, the preset page with its build-rendered audio and RMS envelope, and the two build-time budget assertions that fail the build rather than stating an intention.

Built after Epic 1 not because it matters less but because it cannot exist first: its audio files are a build artifact of the real-time engine.

**FRs covered:** FR-1, FR-2, FR-3, FR-4, FR-5, FR-6, FR-45
**NFRs:** NFR-3, NFR-5, NFR-10, NFR-12

### Epic 5: Be found

People arrive. French and English with correct `hreflang`, the three long-tail guides that carry the entire launch indexable surface, JSON-LD, sitemap and OG images, and anonymous cookieless measurement that can be refused.

**FRs covered:** FR-41, FR-42, FR-43, FR-44, FR-47, FR-48, FR-49, FR-50
**NFRs:** NFR-16, NFR-17, NFR-18

---

## Epic 1: Plug in and play, honestly

Someone with a guitar and a way to plug it in opens the URL, grants microphone permission, and hears an excellent high-gain tone in real time — and knows why it sounds and feels the way it does on their hardware.

### Story 1.1: A deploy that is a pure function of the commit

As the person maintaining Tonecraft,
I want the deployed site to be derivable entirely from a commit, with nothing binary in the repository,
So that rolling back is a revert and nothing else, and a `.wasm` can never drift from the audio rendered by it.

**Acceptance Criteria:**

**Given** an empty repository
**When** the project is created
**Then** it is scaffolded with `npm create astro@latest` on Astro 7.2.x with the Svelte 5 integration, TypeScript in `strict` mode and Tailwind 4.3.x — the paved path the Architecture binds, not a hand-rolled config
**And** the six top-level directories exist with their dependency direction documented: `schema/` depends on nothing, `dsp/` and `engine/` depend on `schema/`, `app/` depends on `engine/` and `schema/`, `site/` depends on `app/` and `render/` output

**Given** a fresh clone and Node 24 LTS
**When** the documented install and build commands are run
**Then** the site builds with no manual step
**And** `dist/` and every `.wasm`, rendered audio file and RMS JSON are git-ignored

**Given** a push to `main`
**When** GitHub Actions runs
**Then** it builds and deploys to GitHub Pages on the custom domain
**And** the workflow pins Emscripten to an exact version rather than a floating tag

**Given** the repository
**When** its history is inspected
**Then** no build output has ever been committed

### Story 1.2: One source of truth for every parameter

As a developer working on either side of the WASM boundary,
I want every parameter defined once in TypeScript and the C++ header generated from it,
So that a value can never mean one thing in the UI and another in the DSP.

**Acceptance Criteria:**

**Given** `schema/params.ts` declaring a parameter with id, unit, range, default and taper
**When** `schema/generate.ts` runs
**Then** `dsp/params.generated.h` is emitted with matching ids, ranges and defaults
**And** the file carries a header naming its generator

**Given** CI
**When** the generator is re-run
**Then** it produces no diff, and a diff fails the build

**Given** a hand-edited `params.generated.h`
**When** the build runs
**Then** it fails with a message naming the generator to run instead

**Given** a parameter declared in the schema
**When** its unit is inspected
**Then** it is an engineering unit — dB, Hz, ratio or milliseconds — and never a normalised 0..1 position, except for a mix control whose unit genuinely is a ratio

### Story 1.3: Audio survives a round trip through WASM, and cannot deafen anyone

As Léo, a player with a guitar and a USB cable,
I want my signal to travel from input to headphones through the real engine unchanged,
So that the whole pipeline is proven before any DSP exists — and so that no stage of development can ever put an unlimited signal in my ears.

**Acceptance Criteria:**

**Given** the WASM module built with `-O3 -msimd128 -flto -fno-exceptions -fno-rtti`
**When** the build is inspected
**Then** `-mrelaxed-simd` appears nowhere in any build configuration

**Given** a live input and the worklet running a pass-through chain
**When** the player plays
**Then** the signal reaches the output audibly unaltered except for the limiter
**And** the whole chain runs in exactly one `AudioWorkletProcessor` with no other node between input and output

**Given** the limiter
**When** any part of the product is used, in any mode, on any path
**Then** it is active and no UI control exposes, bypasses or disables it

**Given** `process()`
**When** it is reviewed and profiled
**Then** it performs no allocation, no logging, no DOM access and no `await`, and every buffer was pre-allocated at init

**Given** a stage implementation
**When** its signature is inspected
**Then** it is `void process(const float* in, float* out, uint32_t frames)`, mono float32, never in place, with non-aliasing buffers

### Story 1.4: The guitar signal arrives intact

As Léo,
I want the browser to stop treating my guitar as a voice call,
So that my tone is not destroyed before it reaches the amp.

**Acceptance Criteria:**

**Given** a request for microphone access
**When** `getUserMedia` is called
**Then** `echoCancellation`, `noiseSuppression`, `autoGainControl` and `voiceIsolation` are all explicitly `false`, with `channelCount: 1` and `latency: 0`
**And** an automated test asserts each of these flags and fails if any is absent or true

**Given** a selected input device
**When** the `AudioContext` is created
**Then** its sample rate equals `track.getSettings().sampleRate`, read before the context exists
**And** the context is created inside a user gesture handler

**Given** onboarding
**When** it reports what it found
**Then** it names the browser, the device and the sample rate
**And** the player can proceed to play from every state, with nothing blocking

**Given** a guitar-to-USB cable as the input device
**When** it is detected
**Then** it is treated as a supported interface, with no warning or lesser-device framing anywhere

### Story 1.5: The same tone on a 44.1 kHz interface

As Inès, receiving a tone link from Léo whose interface runs at a different rate than mine,
I want the chain to sound identical regardless of my hardware's sample rate,
So that a shared tone is not a different tone.

**Acceptance Criteria:**

**Given** any device sample rate — 44.1, 48 or 96 kHz
**When** audio enters the chain
**Then** it is converted to the fixed internal design rate of 48 kHz at the chain boundary by our own resampler, and converted back on the way out

**Given** any DSP stage
**When** its source is inspected
**Then** it neither reads nor receives the device sample rate, and has no rate parameter

**Given** the same input signal and the same chain state rendered at a 44.1 kHz device rate and at 48 kHz
**When** the two outputs are compared after conversion back
**Then** they match within the tolerance of the resampler, and no stage behaves differently between the two

### Story 1.6: The first real tone

As Léo,
I want to hear the modelled amplifier instead of my dry signal,
So that there is finally a reason to have plugged in.

**Acceptance Criteria:**

**Given** a weights blob laid out as `[u32 magic][u32 version][u32 count][f32 ...]`
**When** the engine initialises
**Then** it loads the blob into RTNeural and reports a named error at init — never during `process()` — if the magic, version or count does not match

**Given** the amp stage
**When** its configuration is inspected
**Then** the LSTM hidden size is a compile-time constant of 20, and nothing at runtime reads a performance measurement to choose it

**Given** the weights
**When** the bundle is inspected
**Then** they are a separate loadable artifact, not embedded in the `.wasm` and not JSON

**Given** a guitar playing through the amp stage
**When** the player listens
**Then** the amplifier character is audible and the stage holds its share of the CPU budget on the floor machine

**Given** a continuous parameter such as amp gain
**When** it travels from the main thread to the worklet
**Then** it arrives as an `AudioParam` value and is smoothed once, by that interpolation, at the worklet boundary
**And** the stage receiving it adds no smoothing of its own

**Given** `postMessage` traffic to and from the worklet
**When** it is inspected
**Then** it carries only discrete changes — preset switch, IR load, weights load — and the metering return, and never a continuous parameter

### Story 1.7: The tone stops sounding cheap

As Léo,
I want the amplifier not to produce the harsh, metallic artefacts of a bad plugin,
So that it holds up against something I would have paid for.

**Acceptance Criteria:**

**Given** the non-linear region of the chain
**When** the signal enters it
**Then** it is upsampled 4x once, processed, and downsampled once — one contiguous window, one upsampler, one downsampler

**Given** the gate, cab, reverb and limiter
**When** the chain is inspected
**Then** none of them is inside the oversampling window

**Given** a stage inside the window
**When** `process()` is called on it
**Then** `frames` is 512; outside the window it is 128

**Given** a swept high-frequency input at high gain
**When** the output spectrum is measured before and after this story
**Then** aliasing products are measurably reduced
**And** the measured round-trip cost of the oversampling chain is under 0.5 ms

### Story 1.8: It sounds like an amp in a room

As Léo,
I want a speaker cabinet between the amplifier and my ears,
So that what I hear is a guitar amp rather than a fizzing buzz.

**Acceptance Criteria:**

**Given** the cab stage
**When** its implementation is inspected
**Then** it is a SIMD direct-form FIR compiled into the WASM, and `ConvolverNode` appears nowhere in the product

**Given** an impulse response
**When** it is loaded
**Then** it is at most 2048 taps, and a longer one is rejected with a named error rather than silently truncated or switched to another algorithm

**Given** the same chain state
**When** it is rendered in Chromium, Firefox and Safari
**Then** the cab output is identical in all three

**Given** the shipped impulse response
**When** its provenance is checked
**Then** it is ours or licensed with redistribution rights, and the provenance is documented in the repository

### Story 1.9: Silence between the notes

As Léo, playing at high gain next to a laptop with a fan,
I want the noise to stop when I stop,
So that the amp is usable in the room I am actually in.

**Acceptance Criteria:**

**Given** the gate at the head of the chain
**When** the input falls below the threshold
**Then** it closes with an automatic release requiring no user tuning

**Given** the gate
**When** the chain is inspected
**Then** it sits before the drive and outside the oversampling window

**Given** any block except the limiter
**When** the player bypasses it
**Then** that block stops processing and its declared meter slot reports the bypassed state

**Given** a stage
**When** its meter slot and bypass parameter are resolved
**Then** they come from stable ids declared in `schema/`, and nothing addresses a stage by its index in the chain

### Story 1.10: The default preset is complete

As Léo,
I want the tone I hear on arrival to be the finished, tuned, shred-and-solo lead it is meant to be,
So that most people can leave every fader alone and still get the point.

**Acceptance Criteria:**

**Given** the drive stage
**When** the chain is inspected
**Then** it sits immediately before the amp, inside the same single oversampling window, adding no second resampling chain

**Given** the reverb stage
**When** the chain is inspected
**Then** it sits after the cab, outside the oversampling window

**Given** a cold load with no stored tone
**When** audio starts
**Then** the default preset is already loaded and sounding, with long sustain and audible ambience, and requires no interaction to be heard

**Given** the whole chain running the default preset on the floor machine
**When** CPU is measured
**Then** it holds under 25% of one core
**And** the first-interactive payload including the amp weights, the IR and the drive is under 400 KB

### Story 1.11: The number is on the screen

As Léo,
I want to know my real round trip without asking,
So that if it feels late I know whether that is the product or my hardware.

**Acceptance Criteria:**

**Given** an active audio context
**When** the round trip is computed
**Then** it is `baseLatency + outputLatency`, displayed permanently and logged

**Given** a round trip under 20 ms
**When** the badge renders
**Then** it shows the figure and says nothing further

**Given** a round trip between 20 and 35 ms
**When** the player clicks the figure
**Then** an explanation opens

**Given** a round trip over 35 ms
**When** the badge renders
**Then** it names the likely hardware cause in one sentence and the remedy in one sentence
**And** in every tier the player can continue playing, with nothing blocked

### Story 1.12: Honest when it glitches, and never a refusal

As Léo on a machine that may not keep up,
I want to be told plainly when audio is breaking up and why,
So that I can decide what to do instead of concluding the product is bad.

**Acceptance Criteria:**

**Given** the worklet
**When** a `process()` call misses its render deadline
**Then** it is counted as a dropout by the worklet, which is the only detector — the main thread never infers one from an observed gap

**Given** an active session
**When** dropouts occur
**Then** the running count is visible in the UI, and the product names the likely cause and offers the listen path as an alternative

**Given** any machine, however slow
**When** the play path is requested
**Then** it loads and runs — there is no CPU benchmark gate, no engine-load refusal and no redirect

**Given** a session
**When** latency is sampled over time
**Then** its jitter is instrumented alongside the absolute figure

### Story 1.13: Told before the first note, not after

As Léo, who has just run a guitar jack into the laptop's microphone input,
I want to be told that is the problem while I am still setting up,
So that I do not spend ten minutes concluding that Tonecraft sounds thin.

**Acceptance Criteria:**

**Given** calibration
**When** it runs
**Then** it measures round-trip latency, input level and input bandwidth, and reads the device label

**Given** a signature of a degraded input — an onboard microphone input by device label, a low level with rolled-off treble, or a round trip over 35 ms
**When** calibration completes
**Then** the cause is stated in one sentence and the remedy in one sentence, during onboarding, before any note has been played

**Given** any diagnosis, however severe
**When** it is shown
**Then** it is informational only and the player can proceed to play

**Given** a healthy interface
**When** calibration completes
**Then** nothing is said about hardware at all

**Given** a cold load on a mid-range laptop with a working interface
**When** the player goes from opening the URL to hearing their first note, including granting microphone permission
**Then** the median elapsed time is under 8 seconds
**And** that duration is instrumented so regressions are visible rather than discovered

---

## Epic 2: Make the tone yours

The rig becomes something the player operates rather than accepts, and the whole UX design contract lands.

### Story 2.1: The design system exists before anything uses it

As a developer building any surface of Tonecraft,
I want the colour, type and spacing decisions to exist as tokens,
So that no component ever hardcodes a value and the product cannot drift into looking like something else.

**Acceptance Criteria:**

**Given** the stylesheet
**When** it is inspected
**Then** all six colour tokens are defined as CSS custom properties, and no colour literal appears in any component
**And** `--iris` is used only for focus rings and keyboard navigation, `--ember` only for clipping and destructive confirmation

**Given** the three typefaces
**When** the network panel is inspected on any page
**Then** Anybody, Inter Tight and IBM Plex Mono load as subset self-hosted `woff2` with `font-display: swap` and preload
**And** no request is made to Google Fonts or any external font host

**Given** the type scale
**When** a text element is rendered
**Then** its size and line height come from one of the seven declared steps
**And** the display face is always uppercase; everything else is sentence case

### Story 2.2: The page is the rig

As Léo,
I want the signal path laid out left to right in the order the audio travels,
So that I can see what my sound goes through without reading anything.

**Acceptance Criteria:**

**Given** the application
**When** it loads
**Then** it is a single Svelte island on a single route, `client:only`, and every content page ships no application JavaScript

**Given** a desktop viewport
**When** the rig renders
**Then** the chain runs left to right in processing order, vertically centred in roughly the middle third, on an 8px grid with 24px gaps
**And** there is no navigation, no sidebar and no tabs

**Given** a viewport under 1100px
**When** the rig renders
**Then** the chain wraps to two rows in order with the cord continuing across the break

**Given** a viewport under 720px
**When** the rig renders
**Then** the chain becomes a vertical stack and a notice states plainly that playing through the browser on a phone is not supported

### Story 2.3: A fader that rewards being touched

As Léo,
I want to move a control and hear the change immediately, by whatever input I happen to be using,
So that shaping the tone feels like an instrument rather than a form.

**Acceptance Criteria:**

**Given** a fader
**When** it renders
**Then** it is vertical with 96px travel, a 2px `--graphite` hairline, a 20 × 6px flat `--ink` cap and `--celadon` fill above the cap
**And** there is no rotary control anywhere in the product

**Given** a fader
**When** the player drags, scrolls, presses an arrow key, holds shift, or double-clicks
**Then** those produce respectively a drag, a step, a step, fine adjustment, and a reset to the preset default

**Given** a fader being dragged
**When** the pointer moves
**Then** the cap tracks it 1:1 with no animation, and the value appears in Plex Mono below the fader for the duration of the drag only

**Given** any fader
**When** its hit area is measured
**Then** it is at least 40px wide regardless of visual width

**Given** a fader move
**When** the audio is measured
**Then** the change reaches the output within one render quantum with no zipper noise, and appears in the cord on the next metering frame

### Story 2.4: Modules you can see and switch off

As Léo,
I want each block of the chain to be a distinct object I can turn off,
So that I can hear what each one is actually doing to my sound.

**Acceptance Criteria:**

**Given** a module card
**When** it renders
**Then** it is `--bone` on `--chalk` with a 2px radius and one elevation shadow, its name in Anybody top left and its bypass toggle top right

**Given** a bypassed module
**When** it renders
**Then** it drops to 40% opacity and its segment of the cord routes straight past it

**Given** a segmented selector
**When** a segment is selected
**Then** it gains a 2px `--ink` underline, with no filled background and no rounded pill

### Story 2.5: Watch the note travel down the chain

As Léo, who has never thought about gain staging,
I want to see my pick attack move from input to output,
So that when no sound reaches the amp I can see it rather than guess.

**Acceptance Criteria:**

**Given** the rig
**When** it renders
**Then** the modules are joined by a continuous 1px hairline whose per-segment opacity tracks the amplitude at that point

**Given** audio running
**When** the worklet posts metering
**Then** per-stage RMS arrives in a pre-allocated `Float32Array` at 30 Hz, read in a `requestAnimationFrame` loop that writes CSS custom properties

**Given** a clipping stage
**When** the cord renders
**Then** that segment and only that segment turns `--ember`

**Given** a closed gate
**When** the cord renders
**Then** the segment between input and gate is grey

**Given** the tab is hidden
**When** metering is checked
**Then** it is suspended

**Given** the whole product
**When** it is searched
**Then** there is no `<canvas>` and no `AnalyserNode` anywhere: no spectrum analyser and no oscilloscope

**Given** `prefers-reduced-motion`
**When** the cord renders
**Then** it holds a steady average instead of tracking transients

### Story 2.6: Levels and latency, as designed objects

As Léo,
I want the input and output levels and my round trip to sit quietly on screen,
So that I can glance at them without being nagged.

**Acceptance Criteria:**

**Given** the meters
**When** they render
**Then** there are exactly two, input and output, as 4px vertical `--celadon` bars, with an `--ember` cap on clip held for 1.5 s, no peak-hold line and no printed dB scale

**Given** the latency badge
**When** it renders
**Then** it sits top right in Plex Mono, `--graphite` and silent under 20 ms, `--graphite` with a subtle underline opening an explanation between 20 and 35 ms, and `--ember` naming the hardware cause above 35 ms

**Given** any figure that updates at 30 fps
**When** it renders
**Then** it uses tabular figures so the digits do not jitter

### Story 2.7: Tune before you play

As Léo, whose guitar has not been tuned in days,
I want an accurate tuner one click away,
So that the first thing I hear through a high-gain amp is not an out-of-tune guitar.

**Acceptance Criteria:**

**Given** the rig
**When** the player looks for the tuner
**Then** it is a discreet icon, not a panel element, and opens as a full-screen sheet over `--chalk`

**Given** the tuner sheet
**When** it renders
**Then** the note name is Anybody at 120px, the cents deviation Plex Mono at 44px, and a single horizontal hairline shifts left and right of centre — no strobe and no needle

**Given** a note in tune
**When** it registers
**Then** the indication turns `--celadon` and holds for 400 ms

**Given** a round trip of 40 ms
**When** the tuner reads pitch
**Then** its accuracy is within ±1 cent from the low E of a 6-string upward, because pitch is detected on the input before the chain — only when the reading appears is shifted, never what it reads

### Story 2.8: Motion that teaches, then gets out of the way

As Léo arriving for the first time,
I want the interface to show me the direction the signal travels,
So that I understand the layout without reading a word of copy.

**Acceptance Criteria:**

**Given** a page load
**When** the rig appears
**Then** modules fade up in signal order 40 ms apart, 240 ms each, on `cubic-bezier(0.2, 0, 0, 1)`, completing under 600 ms

**Given** a sheet
**When** it opens
**Then** it slides up 16px and fades in over 200 ms

**Given** a control
**When** the pointer hovers it
**Then** the cursor changes and the label lifts to `--ink`, with no other animation

**Given** `prefers-reduced-motion`
**When** the page loads
**Then** the load sequence is disabled entirely and the cord holds steady

**Given** any animation in the product
**When** its properties are inspected
**Then** it animates only `transform` and `opacity` — never `backdrop-filter`, `filter: blur()` or `box-shadow`

### Story 2.9: Operable without a mouse, legible without colour vision

As a player using a keyboard, or one who cannot distinguish red from green,
I want every control reachable and every state readable,
So that the product works for me at all.

**Acceptance Criteria:**

**Given** any interactive control
**When** it is reached by keyboard
**Then** it shows a visible `--iris` focus ring at 2px, offset 2px, and it can be operated from the keyboard

**Given** a fader with focus
**When** an arrow key is pressed
**Then** its value changes and the new value is announced to assistive technology

**Given** any interactive target
**When** measured
**Then** it is at least 40px in its smaller dimension

**Given** the cord and every other use of `--celadon`
**When** colour is removed
**Then** the same information is still available from position or a label

**Given** any component
**When** it is profiled
**Then** it holds 30 fps, and the main thread never blocks for more than 8 ms

### Story 2.10: It says what happened, in its own voice

As Léo when something goes wrong,
I want to be told the cause and the fix rather than apologised to,
So that I can get back to playing.

**Acceptance Criteria:**

**Given** any error surface
**When** it renders
**Then** it states the cause in one sentence and the fix in one sentence, with no apology

**Given** the state where no input device is found
**When** it renders
**Then** it is a designed screen with one instruction and a link to the listen path, not a browser alert

**Given** any button and its confirmation
**When** both are read
**Then** the button names the outcome and the confirmation reuses the same word

**Given** any amp or preset name in the product
**When** it is read
**Then** it describes what it sounds like and names no real gear, artist or existing plugin, and each preset carries exactly one lowercase description of three to six words with no exclamation mark

**Given** all user-facing copy
**When** it is searched
**Then** the words *immersive*, *powerful*, *seamless*, *unleash*, *unlock* and *craft* as a verb do not appear

---

## Epic 3: Keep it and pass it on

A tone survives the tab closing and travels to someone else. This epic is the entire growth loop.

### Story 3.1: One object, and the promise that it never breaks

As Léo sharing a tone today that someone may open in four years,
I want the state of my chain captured in a form that cannot change meaning,
So that what they hear is what I heard.

**Acceptance Criteria:**

**Given** the chain in any state
**When** it is serialised
**Then** it produces one canonical object carrying engineering units — dB, Hz, ratio, milliseconds — and never normalised fader positions

**Given** that object
**When** it is inspected
**Then** it includes `schemaVersion`, `ampId` and `weightsVersion`

**Given** a taper curve
**When** the wire format is inspected
**Then** the taper appears nowhere in it — it is owned by the UI alone

**Given** the parameter schema
**When** a change is proposed
**Then** parameters may be added, and a test fails if any existing parameter is removed, renamed, reordered in the wire format, or changed in meaning or unit

**Given** every weights version ever shipped
**When** an old link requests one
**Then** it is still served at its stable URL

### Story 3.2: Send it as a link

As Léo who has just got the tone right,
I want to hand it to someone as a URL,
So that sharing costs nothing and needs no account.

**Acceptance Criteria:**

**Given** the current chain state
**When** the player copies the tone link
**Then** the state is encoded into the URL hash as base64url of the packed binary layout, with no server, no shortener and nothing stored anywhere

**Given** a tone link
**When** it is opened
**Then** the chain reproduces exactly the state it encodes, parameter for parameter

**Given** the copy action
**When** it succeeds
**Then** the confirmation reuses the button's own word

### Story 3.3: It survives closing the tab

As Léo who has to stop playing and come back tomorrow,
I want my tone still there when I return,
So that I do not rebuild it every session.

**Acceptance Criteria:**

**Given** a tone the player saves
**When** the tab is closed and reopened
**Then** the tone is restored from `localStorage`

**Given** saving, loading and sharing
**When** any of them is used
**Then** none requires an account, a sign-up or any server request

**Given** `localStorage` unavailable or full
**When** a save is attempted
**Then** the cause and the fix are stated in one sentence each and the current tone is unaffected

### Story 3.4: Send it as a file

As Léo who wants to keep a collection of tones or attach one to a message,
I want to download my tone as a file,
So that it is mine outside the browser.

**Acceptance Criteria:**

**Given** the current chain state
**When** the player downloads it
**Then** a JSON file is produced whose field names match the schema, including `schemaVersion`, `ampId` and `weightsVersion`

**Given** the same chain state
**When** it is exported as a link and as a file and both are decoded
**Then** they yield identical values — one encoder, no approximation and no lossy path

### Story 3.5: An import that never half-applies

As Léo loading a file of unknown origin,
I want a bad file to change nothing,
So that I never lose the tone I already had.

**Acceptance Criteria:**

**Given** a file with an unknown `schemaVersion`, a missing field or an out-of-range value
**When** it is imported
**Then** a named error states the cause and the fix, and the current tone is untouched

**Given** a valid file
**When** it is imported
**Then** every parameter is applied together, and no state exists in which some parameters have been applied and others have not

**Given** a file referencing a `weightsVersion` that is still served
**When** it is imported
**Then** those weights are loaded rather than the current default

### Story 3.6: A link that works for someone with no interface

As Inès who received Léo's link and has no guitar and no interface,
I want to hear his tone anyway,
So that the link is not a dead end.

**Acceptance Criteria:**

**Given** a custom tone link opened with no usable input device
**When** the page loads
**Then** the engine downloads and renders the fixed DI loop through the encoded chain via `OfflineAudioContext`, and plays the resulting buffer

**Given** that render
**When** it runs
**Then** it uses the same stages and the same settings as the real-time path, with no live input and no dropout risk

**Given** the wait
**When** the render begins
**Then** the page says plainly that it is slow to open and why

---

## Epic 4: Hear it without a guitar

The listen path, which most visitors will use. It is built after Epic 1 because its audio files are a build artifact of the real-time engine.

**Prerequisite asset, not software:** this epic cannot start until the DI loop exists — roughly 20 seconds of unprocessed electric guitar DI, a lead line recorded in-house, which the chain then turns into the high-gain lead tone. It is the single most important audio asset in the product, because with one preset it is what most visitors will judge the tone by. Story 3.6 depends on the same recording.

### Story 4.1: The build renders through the real engine

As the person maintaining Tonecraft,
I want the build to produce its audio using the identical artifact the browser runs,
So that the demo cannot sound better than what a player gets after plugging in.

**Acceptance Criteria:**

**Given** the build
**When** the renderer runs in Node
**Then** it loads the same `.wasm` file the browser loads — not a native build, not a second implementation

**Given** the renderer
**When** its configuration is inspected
**Then** there is no separate offline quality setting: the oversampling factor, model size and filter orders are the compile-time constants of the shipped engine

**Given** the DI loop as a source asset
**When** it is inspected
**Then** it is an unprocessed **electric** guitar DI of roughly 20 seconds — a lead line, pickups straight in, no amp and no effects of any kind in the recording — captured in-house through a guitar-to-USB cable at the 48 kHz internal design rate, committed to `assets/` with its provenance documented
**And** it is never synthesised and never of unknown origin

**Given** the rendered result
**When** it is heard
**Then** the high gain and the reverb come entirely from the chain, never from the source recording — the DI is what the engine has to transform, and a DI that already sounds processed would hide what the engine does

**Given** that one recording
**When** its uses are traced
**Then** the same file serves both the build-time preset renders and the runtime `OfflineAudioContext` fallback of Story 3.6, so the two can never diverge

**Given** the DI loop
**When** it is rendered through the default preset
**Then** an audio file is produced

### Story 4.2: The cord's movement is computed once, at build

As Inès on a phone,
I want the cord to move with the sound,
So that I see the same product a player sees.

**Acceptance Criteria:**

**Given** the build render
**When** it completes
**Then** it emits a per-stage RMS envelope as JSON alongside the audio file

**Given** that JSON
**When** its size is checked
**Then** it is small enough to ship on a preset page without affecting time to audible

**Given** the envelope and the audio
**When** they are compared
**Then** their timelines align, so a segment brightens when the sound at that stage does

### Story 4.3: A page that plays the tone in a second

As Inès arriving from a search or a shared link,
I want to hear the tone almost immediately, on my phone, with no permission prompt,
So that I understand what this is without doing anything.

**Acceptance Criteria:**

**Given** a preset
**When** it is published
**Then** it has an indexable URL at `/presets/<slug>` serving the build-rendered audio file

**Given** the page
**When** it renders
**Then** it shows the chain read-only with the same modules, fader positions and cord as the rig, over a single play control
**And** nothing on it is draggable and nothing appears to be

**Given** any browser on any device including a phone
**When** the page is opened
**Then** it works, with no WASM, no `AudioContext`, no microphone permission and no engine of any kind

### Story 4.4: Two kilobytes, enforced by the build

As the person maintaining Tonecraft,
I want the preset page's JavaScript ceiling to be a build failure rather than an intention,
So that the engine can never reach that page through a shared import.

**Acceptance Criteria:**

**Given** the preset page bundle
**When** the build measures it
**Then** it contains at most 2 kB of inline vanilla JavaScript — a play control and the cord animation — and the build fails above that

**Given** the page's imports
**When** they are traced
**Then** nothing is imported from `engine/` or `app/`, and no framework or hydration runtime is present

**Given** the cord on the page
**When** the audio plays
**Then** it animates from the RMS envelope driven by `audio.currentTime`, and its behaviour is visually identical to the play path

**Given** the page
**When** Core Web Vitals are measured
**Then** it scores 100/100

### Story 4.5: Audible in under a second on a phone on 4G

As Inès on a mobile connection,
I want the sound to start almost at once,
So that I do not leave before hearing anything.

**Acceptance Criteria:**

**Given** a mid-range phone on 4G
**When** the preset page is opened and play is pressed
**Then** audio is audible in under one second

**Given** the audio asset
**When** its format and size are inspected
**Then** the encoding is chosen for fast first-audio at an acceptable size, and the page preloads it appropriately

**Given** the whole listen path
**When** its bandwidth cost per listen is calculated
**Then** it is documented against the roughly 100 GB/month GitHub Pages ceiling

### Story 4.6: A new preset costs no code

As the person adding presets over time,
I want a preset to be data,
So that the catalogue can grow as an editorial activity rather than a release.

**Acceptance Criteria:**

**Given** a new set of parameter values and a name with its one-line description
**When** the build runs
**Then** a rendered audio file, an RMS envelope and an indexable page are produced, with no change to application code

**Given** the preset page template
**When** a second preset is added
**Then** nothing about the first page changes

### Story 4.7: The phone is told the truth

As Inès on a phone who might wonder whether she can plug a guitar in,
I want to be told plainly that playing is not supported here while listening is,
So that I am not left trying.

**Acceptance Criteria:**

**Given** a mobile device
**When** the application route is opened
**Then** it states plainly that playing through the browser on a phone is not supported and points to the listen path

**Given** the same URL on the same phone
**When** the listen path is used
**Then** it is fully functional with nothing degraded

---

## Epic 5: Be found

People arrive, in both languages, and the product measures itself without learning anything about anyone.

### Story 5.1: Two languages from the first commit

As a French or English speaker,
I want the product in my language with the right page indexed,
So that I find it and understand it.

**Acceptance Criteria:**

**Given** any page
**When** it is served
**Then** it exists in French and English with correct `hreflang` linking the pair

**Given** any component
**When** it is inspected
**Then** it contains no user-facing string literal — every string comes from the translation layer

**Given** either language
**When** the product is used end to end
**Then** no untranslated string appears

### Story 5.2: The guides carry the launch

As someone searching for how to play guitar on a computer without an audio interface,
I want a page that actually answers that,
So that I find Tonecraft by looking for my problem rather than its name.

**Acceptance Criteria:**

**Given** launch
**When** the indexable surface is listed
**Then** the three long-tail guides are published in both languages: playing guitar on a PC with no audio interface, reducing latency without ASIO, and a free guitar amp in the browser

**Given** any guide
**When** it is loaded
**Then** it ships no application JavaScript

**Given** each guide
**When** it is read
**Then** it answers its question on its own terms and links to the listen path rather than requiring the reader to install or grant anything

### Story 5.3: Machine-readable, and shareable as an image

As a search engine or a chat client encountering a Tonecraft URL,
I want structured data and an image,
So that the link presents itself correctly wherever it lands.

**Acceptance Criteria:**

**Given** the home page, the FAQ and each guide
**When** their markup is inspected
**Then** they carry `SoftwareApplication`, `FAQPage` and `HowTo` JSON-LD respectively, and each validates

**Given** the build
**When** it completes
**Then** a sitemap and per-page Open Graph images have been generated

**Given** any generated OG image
**When** it is viewed
**Then** it uses the product's own tokens and typefaces and names no real gear, artist or plugin

### Story 5.4: It measures itself without learning anything about anyone

As someone who does not want to be tracked,
I want the product to count what it needs and nothing else,
So that using it costs me no privacy.

**Acceptance Criteria:**

**Given** a play session
**When** events are emitted
**Then** they cover session start with device class and measured round trip, dropout count, latency jitter, time to first audible note, session length, fader touched, tone link created and tone link opened

**Given** any emitted event
**When** its payload is inspected
**Then** it carries no identifier, no cookie and no fingerprint, and nothing that could link two sessions to one person

**Given** measurement
**When** the player first encounters it
**Then** it is disclosed in one plain sentence and can be refused, and refusing changes nothing about how the product behaves

**Given** a downloaded tone file
**When** it is shared
**Then** nothing measures where it goes — the channel is deliberately unmeasured rather than tracked

### Story 5.5: Nothing in the product borrows anyone's name

As the person responsible for Tonecraft not receiving a letter,
I want every name, image and asset to be ours,
So that the product's identity is defensible.

**Acceptance Criteria:**

**Given** the product, its marketing and the repository
**When** they are searched
**Then** no artist, real amplifier, pedal or existing plugin is named, depicted or alluded to in trade dress

**Given** every shipped impulse response
**When** its provenance is checked
**Then** it is ours or licensed with redistribution rights, and the provenance is recorded in the repository

**Given** every shipped font, model and audio asset
**When** its licence is checked
**Then** it permits redistribution in this product
