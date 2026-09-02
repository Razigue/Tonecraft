# Tonecraft

Real-time guitar amp and effects, running entirely in the browser. No install, no plugin, no driver setup.

---

## 1. Positioning

**One line:** Plug in, or listen first. It plays in the tab.

**The problem.** Getting a good guitar tone on a computer today costs money and an afternoon. You install a DAW or standalone host, install a plugin, buy a licence, install ASIO4ALL or a vendor driver, then discover your buffer size is wrong and everything is 40 ms late. Most people who just want to play through a decent amp for twenty minutes never get past step two.

**The answer.** Tonecraft is a URL. Everything starts from listening: the tone is audible in one second, with no JS, on any device, because it was rendered at build time. If you have a guitar and a way to plug it in, the same URL becomes a real-time rig. State lives in the browser, tones are shareable as links, and nothing is ever installed.

**The engine is not the product.** It is the renderer that makes the product — running at build time to produce what most visitors will hear, and in real time for the minority who plug in. Playing is one mode, and it is not the most frequent one. This inversion arbitrates the whole architecture.

**What we are not.** Not a DAW. Not a multitrack recorder. Not a plugin host. Not a marketplace. Not a mobile app. Every one of those is a real product and none of them is this one.

---

## 2. Audience

**The job to be done, and the scene v1 is built for.** The player has had the guitar in hand for ten minutes, working on a part dry, and is tired of hearing bare wood. The competitor is not Neural DSP. It is the small combo in the corner of the room, the amp app on the phone, and above all the decision to put the guitar down. The reference point is the sound of the unplugged guitar.

**Primary: the bedroom player with a way in.** Owns a guitar and either an interface (Scarlett Solo, Behringer UM2, Zoom, Line 6) or a guitar-to-USB cable — a 20-30 EUR Guitar Link is a class-compliant interface and is fully supported. Plays 20 to 60 minutes at a time, mostly noodling and learning parts. Has probably pirated a plugin once, found it annoying to keep working, and gave up. Wants good tone with zero maintenance.

**Secondary: the traveller and the borrower.** On a laptop that is not theirs, or one they do not want to install on. Work machine, school computer, a friend's place, a rented flat with a borrowed guitar.

**Largest by volume: the listener, arriving from a link or a search.** Someone shared a tone link, or a preset page ranked. They may have no interface, no guitar, and be on a phone. They hear the tone immediately, from a file rendered at build time. This is not the bottom of the audience list — it is most of it, and it is where the product is judged.

**Explicitly not the audience:** professional engineers mixing records, anyone who needs an IR loader with 12 slots, anyone comparing us to Neural DSP on tonal accuracy alone. We will lose that comparison and it does not matter.

---

## 3. Product principles

1. **Time to first note is the only metric that matters.** Target: under 8 seconds from cold load to audible sound, on a mid-range laptop, including permission grant. This is not a vanity number — it is the threshold beyond which setup breaks the practice loop the player was in. Every feature is measured against the cost it adds here.
2. **Latency is measured and shown, never hidden — and never the headline.** The target is not studio real time; recording is out of scope. It is low enough that the delay is not felt while playing. The measured round trip is always visible. The real failure criterion is dropout rate and jitter, not milliseconds: a constant 20 ms delay is forgotten in a minute, a delay that varies or crackles is unplayable forever.
3. **The default preset is the product.** Most people will hear one tone and decide. That tone is chosen and tuned by us, not left to a flat starting state. It follows that quality is fixed and never adapts to the machine — a deterministic render is what makes a shared tone sound the same for the other person.
4. **Fewer, better controls.** One fader that does the right thing beats five that require knowing what they do. If a parameter cannot be explained in four words, it gets a sensible fixed value instead.
5. **No account, at all.** Playing, tweaking, saving and sharing require zero sign-up. Persistence is `localStorage`, sharing is a tone link or a tone file. The product holds no personal data, no identifier and no cookie — measurement is anonymous, aggregate-only and refusable — and that is a feature rather than a limitation.

