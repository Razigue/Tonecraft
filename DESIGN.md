# Tonecraft, design system

This document describes the studio as it is built. `app/tokens.css` holds every value named here; a component never hard-codes one.

---

## 1. Direction

**A dark studio, one accent.** Tonecraft owns the shell: black and neutral greys, the bar, the chain, the transport, the dialogs. Each amplifier owns only its head: material, inscription, glass, the accent of its knobs. GUILT is the identity of the Lead capture and keeps it while its parameters move; every other capture wears the neutral Tonecraft head. Knobs control existing DSP parameters; a head never implies modelling that is not there.

The shell stays flat: no tolex, no chrome, no decorative screws outside the head. The head is the one place with material, and it earns it by being the object the player is tuning.

**The tone of voice:** plain, short, never enthusiastic. The interface does not say "Awesome tone!". It does not apologise when something fails, it says what happened and what to do.

---

## 2. Colour

| Token | Role |
|---|---|
| `--surface-0` | The room: the page, to the edge of the screen. |
| `--surface-1` | Raised: the head, dialogs, popovers. |
| `--surface-2` | A control lifted off a plate. |
| `--faceplate` | The plate material every band and the tab stage are cut from. |
| `--line`, `--line-strong` | Engraved seams; hover and borders that must be seen. |
| `--text`, `--text-2`, `--text-3` | Text, three steps. |
| `--violet-50` … `--violet-900` | The only accent. Light steps light up, dark steps are what they light up against. |
| `--accent`, `--accent-line` | Active state, signal, selection. |
| `--action`, `--action-hover`, `--action-text` | The one primary action of a group. |
| `--ember`, `--ember-line` | Recording, clipping, destruction. Nothing else. |
| `--iris` | Focus rings only. |

The tab is the only light surface: notation is read, and paper reads. Its playhead and the lit notes on the neck share one amber, the only hue the score owns.

`--ink`, `--chalk`, `--bone`, `--graphite` and `--celadon` survive as aliases for the landing page and older rules. New code uses the names above.

---

## 3. Typography

Four faces, self-hosted, subset, `woff2`, `font-display: swap`.

- **Display: Anybody**, width 125, uppercase, tracked. The wordmark, eyebrows, band and group labels.
- **Body: Inter Tight**, 400 and 500. Names, buttons, help, dialogs.
- **Utility: IBM Plex Mono**, tabular figures. Every number: dB, cents, ms, BPM, bars, time. Fixed-width digits do not jitter at 30 fps.
- **Inscription: Cormorant Garamond**, GUILT's face and only GUILT's.

### Two scales

The studio is used at two distances. Dialling a tone happens at arm's length; playing along happens at 1.5 m, guitar in hand. Each mode has its scale, switched by `[data-view]` on the page:

| Token | Tone | Play | Use |
|---|---|---|---|
| `--type-clock` | 14 px | 20 px | Transport position and duration |
| `--type-bar` | 16 px | 26 px | Current bar number |
| `--type-tempo` | 16 px | 26 px | BPM |
| `--type-rec` | 13 px | 18 px | Take state and time |

The tab itself is laid out at a larger base scale than alphaTab's default, permanently: it is only on screen in Play, and re-laying it out at each mode change would block the main thread. The zoom select is relative to that base.

Sentence case everywhere except the display face, which is always uppercase.

---

## 4. Layout

**An instrument, not a page.** One window, `100dvh`, four bands. The document never scrolls; the only thing that does is the tab.

**Plates in a room.** The chain and the transport are plates of the faceplate material, floating with a `--gutter` of room around them, as the head does. In Tone they are exactly the head's column wide, so band, head and transport read as one object in the middle of a dark room; a static violet light behind the head brightens with the output, by opacity only. In Play they open to the full width with the tab. On a screen at least 900 px tall, the chain band in Tone takes full-size knobs, names above and values below; otherwise, and always in Play, it is the compact 80 px row.

