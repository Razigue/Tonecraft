# Tonecraft — brainstorming intent

Source: `.memlog.md`, 83 entries, session of 2026-08-26. Techniques run: Constraint Mapping, TRIZ Contradiction, Assumption Reversal, Job to Be Done. Converged with MoSCoW.

This document is the input for `bmad-product-brief` and the PRD. It records what was decided, not what was discussed.

---

## 1. The reframe

**Everything starts from listening.**

The DSP engine is not the product. It is the renderer that makes the product. It runs at build time to produce what the majority will hear, and in real time for the minority who plug a guitar in.

This inverts the original framing. Tonecraft was specified as "a low-latency amp simulator in the browser". It is now **the shortest path between a guitar sound and an ear**. Playing is one mode, and it is not the most frequent one.

**Positioning line (replaces "Plug in, open a tab, play"):**

> Branche ta guitare ou juste écoute, ça sonne dans l'onglet.
> Plug in, or listen first. It plays in the tab.

One word is still open: *juste* / *just* demotes listening to a consolation prize, which contradicts the decision that made it the primary path. Alternatives on the table: "Branche ta guitare. Ou écoute d'abord." and "Ça sonne dans l'onglet, avec ou sans guitare."

---

## 2. Architecture consequence: two disjoint load paths

The single most structural outcome of the session.

| Path | Mechanism | Cost |
|---|---|---|
| **Listen** — factory preset | Audio file rendered at build time | 0 kB JS, no WASM, no `AudioContext`, no mic permission. Instant, every device including phones. |
| **Play** — guitar + interface | Full engine, real time | Default-preset assets only at startup, everything else lazy-loaded on demand. |
| **Listen** — custom tone link, no interface | Engine downloaded, rendered through `OfflineAudioContext`, resulting buffer played back | Slow to open, explicitly accepted. Works everywhere. |

Three ideas turned out to be one: pre-rendered demo, preset SEO pages, and offline rendering of custom links are the same mechanism — *render offline, play back a buffer*. Only the trigger moment differs (build, build, runtime).

**Build order:** the play path is built first, because the pre-rendered files of the listen path are a build artifact of the real-time engine. This is a dependency, not a priority.

---

## 3. Job to be done

**Scene A, the one v1 is built for.** The player has had the guitar in hand for ten minutes, working on a part dry, and is tired of hearing bare wood.

The competitor is not Neural DSP. It is the small combo in the corner of the room, the amp app on the phone, and above all the decision to put the guitar down. The reference point is the sound of the unplugged guitar.

**Consequence on the success criterion:** not "it sounds like a paid plugin" in general, but *better than dry, and fast enough not to lose the thread of what I was practising*. The quality bar stays high; it applies to **one** tone, not a catalogue.

**Consequence on time to first note:** the sub-8-second target finally has a justification. It is not a vanity metric — it is the threshold beyond which setup breaks the practice loop.

**Entry hardware, widened.** A guitar plus either an audio interface or a cable into the built-in sound card. A guitar-to-USB cable (Guitar Link type, 20-30 EUR) *is* a class-compliant interface and is fully supported.

---

## 4. Hard rules discovered

These are non-negotiable outcomes, each with its reason.

**The default preset is fixed. Quality never adapts to the machine.** Model complexity is chosen at build time for the floor machine, never at runtime from measured headroom. Reason: a deterministic render is the precondition for a shared tone to sound the same for the other person. Adaptive quality would make the tone link lie, and the tone link is the growth loop. Consequence: LSTM hidden size 20, not 40; fast machines keep unused headroom; and since no graceful degradation is possible, an honest refusal path is required for a machine that cannot hold the budget.

**Pre-rendered files use exactly the same engine settings as the real-time path.** Offline rendering has no CPU budget at all — 16x oversampling and a much larger model would be free and tempting. That would make the demo sound better than what a player gets after plugging in. Deliberately unused headroom, for the same reason the tone link must be deterministic.

**Meters and the cord never use `SharedArrayBuffer`.** Per-stage RMS is computed inside the single worklet, written into a pre-allocated `Float32Array`, and posted at 30 Hz. 30 messages per second is negligible. No COOP/COEP, no `coi-serviceworker`, no cross-origin isolation anywhere.

**Oversampling is spatial, not global.** 4x around the non-linear window only — waveshaper and neural model. Never around EQ, reverb, gate or compressor. Measured cost: roughly 0.3 ms round trip for a linear-phase half-band chain, and about 5x CPU on that stage alone. Latency is not the price. Dropouts are.

**CPU budget is not a comfort target, it is the dropout budget.** In an AudioWorklet the quantum is fixed at 128 frames; there is no buffer setting to trade latency against CPU. Exceeding the budget does not produce more latency, it produces a glitch — the metric that kills the product.

**Never block on bad input hardware, never let the user blame the DSP.** A passive pickup wants a 500 kΩ-1 MΩ load; a laptop mic input offers a few kΩ and injects bias voltage. Result: weak level, lost treble, thin tone — plus 40 ms and up on onboard audio. The user cannot tell an impedance problem from a bad engine. It is detectable at calibration (device label, measured latency, input level, bandwidth). State cause and remedy in one sentence each; never prevent access.

---

## 5. Latency, restated