---

## 4. Scope

### v1 signal chain

Fixed order, no rearranging. Rearranging is a power feature that costs UI complexity and buys almost nothing for this audience.

```
Input  ->  Gate  ->  Comp  ->  Drive  ->  Amp  ->  Cab (IR)  ->  Reverb  ->  Output
```

| Block | v1 scope | Tier | Decision |
|---|---|---|---|
| Input | Gain trim, tuner, input meter | Must | The tuner ships in v1, behind a discreet icon rather than on the panel. The job to be done starts with picking up a guitar that has not been tuned in days, and an out-of-tune guitar through a high-gain amp sounds actively bad — worse than dry. |
| Gate | Threshold only | Must | Auto-release. High-gain is unusable without a gate and users should not have to find it. |
| Comp | One fader (amount) | Should | Fixed ratio, attack, release. Tuned for clean fingerstyle. |
| Drive | **One** type, Gain, Tone, Level | Must | Promoted from Should. A boost in front of high gain tightens the low end and defines the attack. It is adjacent to the amp, so it shares the same oversampling window and costs only its waveshaper. Being Must, it sits in the startup bundle rather than being lazy-loaded. Two more pedals in v1.1. |
| Amp | **One model** in v1, then Gain, Bass, Mid, Treble, Master | Must (one) / Should (the other two) | The default preset is the product, so v1 ships the one tone that has to be excellent. Amps 2 and 3 are lazy-loaded content, not launch blockers. Named by sound, not by trademark. |
| Cab | **One IR** in v1, Mix | Must (one) / Should (the rest) | Our own IRs, licence-clean. See section 7. |
| Reverb | **One** room, Mix | Must | Promoted from Should. Dry high gain in headphones sits inside the head and fatigues within minutes, and a lead line with no ambience has nowhere to sustain into. It sits after every non-linearity, so it is never oversampled. Hall in v1.1. No delay in v1. |
| Output | Master, mute, tone link, **non-disableable limiter** | Must | The limiter is never exposed to the UI. A digital feedback loop in headphones can injure. |

### v1 also includes

**Must**

- Tuner (chromatic, cents readout, ±1 cent, unaffected by round-trip latency), reachable from a discreet icon. The metronome moves to v1.1 — nothing breaks if it arrives later.
- **The listen path**: one build-time rendered audio file per factory preset, served on `/presets/<slug>` with 0 kB of JS, no WASM, no `AudioContext`, no mic permission. Works on any device, phones included.
- **The cord** (see `DESIGN.md` §5), on both paths — live from per-stage RMS on the play path, from a build-computed RMS envelope on the listen path
- Sharing, two carriers for one payload: the **tone link** (chain state in the URL hash) and the **tone file** (the same state as a versioned JSON download). Same encoder, same values. Import validates and never half-applies a tone.
- Preset saving in `localStorage`. No account, no server, no sign-up.
- Onboarding: device detection, input calibration, onboard-input diagnosis, permanent latency readout
- FR/EN from day one

**Should**

- Further presets and their pages. v1 ships **one** preset — a high-gain lead built for shred and solos. A preset is a chain state rather than a model, so adding more needs no application code: parameter values, a build render, a generated page.
- `OfflineAudioContext` fallback: a custom tone link opened without an interface downloads the engine, renders the DI loop through the chain faster than real time, and plays the resulting buffer. Slow to open, works everywhere, no dropout risk.

### Cut from v1, deliberately