```
+--------------------------------------------------------------------------+
| TONECRAFT              [ TONE ]  PLAY                   12.4 ms   ⚙      |  bar, 56 px
+--------------------------------------------------------------------------+
| IN ▮ ◯   GATE ◯ ●   AMP [GUILT · Lead ▾]  CAB [...▾]   ‹ PRESET ›   ◯ ▮ OUT |  chain, 80 px
+--------------------------------------------------------------------------+
|                                                                          |
|                 +--------------------------------------+                 |
|                 |        the head, --column wide       |                 |  stage, elastic
|                 +--------------------------------------+                 |
|                                                                          |
+--------------------------------------------------------------------------+
| ■ ▶ ● [ TAB  0:42 ━━━━○━━ 1:20 │ BAR 12/40 │ BPM 96 ]  ↻ 100% ≡  LOOP  ⊟ ♪ ⏲ |  DAW row, 88 px
| GUITAR  ━━○  [ lane ................................ ]   DI·PROC ▶ EXPORT    |  tracks, always on screen
| BACKING ━━○  [ lane ................................ ]            + TRACK    |
+--------------------------------------------------------------------------+
```

**Two modes, one stage.** The bar carries the studio's only navigation: two tabs, *Tone* and *Play*, always visible, the chosen one underlined on the bar's edge (arrow keys move between them). A mode owns the whole stage; nothing is stacked or folded, because panels sliding in and out of a column made the player hunt for the way back.

**Tone.** The head, `--column` wide (1180 px), centred. It has one size and one shape: it never reflows and its glass never shrinks. What a smaller window changes is how big it is drawn — the studio scales it whole to the room it has, the way stepping back from an amp makes it smaller rather than flatter — so its proportions are the same on every screen.

**Play.** The tab, as wide as the side room allows, with no maximum width. The head is not on screen, so its power switch appears in the chain band, before the output.

**Opening a tab goes to Play.** From either mode: the transport's tab zone reads "Open a tab" when none is open. Writing one does the same.

**The tab gives way from the bottom.** Under the score, the scale bar and the neck share what is left; below a neck's worth of room they go, and the score keeps its size.

**The transport is the studio's DAW.** Its tracks — the guitar takes and the backing song, with their levels, export and the track tools — are always on screen, under its row, never in a menu. In Tone the transport is the head's width, so its row takes two lines: the keys and the display, then the groups. The stage gives up the height all this takes, and the head is scaled to what is left (`zoom`, fitted to whichever of width and height runs out first; a transform would open a stacking context the tutorial cannot lift through). Past three tracks the lanes scroll inside the transport. Under 820 px of window height the row and the lanes tighten.

**The corners.** The tuner floats at the bottom left, the metronome at the bottom right with its start and tempo above it: small dark tiles with a hairline edge and a thin icon, a dot under a tile when it is on. A side room (`--side`) is kept for them in both modes, which is also why Play is wide without touching the window's edges. The bar alone spans that room, so the name and the settings never move with the mode. What still opens — the tab's track list, the levels — floats as a popover; notices sit over the top of the stage, under the chain.

**Width.** The studio is a desktop instrument; playing is not supported on a phone (`CLAUDE.md` §7). What is on a phone still has to be whole. Three thresholds, and nothing else changes:

- **Under 1100 px**, or under 900 px of height, the chain band drops its full knobs for its compact ones, and under 1100 px it wraps: the levels and the gate on one line, the two selectors and the preset on the next. Squeezed onto one line instead, the selectors collapse to their chevrons and their names print over each other.
- **Under 760 px wide, or under 560 px high**, the studio stops being an instrument and becomes a page: the bands stack, the window scrolls, the corner tools come in out of the side room the page no longer keeps, and the last plate ends above them.
- **The head is never one of these thresholds.** It is one object at one size, scaled whole (`zoom`) to whichever of width and height runs out first — a phone gets the same amplifier seen from further away. The figure it is scaled by is the room divided by the head's own width, and that width is `--column`, declared, never measured: inside a scaled box the room reads as `room / scale` in the head's own units, so a measured width hands the scale back its own value and the head stays at its desktop size. That is how a phone came to be handed a 1180 px head, cut off at both edges. The head inside its slot, and no band wider than the window, are asserted from 360x740 up by `npm run test:studio`.

---

## 5. Signature element: the glass

GUILT's stained glass is lit by the signal. Its glow layer's opacity follows the output RMS posted by the worklet at 30 Hz, mapped from −60 to 0 dBFS, and falls to its unlit baseline when the engine stops or the amp is off. The relief and bloom are static SVG filters, rasterised once; only opacity moves.

The glass and the two meters are the whole visualisation layer. There is no spectrum analyser, no oscilloscope, no `AnalyserNode` and no `<canvas>` anywhere in the product. Under `prefers-reduced-motion` the glass holds a steady illumination.

On a pre-rendered preset page, the same illumination is driven by the RMS envelope computed at build time and animated from `audio.currentTime`, with no audio graph.

