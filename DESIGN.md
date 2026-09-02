# Tonecraft, design system

---

## 1. Direction


**Nylon and mineral.**

Every amp sim on the market renders brushed metal, tolex, chicken-head knobs and screw heads. It is skeuomorphism inherited from hardware that most of the audience has never owned. Tonecraft rejects it completely, because the product's whole argument is that it is not hardware and does not need to be installed. The interface should feel like a well-made object in a quiet room: chalky surfaces, matte finishes, cool light, one green.

Reference points are not guitar gear. They are architectural model photography, Braun-era instrument panels, and the flat side of a piece of unglazed ceramic. Warm, but not cosy. Precise, but not clinical.

**The tone of voice matches:** plain, short, never enthusiastic. The interface does not say "Awesome tone!". It says "Clean". It does not apologise when something fails, it says what happened and what to do.

**The one risk we take:** there are no round knobs anywhere in the product. Every continuous control is a vertical linear fader with a hairline travel and a single flat cap. This is a real departure from category convention and it will look wrong to people expecting an amp panel. It is worth it because faders are legible at a glance in a row, they map perfectly to touch and drag on any input device, and a row of them reads as a set of strings, which is the right metaphor for this product. It also means the interface reads instantly as software rather than as a photograph of hardware.

---

## 2. Colour

Six tokens. No gradients anywhere, no drop shadows except one elevation level, no glass, no glow.

| Token | Hex | Role |
|---|---|---|
| `--ink` | `#16181B` | All text, hairlines, fader caps. Cool near-black, never pure black. |
| `--chalk` | `#E7E8E2` | Page background. Cool grey-green paper, deliberately not a warm cream. |
| `--bone` | `#F4F4F0` | Raised surfaces: module cards, sheets, the preset drawer. |
| `--graphite` | `#767A78` | Secondary text, inactive labels, disabled state. |
| `--celadon` | `#8FB09A` | The only accent. Active states, signal presence, the cord, selected preset. |
| `--iris` | `#4A46D9` | Focus rings and keyboard navigation only. Never decorative. |
| `--ember` | `#B24A34` | Clipping and destructive confirmation only. Nothing else, ever. |

**Why not warm cream and terracotta.** That palette is where every softly-designed audio tool has landed in the last two years, and it reads as generic the moment it is next to a competitor. Pulling the paper cool and green-tinted, and reserving the only saturated hue for a desaturated celadon, gives the product a specific temperature that is recognisable in a screenshot.

**Dark mode ships in v1.1, not v1.** Doing it properly means re-deriving the whole system, and a half-inverted palette looks worse than none. `--ink` and `--chalk` swap roles, `--celadon` lifts to `#A6C4B0`, `--iris` lifts to `#7A77E8`.

---

## 3. Typography

Three roles, three faces. All self-hosted, subset, `woff2`, preloaded.

**Display: Anybody.** Variable width axis, used at width 125 and weight 300, tracked out to `0.24em`, always uppercase, never above 32px except in the wordmark. It is a wide, slightly strange grotesque and it does the entire job of giving the product a face. Used for: the wordmark, module names (`DRIVE`, `AMP`, `CAB`), section eyebrows. Nothing else. Used more than that it becomes noise.

**Body: Inter Tight.** Weights 400 and 500. Preset names, descriptions, help text, buttons, dialogs. Chosen over Inter because the tighter width sits better against a wide display face, and it is not the default every interface reaches for.

**Utility: IBM Plex Mono.** Weight 400, tabular figures. Every number in the product: dB values, cents, milliseconds, BPM, percentages. Numbers in a mono face with fixed-width digits do not jitter when they update at 30 fps, which matters enormously for meters and the tuner.

### Scale

| Step | Size / line height | Use |
|---|---|---|
| Wordmark | 28 / 1 | Anybody, tracked `0.32em` |
| Module label | 11 / 1.2 | Anybody, tracked `0.24em`, uppercase |
| Heading | 20 / 1.3 | Inter Tight 500 |
| Body | 15 / 1.5 | Inter Tight 400 |
| Small | 13 / 1.4 | Inter Tight 400, `--graphite` |
| Readout large | 44 / 1 | Plex Mono, tuner cents only |
| Readout | 13 / 1 | Plex Mono, all other numbers |