- **Accounts, sync, and Tonecraft Plus.** They require a server, which the product does not have and will not get. See section 6.
- **Delay.** High CPU cost per unit of perceived value at this stage, and it makes the default preset harder to tune. Ships in v1.1.
- **Recording and export.** Turns us into a DAW and pulls in file management, storage and format questions. v2 at the earliest.
- **User IR upload.** Support burden, file handling, and a licensing minefield.
- **Chain reordering, dual amps, stereo rigs.** Power features for an audience we do not have yet.
- **Spectrum analyser and oscilloscope.** No canvas anywhere in the product. The cord carries all visualisation.
- **Playing on mobile.** WebAudio input latency on iOS is not currently good enough to play through, and Android device variance makes it worse. **The listen path, however, works fully on a phone** — it loads no engine at all, so there is nothing to degrade.

---

## 5. Technical constraints that shape the product

These are not implementation details, they are the boundaries of what can be promised.

**Audio runs in an AudioWorklet, 128-frame render quantum, 48 kHz.** DSP is compiled to WASM (SIMD where available) and loaded into the worklet. Nothing touching audio ever runs on the main thread.

**Latency is dominated by the user's driver, not by us.** Our processing budget is roughly 2.7 ms of buffering plus algorithmic delay. The rest belongs to the operating system. Realistic round trips:

| Setup | Realistic round trip |
|---|---|
| macOS, CoreAudio, USB interface | 8 to 14 ms |
| Windows, WASAPI shared, USB interface | 20 to 35 ms |
| Windows, onboard audio | 40 ms and up, we warn the user |

**We therefore never advertise "zero latency" or a specific millisecond figure.** The claim is "as low as your hardware allows, with no driver to install". We measure the real round trip on load and show it, on three tiers: under 20 ms nothing is said; between 20 and 35 ms the number is shown and clicking it opens the explanation; above 35 ms we state the hardware cause plainly. **We never block.**

**Latency is secondary, but the CPU budget is not.** In an AudioWorklet the quantum is fixed at 128 frames, so there is no buffer setting to trade latency against CPU. Exceeding the budget does not produce more latency, it produces a glitch. The CPU budget *is* the dropout budget.

**Echo cancellation, noise suppression and AGC are disabled** on the input stream. They are on by default in `getUserMedia` and they destroy guitar signal. This is the single most common failure mode for browser audio apps and it gets an explicit test.

**Bad input hardware is diagnosed, never blocked.** A passive pickup wants a 500 kΩ to 1 MΩ load; a laptop mic input offers a few kΩ and injects bias voltage, producing a weak, thin, treble-starved signal — on top of 40 ms and up from onboard audio. The user cannot tell an impedance problem from a bad engine, and will blame us. Device label, measured latency, input level and bandwidth are enough to detect it at calibration. State the cause and the remedy in one sentence each.

**Meters and the cord read per-stage RMS computed inside the worklet**, written to a pre-allocated `Float32Array` and posted at 30 Hz. Thirty messages per second is negligible. **No `SharedArrayBuffer`, no COOP/COEP, no cross-origin isolation** — none of which GitHub Pages can provide, and none of which the product needs.

**Quality never adapts to the machine.** Model complexity is fixed at build time for the floor machine — LSTM hidden size 20 — never chosen at runtime from measured headroom. A deterministic render is the precondition for a shared tone to sound the same for the other person; adaptive quality would make the tone link lie. Fast machines keep unused headroom. Since no graceful degradation is possible, a machine that cannot hold the budget is **never refused**: dropouts are counted and shown, the likely cause is named, and the listen path is offered as an alternative. An offer, never a redirect.

**Build-time renders use the identical engine settings.** Offline rendering has no CPU budget, so 16x oversampling and a much larger model would be free. Using them would make the demo sound better than the real-time path, and a visitor who plugs in would be disappointed. The headroom is deliberately left unused.

**CPU budget: one core under 25% on a 2019 MacBook Air.** Laptop fans spinning up is a product failure. If a feature cannot fit the budget, it does not ship.

**Bundle budget: under 400 KB for first interactive**, IRs and amp models streamed after. The pitch is lightweight, so the download has to be.

**Browser support:** Chromium and Firefox on desktop are supported. Safari is best-effort, since its AudioWorklet and input handling lag behind. We detect and tell the truth rather than degrading silently.