---

## 6. Components

**Knob.** A native `<input type="range">` under an SVG dial: keyboard, screen reader, vertical drag, a logarithmic taper for frequencies, an engineering-unit readout, double-click back to the preset's value. In the chain band it is the compact size, label beside it. Inside the head it takes the head's `--knob-accent`.

**Meters.** Two, input (peak, before the trim) and output (RMS). No peak-hold line, no printed scale. The clip colour is `--ember`.

**Segmented control.** Selected segment gets an underline, not a filled background.

**Latency.** Top right, always visible, Plex Mono, a number and nothing more.

**Mode tabs.** Display face, uppercase, the bar's full height; the chosen one in `--text`, the other in `--text-3`. One short lit line under the chosen mode glides to the other.

**Transport.** One plate, laid out as a DAW. The row, left to right: the keys (stop, play, record), the display, *Practice* (loop, speed, the tab's tracks — shown once a tab is open), *Looper* (its state beside the name), *Levels* (named beside its icon in Play on a wide screen). The display is a window set into the plate, darker than it and faintly lit: the tab's name and title, the take's state and time at its right, then elapsed time, the position groove, the length, the bar and the tempo — or, with no tab, *Open a tab* and *Write a tab*. Under the row, the tracks: a name and a level per lane, the lanes recessed like the display, and at their right the export mode, listening, export and the track tools. One button style (`.tc-button`) throughout: a key cut into the plate, its edge drawn by light rather than a box, icons drawn in SVG. Play is the one round filled key; record is a round dark key with an ember lamp. The tab's track list and the levels are native popovers, anchored above their button where CSS anchoring exists.

**Tab reader.** One line of bars, laid out horizontally, sliding under a playhead fixed at the centre of the window. Nothing scrolls vertically. The paper is the only light surface.

**The neck.** Under the tab, on the same paper: the track's own string count, always twenty-four evenly spaced frets, the sounding notes lit in the playhead's amber. No wood, no fretwire, no shadow.

**Dialogs.** Tuner, metronome, settings and welcome share `.tc-dialog`: one frame, one close, one entrance.

**Tutorial.** The whole screen goes dark and the real window being explained is lifted out of the shade by its z-index — never a copy, and it still works while it is explained. Beside the window on a desktop, a sheet at the foot of the screen on a phone. The shade is the screen: it is a child of the page like everything else, so any rule the page lays on its children reaches it, and a width meant for the column once left half the screen lit and clickable. Each step gives the focus to the card, not to its Next button: the card is labelled by the step's title and described by its body, so the step is what gets announced, and a step whose Next waits on something to do no longer drops the focus to the document. The arrows step through, as the swipe does by touch; Escape leaves. Focus is not trapped — the lit window is the real one, and it is meant to be used.

---

## 7. Motion

Motion is scarce and functional.

One curve, `--ease-out` (fast start, long settle), and two durations, `--dur-quick` for hover and `--dur-settle` for anything that arrives.

- **A change of mode** is the one authored moment: the stage's new occupant rises out of the dark (opacity, a few pixels, a hair of scale) and the bands' contents fade back as they take their new width. Width itself is never animated.
- **Dialogs** rise 16 px and fade in over 200 ms.
- **Popovers and menus** rise a few pixels as they fade in.
- **Lamps** warm up: their glow is a layer whose opacity rises, never an animated shadow. A taking record lamp becomes a square and breathes; no key ever blinks.
- **Knob drags** are never animated. Direct manipulation is 1:1 with the pointer.
- **The glass** is the only continuous animation.
- Only `transform` and `opacity` animate. Never `backdrop-filter`, an animated `filter` or an animated `box-shadow`.

Everything respects `prefers-reduced-motion`.

---

## 8. Quality floor

- Every control reachable and operable by keyboard, with a visible `--iris` focus ring.
- Interactive targets at least 36 px in the smaller dimension.
- Colour never carries information on its own: an active state also has a label, a lamp or a position.
- The main thread never blocks more than 8 ms. A component that cannot hold 30 fps is simplified.
- Empty and failure states are designed, not defaults.

---

## 9. Copy rules

- Amps and presets are named for what they sound like, never after real gear.
- Buttons name the outcome: "Copy tone link", not "Share".
- Errors state the cause and the fix in one sentence each.
- Never use the words: immersive, powerful, seamless, unleash, unlock, craft as a verb.