Sentence case everywhere except the display face, which is always uppercase. No title case, ever.

---

## 4. Layout

**Concept: the chain is the interface.** The signal path runs left to right across the full width of the viewport as a single horizontal strand of modules, in the exact order the audio passes through them. There is no navigation, no sidebar, no tabs. The page is the rig. Everything else, presets, settings, tuner, arrives as a sheet over the top and leaves again.

```
+--------------------------------------------------------------------------+
|  TONECRAFT                              12.4 ms   |  Tuner  Presets  ...  |
+--------------------------------------------------------------------------+
|                                                                          |
|                          Crimson Room                                    |
|                          clean, wide, a little dark                      |
|                                                                          |
+--------------------------------------------------------------------------+
|                                                                          |
|      IN      GATE      DRIVE        AMP        CAB      REVERB     OUT    |
|    +----+   +----+   +-------+   +-------+   +-----+   +------+   +---+   |
|    | ▮  |   | |  |   | | | | |   | | | | |   |  |  |   |  | | |   | ▮ |   |
|    | ▮  |---| ▯  |---| ▯ ▯ ▯ |---| ▯ ▯ ▯ |---|  ▯  |---|  ▯ ▯ |---| ▮ |   |
|    | ▮  |   | |  |   | | | | |   | | | | |   |  |  |   |  | | |   | ▮ |   |
|    +----+   +----+   +-------+   +-------+   +-----+   +------+   +---+   |
|     -6.2     thr     gn tn lv    gn b m t      mix       mix      -3.0    |
|                                                                          |
+--------------------------------------------------------------------------+
```

The compressor is not in v1 — it joins the strand in v1.1, between the gate and the drive.

The strand is vertically centred and occupies roughly the middle third of the viewport. Above it, only the preset name and its one-line description. Below it, nothing. The emptiness is the point: this is a product about not having a cluttered plugin window.

**Grid:** 8px base unit. Module cards are `--bone` on `--chalk`, 2px radius (almost square, not sharp), one elevation shadow at `0 1px 2px rgba(22,24,27,0.06)`. Gap between modules is 24px, filled by the cord.

**Responsive:** below 1100px the chain wraps to two rows, still in order, cord continuing across the break. Below 720px the chain becomes a vertical stack and the product shows a notice that playing through the browser on a phone is not supported.

**The listen path has its own layout**, and it is the one most visitors will see. A preset page is the chain rendered read-only — same modules, same fader positions, same cord — over a single play control. It ships no JS engine, so it works identically on a phone. Nothing on it is draggable, and nothing pretends to be.

---

## 5. Signature element: the cord

**The modules are connected by a continuous 1px hairline that carries the live signal.** It is not decoration and it is not a static line. Its opacity is driven by the actual amplitude at that point in the chain, read from the shared meter buffer, so you can watch your pick attack travel from input to output. Between the input and the gate it is grey when the gate is closed. After the drive it sits brighter because the signal is hotter. When anything clips, that segment and only that segment turns `--ember`.

This is the one thing people will screenshot, and it does real work: it makes the signal chain legible to a beginner who has never thought about gain staging, and it turns troubleshooting into something you can see. No signal reaching the amp is instantly obvious, because the cord is dark before it.

**The cord is the whole visualisation layer.** There is no spectrum analyser, no oscilloscope, no `AnalyserNode` and no `<canvas>` anywhere in the product. Everything that needs to be seen about the signal is seen here.

**Constraints, play path:** per-stage RMS is computed inside the single audio worklet — it is already there, so the measurement is free — written into a pre-allocated `Float32Array` and posted at 30 Hz. The UI reads it in a `requestAnimationFrame` loop and writes CSS custom properties. Thirty messages a second carrying a few dozen bytes is negligible on both threads. Never per-sample, never a canvas redraw. **No `SharedArrayBuffer` and no cross-origin isolation** — the hosting cannot provide them and the cord does not need them.