---

## 6. Business

**v1 is free, for everyone, with no accounts and no monetisation.** The whole signal chain, every factory preset, tone links, local preset saving, the listen path. Unlimited, no sign-up, no time limit.

**There is no paid tier in v1.** Tonecraft Plus, synced presets and the 4 EUR/month figure are an undated hypothesis, not a plan. Every version of them requires a server, a database and an account system, which the product structurally does not have. Revisit only if the constraint itself is ever revisited.

**Zero infra cost is the identity, not a limitation.** The product holds no personal data, needs no administration, and survives without maintenance. That is the argument, and it is why the whole thing fits on GitHub Pages.

**The one real ceiling is bandwidth.** Twelve presets at mono Opus 96 kbps over 20 s is about 2.9 MB in the repository, and GitHub Pages soft-limits around 100 GB/month — roughly 400k demo listens before this has to be reconsidered. A problem worth having, but the first number where the constraint has an actual roof.

**No ads, ever.** They break the aesthetic and the audience despises them.

---

## 7. Legal position

**Amp models are named by character, not by trademark.** Clean, Crunch, Lead. No "based on a Marshall JCM800", no silhouettes of real amps, no borrowed control layouts. Describing a model as a copy of a named commercial amp is the fastest way to receive a letter, and it buys nothing that a good demo does not.

**All impulse responses are ours**, captured in-house or licensed with redistribution rights, with provenance documented. No IR packs of unknown origin.

**No visual, naming or marketing association with any artist or existing plugin.** The aesthetic direction is our own. Inspiration is fine, resemblance in trade dress is not.

**Trademark:** "Tone" is a crowded namespace in music software. Before any launch spend, clear Tonecraft with an INPI and EUIPO search in class 9 and class 42, and check the US TESS database. Secure tonecraft.app if the .com is taken, and hold the matching npm name and GitHub org.

---

## 8. Success metrics

| Metric | Target at 3 months |
|---|---|
| **Reported audio dropouts per session** | **under 0.2** |
| Latency jitter, standard deviation over a session | under 2 ms |
| Time to first audible note, median | under 8 s |
| Preset page: time to audible sound | under 1 s |
| Sessions that reach audible sound | over 70% of sessions with an input device |
| Median session length | over 12 min |
| Sessions where a preset is changed | over 50% |
| Tone links opened per link created | over 1.5 |

The dropout number is first on the list because it is the one that kills the product. A single glitch while someone is playing is worse than a slightly duller tone — and since the CPU budget *is* the dropout budget, this is the metric every DSP decision is measured against.

Absolute latency is deliberately absent from this table. It is measured and shown, but it is dominated by hardware we do not control, and its stability matters far more than its value.

---

## 9. Roadmap

**v1.0, launch.** The Must tier of section 4: one amp, one drive, one IR, one room reverb, gate, limiter, tuner, onboarding, the cord, tone links and tone files, local saving, the listen path with its single preset page, and the long-tail guides that carry the launch SEO surface. Chromium, Firefox and Safari on desktop for playing; every device for listening.

**v1.1.** The Should tier: amps 2 and 3, drives 2 and 3, the compressor, a hall reverb, the metronome, further factory presets and their pages, the `OfflineAudioContext` fallback. Delay.

**v1.2.** Dark mode. Backing track player with a local file, so people can play along without a DAW. Tempo-synced delay.

**v2.0.** Recording and export. Possibly a looper, which is the most requested feature in every guitar product ever built.

**Content cadence, continuous from launch.** Each amp added is a new indexable page. The SEO surface grows with the catalogue instead of being a launch prerequisite.

**Not planned:** accounts, collaboration, cloud rendering, AI tone matching, a plugin version, a mobile app. **Structurally impossible while the zero-infra constraint holds:** anything requiring a server, a database or custom HTTP headers.
