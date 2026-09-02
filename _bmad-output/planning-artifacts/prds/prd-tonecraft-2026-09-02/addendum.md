# Tonecraft PRD — addendum

Depth that belongs downstream (architecture, DSP design, UX spec) rather than in the PRD's narrative.

---

## A. Why promoting Drive to Must is affordable

Drive and Amp are **adjacent** in the chain. The 4x oversampling window is therefore one contiguous region: upsample once before the waveshaper, downsample once after the neural model. The drive contributes only its waveshaper cost, not a second polyphase resampling chain.

Had the chain been `Drive -> Reverb -> Amp`, the same promotion would have required two separate windows — two upsamplers, two downsamplers, roughly double the resampling cost — or oversampling the reverb, which is pure waste since it does not alias.

**This is the concrete payoff of the "oversampling is spatial, not global" rule.** It is also a constraint on any future chain reordering: reordering must not separate two non-linear blocks.

## B. CPU budget after the promotions

Rough figures at 48 kHz, 128-frame quantum (2.667 ms wall clock per quantum; 25% of a core = ~0.67 ms of CPU per quantum), on a 2019-2020 mid-range laptop:

| Stage | Estimate | Note |
|---|---|---|
| Neural amp, LSTM hidden 20, at 4x | 10-18% of a core | Dominant line item. ~2000 MAC/sample at 48 kHz becomes ~384 MMAC/s at 4x. |
| Polyphase half-band chain, up + down | included above | Paid once for the whole non-linear window. |
| Drive waveshaper, at 4x | +2-3% | Cheap because it shares the window. |
| Reverb, at 1x | ~2% | Small FDN or short convolution. Never oversampled. |
| Gate, limiter, per-stage RMS | 1-2% | RMS is free — the samples are already in registers. |
| **Total** | **15-25%** | Against a 25% budget. |

**There is essentially no headroom left.** Any further Must promotion has to displace something. This is why the compressor stays Should and why the metronome went to v1.1.

Latency cost of the oversampling chain: roughly **0.3 ms round trip** for linear-phase half-band filters. Negligible against a 20 ms target. The price of oversampling is paid in dropouts, not in delay.

## C. Rejected alternatives

**Adaptive quality by measured headroom.** Rejected: a fast machine would render a different tone from a slow one, so a shared link would sound different for the recipient. That breaks the only v1 mechanism by which one user creates another. Consequence accepted: fast machines keep unused headroom.

**A CPU benchmark before loading the engine.** Rejected by the user. A synthetic benchmark cannot predict real chain load, guarantees both false positives and false negatives, and adds delay in front of time-to-first-note — the metric everything else is measured against. Replaced by a live dropout counter and an honest cause.

**A crunch-that-cleans-up amp for v1.** Rejected in favour of a saturated lead. The crunch covers more ground with one model, but the reference point in scene A is the sound of the unplugged guitar, and the saturated lead is maximally far from it. Cost accepted: the gate becomes structural, oversampling is more heavily loaded, and a degraded input sounds worse rather than merely duller.

**Richer oversampling on build-time renders.** Offline rendering has no CPU budget, so 16x and a much larger model would be free. Deliberately not used: the demo would outperform the real-time path and every visitor who plugged in would be disappointed.

## D. Mechanism notes for architecture

**One canonical state object, two containers.** The tone link and the tone file serialise the same object. Version the object, not each container. The link is the compact form (URL hash, base64 of a packed binary layout); the file is the readable form (JSON, same field names as the TS parameter schema). Import validation lives at the object boundary, so it is written once.

**The parameter schema is the single source of truth.** TypeScript is authoritative; the C++ header is generated from it. This is also what makes the file format and the link format provably consistent with what the DSP actually reads.

**Unresolved: the cab.** `CLAUDE.md` names `ConvolverNode` for the impulse response, and separately requires one worklet for the entire chain. A `ConvolverNode` is a separate node, so placing it between Amp and Reverb splits the chain across a node boundary — a memory copy in the middle of the audio path, and metering that has to span two contexts. Either the IR convolution moves inside the worklet (hand-written partitioned convolution, more code, full control) or the chain accepts one boundary at that point. **This is an architecture decision, not a PRD one, but it must be settled before the worklet is written.**

**A preset catalogue does not need more amps.** A preset is a chain state, not a model. Any number of presets on one amp, one drive and one cab are just sets of fader values plus build-time renders — cheap in code, cheap in bytes. v1 nonetheless ships exactly one, because the cost that matters is not code but ear time: a preset that is not genuinely well tuned subtracts from the product rather than adding to it.

**Consequence on the launch SEO surface.** With one preset page, `CLAUDE.md` §6's plan — the launch surface comes from twelve preset pages — no longer holds. The long-tail guides become launch deliverables. This is a smaller surface at launch but a more durable one: guides rank on intent that exists whether or not the catalogue grows.

**The DI loop matters more than usual.** Build-time renders and the `OfflineAudioContext` fallback both play a fixed DI recording through the chain. With a shred-and-solo preset, that recording has to be a lead line — a chord strum through a saturated lead tells the visitor nothing about what the preset is for. It is the single most important audio asset in the listen path, since for most visitors it *is* the product.
