# Tonecraft

Real-time guitar amp and effects, running entirely in the browser. No install, no plugin, no driver setup.

---

## 1. Positioning

**One line:** Plug in, open a tab, play.

**The problem.** Getting a good guitar tone on a computer today costs money and an afternoon. You install a DAW or standalone host, install a plugin, buy a licence, install ASIO4ALL or a vendor driver, then discover your buffer size is wrong and everything is 40 ms late. Most people who just want to play through a decent amp for twenty minutes never get past step two.

**The answer.** Tonecraft is a URL. It asks for microphone permission, finds your interface, and you are playing. State lives in the browser, tones are shareable as links, and nothing is ever installed.

**What we are not.** Not a DAW. Not a multitrack recorder. Not a plugin host. Not a marketplace. Not a mobile app. Every one of those is a real product and none of them is this one.

---

## 2. Audience

**Primary: the bedroom player with an interface.** Owns a guitar and a cheap USB interface (Scarlett Solo, Behringer UM2, Zoom, Line 6). Plays 20 to 60 minutes at a time, mostly noodling and learning parts. Has probably pirated a plugin once, found it annoying to keep working, and gave up. Wants good tone with zero maintenance.

**Secondary: the traveller and the borrower.** On a laptop that is not theirs, or one they do not want to install on. Work machine, school computer, a friend's place, a rented flat with a borrowed guitar.

**Tertiary: the curious, arriving from a link.** Someone shared a tone link. They have no interface, so they land in demo mode and hear the tone applied to a sample loop. This is the top of the funnel and it must be beautiful, because most of these people will never plug in a guitar.

**Explicitly not the audience:** professional engineers mixing records, anyone who needs an IR loader with 12 slots, anyone comparing us to Neural DSP on tonal accuracy alone. We will lose that comparison and it does not matter.

---

## 3. Product principles

1. **Time to first note is the only metric that matters.** Target: under 8 seconds from cold load to audible sound, on a mid-range laptop, including permission grant. Every feature is measured against the cost it adds here.
2. **Latency is a first-class citizen, not a settings page.** The measured round trip is always visible in the interface. We never hide a number the player can feel.
3. **The default preset is the product.** Most people will hear one tone and decide. That tone is chosen and tuned by us, not left to a flat starting state.
4. **Fewer, better controls.** One knob that does the right thing beats five that require knowing what they do. If a parameter cannot be explained in four words, it gets a sensible fixed value instead.
5. **No account for the core loop.** Playing, tweaking and sharing require zero sign-up. Sign-up only ever buys persistence and sync.

---

## 4. Scope

### v1 signal chain

Fixed order, no rearranging. Rearranging is a power feature that costs UI complexity and buys almost nothing for this audience.

```
Input  ->  Gate  ->  Comp  ->  Drive  ->  Amp  ->  Cab (IR)  ->  Reverb  ->  Output
```

| Block | v1 scope | Decision |
|---|---|---|
| Input | Gain trim, tuner, input meter | Tuner is non-negotiable. It is the single most used feature in any amp sim. |
| Gate | Threshold only | Auto-release. High-gain is unusable without a gate and users should not have to find it. |
| Comp | One knob (amount) | Fixed ratio, attack, release. Tuned for clean fingerstyle. |
| Drive | Type (3), Gain, Tone, Level | Three pedals: transparent boost, green screamer, fuzzier op-amp. |
| Amp | Model (3), Gain, Bass, Mid, Treble, Master | Three amps: Clean, Crunch, Lead. Named by sound, not by trademark. |
| Cab | IR select (6), Mix | Our own IRs, licence-clean. See section 7. |
| Reverb | Type (2: Room, Hall), Mix | No delay in v1. See below. |
| Output | Master, mute, tone link | |

### v1 also includes

- Tuner (chromatic, cents readout, latency-independent)
- Preset browser with 12 curated factory tones, no user save in v1 without account
- Tone link: full chain state encoded in the URL, shareable and openable by anyone
- Demo mode: dry DI loops for visitors with no interface, so the product is fully explorable without hardware
- Latency readout and a one-time input calibration step
- Metronome

### Cut from v1, deliberately

- **Delay.** High CPU cost per unit of perceived value at this stage, and it makes the default preset harder to tune. Ships in v1.1.
- **Recording and export.** Turns us into a DAW and pulls in file management, storage and format questions. v2 at the earliest.
- **User IR upload.** Support burden, file handling, and a licensing minefield. Later, gated behind an account.
- **Chain reordering, dual amps, stereo rigs.** Power features for an audience we do not have yet.
- **Mobile.** WebAudio input latency on iOS is not currently good enough to play through, and Android device variance makes it worse. The site is responsive and demo mode works on a phone, but we do not promise playability there and we do not ship a mobile app.

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

**We therefore never advertise "zero latency" or a specific millisecond figure.** The claim is "as low as your hardware allows, with no driver to install". We measure the real round trip on load and show it. If it is above 30 ms we show a short, non-technical explanation and a link to the one thing that actually helps on Windows, which is a class-compliant interface.

**Echo cancellation, noise suppression and AGC are disabled** on the input stream. They are on by default in `getUserMedia` and they destroy guitar signal. This is the single most common failure mode for browser audio apps and it gets an explicit test.

**Meters and the visualiser read from a SharedArrayBuffer**, sampled by the UI at 30 fps. The audio thread never posts messages per frame. This requires cross-origin isolation headers, which is a hosting constraint, not an optional nicety.

**CPU budget: one core under 25% on a 2019 MacBook Air.** Laptop fans spinning up is a product failure. If a feature cannot fit the budget, it does not ship.

**Bundle budget: under 400 KB for first interactive**, IRs and amp models streamed after. The pitch is lightweight, so the download has to be.

**Browser support:** Chromium and Firefox on desktop are supported. Safari is best-effort, since its AudioWorklet and input handling lag behind. We detect and tell the truth rather than degrading silently.

---

## 6. Business

**Free tier:** the whole v1 signal chain, all 12 factory presets, tone links, demo mode. Unlimited, no account, no time limit. The free tier has to be genuinely good, because it is the marketing.

**Tonecraft Plus, 4 EUR per month or 36 EUR per year:** saved presets synced to an account, extra amps and cabs as they ship, user IR upload, recording and export when it lands.

**No ads, ever.** They break the aesthetic and the audience despises them.

**No one-time perpetual licence in v1.** Revisit once the model catalogue is deep enough to be worth owning.

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
| Time to first audible note, median | under 8 s |
| Sessions that reach audible sound | over 70% of sessions with an input device |
| Median session length | over 12 min |
| Sessions where a preset is changed | over 50% |
| Tone links opened per link created | over 1.5 |
| Reported audio dropouts per session | under 0.2 |

The dropout number is the one that kills the product if it goes wrong. A single glitch while someone is playing is worse than a slightly duller tone.

---

## 9. Roadmap

**v1.0, launch.** Everything in section 4. Chromium and Firefox, desktop.

**v1.1.** Delay. Two more amps. Accounts and preset saving. Tonecraft Plus goes live.

**v1.2.** Backing track player with a local file, so people can play along without a DAW. Tempo-synced delay.

**v2.0.** Recording and export. User IR upload. Possibly a looper, which is the most requested feature in every guitar product ever built.

**Not planned:** collaboration, cloud rendering, AI tone matching, a plugin version, a mobile app.