Latency is secondary. The target is not studio real time — recording is explicitly out of scope. The target is *low enough that the delay is not felt while playing*.

Grounding: sound travels 34 cm per millisecond, so a player standing 3 m from a real amp already plays at ~9 ms. Perception at play starts around 10-12 ms, 20 ms remains comfortable, it breaks around 30. The original < 15 ms target was a studio figure imported without being re-derived.

**Three tiers, replacing both the 25 ms and 30 ms thresholds:**

| Measured round trip | Behaviour |
|---|---|
| < 20 ms | Nothing is said. |
| 20-35 ms | Number displayed, click opens the explanation. Playable. |
| > 35 ms | Honest message about the hardware cause. **Never blocking.** |

**The real failure criterion is dropout rate, not milliseconds.** A constant 20 ms delay is forgotten within a minute; a delay that varies or crackles is unplayable forever.

**One floor remains.** In scene A the player hears the acoustic sound of the strings at the same time as the headphones. Past ~20 ms this produces an audible slapback between the two sources — an effect absent in a studio. Marginal on an unamplified electric, but real.

**Browser support is promoted.** Firefox was "degraded" and Safari "best effort" on latency grounds alone. With latency secondary, both become first class.

---

## 6. Business

**v1 is a free MVP, open to everyone, with no accounts.** Tonecraft Plus, synced presets and the 4 EUR/month tier leave the v1 scope and become an undated hypothesis, not a v1.1 plan.

Preset persistence does not disappear with accounts: `localStorage` for saved tones, tone link for sharing. Zero server, zero sign-up. "No user save in v1 without account" was a self-inflicted limit tied to a monetisation that is being dropped.

**First real ceiling on zero infra cost:** bandwidth. Twelve presets at mono Opus 96 kbps over 20 s is about 2.9 MB in the repository, and GitHub Pages soft-limits at 100 GB/month — roughly 400k demo listens before it has to move. A problem worth having, but the first number where the constraint has an actual roof.

---

## 7. Contradiction verdicts

Eight contradictions were found across `CLAUDE.md`, `PRODUCT.md` and `DESIGN.md`. All eight are settled.

| # | Conflict | Verdict |
|---|---|---|
| 1 | Cord and meters on `SharedArrayBuffer` vs. COOP/COEP banned | Dissolved. Per-stage RMS via `postMessage` at 30 Hz. |
| 2 | Tonecraft Plus vs. no server, ever | Dissolved by scope. No accounts in v1. |
| 3 | Thin-arc knobs vs. vertical faders | `DESIGN.md` wins. Vertical faders everywhere, zero round knobs. |
| 4 | Warm cream background vs. cool grey-green | `DESIGN.md` wins. `--chalk #E7E8E2`. |
| 5 | Single canvas for spectrum and scope vs. no canvas | Removed from both sides. No canvas, no `AnalyserNode`, no spectrum, no oscilloscope in v1. The cord carries all visualisation. |
| 6 | No engine load on mobile vs. demo mode works on a phone | Dissolved. The pre-rendered demo loads no engine. |
| 7 | 25 ms vs. 30 ms failure threshold | Both obsolete. Three-tier frame above; dropouts become the real criterion. |
| 8 | "Sounds like a paid plugin" vs. scene A's bar | Quality level kept, applied to one tone rather than a catalogue. Width is cut, never depth. |

**Documents to rewrite:** `CLAUDE.md` §1 §3 §4 §5 §6 §7 — `PRODUCT.md` §1 §3 §4 §5 §6 §8 §9 — `DESIGN.md` §4 §5 §6.

---

## 8. v1 scope (MoSCoW, validated)

**MUST**

- Single AudioWorklet processor, WASM SIMD, 4x oversampling on the non-linear window only
- One amp, one cab IR, noise gate at chain start, non-disableable output limiter
- Tuner, metronome
- Onboarding: device detection, calibration, onboard-input diagnosis
- Latency permanently displayed
- Listen path: build-time pre-rendered preset pages, 0 kB JS
- Tone link, `localStorage` persistence
- FR/EN from day one
- **The cord**

**SHOULD**

- Amps 2 and 3, the three drives, compressor, reverb — all lazy-loaded
- The 12 factory presets and their SEO pages
- `OfflineAudioContext` for custom links opened without an interface

**COULD**

- Full preset browser, generated OG images, dark mode

**WON'T (v1)**

Accounts · Plus · sync · delay · recording and export · user IR upload · chain reordering · playable mobile · `SharedArrayBuffer` · `coi-serviceworker` · spectrum · oscilloscope

**Why the cord is a MUST**, against the JTBD cut that would have demoted it: it is the only element strictly identical on both load paths. Without it there are two sites sharing a name. With it, someone who listens to a preset page and then plugs in sees the same thing move.

---

## 9. Open questions carried forward

- The exact positioning line, once *juste* / *just* is resolved, in both languages.
- What the single v1 amp is, given that the default preset is the product.
- SEO surface: `CLAUDE.md` §6 wants one URL per modelled amp and pedal, which one amp collapses. Proposed resolution: the surface comes from the 12 preset pages, and each amp added after v1 becomes a page — an editorial cadence rather than a launch prerequisite.
- The honest refusal path for a machine that cannot hold the CPU budget, since no graceful degradation is possible.