**Constraints, listen path:** on a pre-rendered preset page there is no audio graph at all. The per-stage RMS envelope is computed at build time, shipped as a small JSON file, and animated from `audio.currentTime`. Identical visual behaviour, zero JS engine.

That symmetry is the point. The cord is the only element strictly identical on both load paths — it is what makes someone who listened to a preset page and then plugged in a guitar recognise the same product rather than two sites sharing a name.

Under `prefers-reduced-motion` the cord holds a steady average instead of tracking transients.

Everything else in the interface stays quiet so this can be the loud thing.

---

## 6. Components

**Fader.** Vertical, 96px travel, 2px hairline in `--graphite`, cap is a 20 x 6px flat rectangle in `--ink`. Active fill above the cap in `--celadon`. Value appears in Plex Mono below the fader only while dragging, otherwise the label shows. Drag, scroll wheel, arrow keys, shift for fine, double-click to reset to preset default. Hit area is 40px wide regardless of visual width.

**Module card.** `--bone`, module name in Anybody at the top left, bypass toggle at the top right. A bypassed module drops to 40% opacity and its segment of the cord routes straight past it.

**Toggle and selector.** Segmented control, no rounded pills. Selected segment gets an `--ink` underline 2px, not a filled background. Filled backgrounds fight the calm.

**Latency badge.** Top right, always visible, Plex Mono. Under 20 ms it is `--graphite` and says nothing. Between 20 and 35 ms it stays `--graphite` but gains a subtle underline that opens an explanation on click. Over 35 ms it turns `--ember` and the explanation names the hardware cause — most often a guitar plugged into the laptop's mic input. It never nags, it never hides, and **it never blocks**.

**Tuner.** Full-screen sheet over `--chalk`. Note name in Anybody at 120px, cents deviation in Plex Mono at 44px, and a single horizontal hairline that shifts left and right of centre. In tune is `--celadon` and holds for 400ms so it registers. No strobe animation, no needle.

**Meters.** Two segments only, one for input and one for output, each 4px wide vertical bars in `--celadon` with an `--ember` cap on clip that holds for 1.5 s. No peak-hold lines, no numeric dB scale printed alongside.

---

## 7. Motion

Motion is scarce and it is always functional.

- **Page load:** modules fade up in signal order, left to right, 40ms apart, 240ms each, `cubic-bezier(0.2, 0, 0, 1)`. It takes under 600ms total and it teaches the signal direction on the first visit without a word of copy.
- **Sheets** slide up 16px and fade in over 200ms.
- **Fader drags** are never animated. Direct manipulation must be 1:1 with the pointer.
- **The cord** is the only continuous animation in the product.
- **No hover animations on controls.** Hover changes the cursor and lifts the label to `--ink`. That is all.

Everything above respects `prefers-reduced-motion`, which disables the load sequence entirely and holds the cord steady.

---

## 8. Quality floor

Not features, just the baseline the build has to clear.

- Every control reachable and operable by keyboard, with a visible `--iris` focus ring at 2px offset 2px. Faders respond to arrow keys and announce their value.
- All interactive targets at least 40px in the smaller dimension.
- Contrast: `--ink` on `--chalk` is well past AA. `--graphite` is only ever used at 13px and above for non-essential text. `--celadon` is never used to carry information on its own, always paired with position or a label, because a red-green colour vision deficiency must not make the cord useless.
- The UI thread never blocks the audio thread. Any component that cannot hold 30 fps gets simplified rather than optimised.
- Empty and failure states are designed, not defaults. No input device found is a screen with one instruction and a link to demo mode, not an alert box.

---

## 9. Copy rules

- Amps and presets are named for what they sound like, never after real gear. "Crimson Room", "Nylon", "Bright Hall", "Stack".
- Every preset has exactly one lowercase description line, three to six words, no exclamation marks. "clean, wide, a little dark".
- Buttons name the outcome: "Copy tone link", not "Share". The confirmation uses the same word: "Tone link copied".
- Errors state the cause and the fix in one sentence each. "No audio input found. Connect an interface and reload."
- Never use the words: immersive, powerful, seamless, unleash, unlock, craft as a verb. The product is called Tonecraft and it will not say the word twice.
