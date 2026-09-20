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

The studio plates stay dark; notation is read on light paper. GUILT's cabinet also catches light on its satin silver metal, confined to the amplifier object. The score's playhead and lit notes share one amber, the only hue the score owns.

`--ink`, `--chalk`, `--bone`, `--graphite` and `--celadon` survive as aliases for the landing page and older rules. New code uses the names above.

---

## 3. Typography

Four faces, self-hosted, subset, `woff2`, `font-display: swap`.

- **Display: Anybody**, width 125, uppercase, tracked. The wordmark, eyebrows, band and group labels.
- **Body: Onest**, one variable file, weight axis 400 and 500. Names, buttons, help, dialogs.
  It sets wider than the Inter Tight it replaced, so the page carries `--body-tracking: -0.015em`:
  a line reads at the density the studio was drawn at, and anything already tracked keeps its own.
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

**The home page stands in the same room.** Its hero and its closing banner are the nave, not the stained glass they used to be, and every screenshot on it is cut to its own silhouette — the amplifier to its cabinet and its lead, a band to the cabinet's corner — so nothing carries a second background inside a page that has one (`scripts/landing-shots.mjs`). No frame on them either: a rounded rectangle and a rectangle's drop shadow describe a rectangle that is no longer there.

**The room is a place, in Tone.** Behind everything, `public/images/bg-guilt.webp`: the nave the head is photographed in, blurred to the depth of field a lens would give it at that distance, so it reads as a place and never competes with the object in front of it. It is fixed to the window, under a scrim that keeps the bar and the transport on their dark surface, and it is Tone's alone — in Play the tab opens edge to edge and a cathedral under a score is noise. Static, 23 kB, decoded once; the only thing that moves over it is the violet light below.

**What floats wears the same material.** The dialogs — settings, welcome, tuner, metronome — and the panels that open from the bands are the shell's own, so they take the band's surface: the cabinet's corner, the light along its top lip, the wells its fields and its keys are cut into. Opaque, not 85 %, and unblurred: a band is a plate in a room and the room reads through it, but a dialog stands over a room that has already gone dark behind it. The tab reader's own panels are not shell and keep their score's white paper.

**Plates in a room.** The chain and the transport are plates of the faceplate material, floating with a `--gutter` of room around them, as the head does. In Tone they are exactly the head's column wide, so band, head and transport read as one object in the middle of a dark room; a static violet light behind the head brightens with the output, by opacity only. In Play they open to the full width with the tab. On a screen at least 900 px tall, the chain band in Tone takes full-size knobs, names above and values below; otherwise, and always in Play, it is the compact 80 px row.

**One key in the band holds the pedals.** The amplifier's plate is a map of seven engraved names and a lever, and three live stages — the transposer, the screamer's colour, the reverb — have no place on it. Drawing them onto a faceplate that was never engraved for them would be a lie about the object, and the band is full to the pixel. They open from one key instead, grouped as what they are in the chain: pedals. The boost keeps a switch in both places, because in Play the head is off screen and a stage must stay reachable from the band.

**The doubler closes the band, against the output.** It is the last stage before the output, so the two share one group with no seam between them. Full size, it is a knob with its lamp beside its name, as the gate is. Compact, the row has no room for a name, a value and a lamp side by side, and the selectors are what would pay for them: the name becomes the switch, over the dial — `DOUBLER ●`, as a pedal's name is in the pedals panel — and the dial keeps only its value in milliseconds, which it shows even where the other knobs drop theirs. In Play, where the power joins the row, it keeps only its lamp below a 1440 px window, for the same reason; its word stays in its name and its tooltip.

```
+--------------------------------------------------------------------------+
| TONECRAFT              [ TONE ]  PLAY                   12.4 ms   ⚙      |  bar, 56 px
+--------------------------------------------------------------------------+
| IN ▮ ◯  GATE ◯ ●  AMP [GUILT ▾] CAB [...▾]  ‹ PRESET › [⚙] DOUBLER ● ◯  ◯ ▮ OUT |  chain, 80 px
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

**The timeline is edited, not only looked at.** Dragging across the lanes selects a span; dragging a track's grip — a bar on the lane at the track's own start — moves that track in time, and the arrow keys nudge it by a tenth of a second, Shift by a hundredth, Home back to where it was recorded. With a span selected, *Cut* takes it out of every lane at once and closes the gap, as does Delete; one *Undo* puts back whichever of the two was last done. A track that has been moved leaves the room in front of it empty, and both gestures are what the export renders.

**The corners.** The tuner floats at the bottom left, the metronome at the bottom right with its start and tempo above it: small dark tiles with a hairline edge and a thin icon, a dot under a tile when it is on. A side room (`--side`) is kept for them in both modes, which is also why Play is wide without touching the window's edges. The bar alone spans that room, so the name and the settings never move with the mode. What still opens — the tab's track list, the levels — floats as a popover; notices sit over the top of the stage, under the chain.

**Width.** The studio is a desktop instrument; playing is not supported on a phone (`CLAUDE.md` §7). What is on a phone still has to be whole. Three thresholds, and nothing else changes:

- **Under 1100 px**, or under 900 px of height, the chain band drops its full knobs for its compact ones, and **under 1280 px** it wraps onto two lines. Squeezed onto one line instead, the selectors collapse to their chevrons and their names print over each other. The threshold was 1100 px until the doubler joined the band: its hundred pixels are what the selectors lost between the two. On one line, the preset gives up its width before the selectors do — they name what is playing, it names only where the tone started.
- **Under 760 px wide, or under 560 px high**, the studio stops being an instrument and becomes a page: the bands stack, the window scrolls, the corner tools come in out of the side room the page no longer keeps, and the last plate ends above them.
- **The head is never one of these thresholds.** It is one object at one size, scaled whole (`zoom`) to whichever of width and height runs out first — a phone gets the same amplifier seen from further away. The figure it is scaled by is the room divided by the head's own width, and that width is `--column`, declared, never measured: inside a scaled box the room reads as `room / scale` in the head's own units, so a measured width hands the scale back its own value and the head stays at its desktop size. That is how a phone came to be handed a 1180 px head, cut off at both edges. The head inside its slot, and no band wider than the window, are asserted from 360x740 up by `npm run test:studio`.

---

## 5. Signature element: the glass

GUILT's rose window, pointed arches and quatrefoils sit behind raised tracery, and the head is **one photograph** of a cast object, not a drawing of one: `public/images/guilt.webp` carries the cabinet, the handle, the tracery, the control plate with its engraved names, the signature and the lead that falls off the front. Building the same object out of CSS gradients took several hundred lines, and it never read as cast metal; the image does it in 210 kB, decoded once, off the audio path. Everything the DOM adds over it is something that has to move: seven indices turning on their own caps, the boost lever, the power rocker, and the two light layers below. The head is seen from slightly above, and every part obeys that one vantage — the top face shows, the handle stands on it, the feet show only their front edge, no side face is ever visible. The plate is the map: a control exists on the head only where the picture has a place engraved for it. See `docs/guilt-material-study.md` for the references and the prompt.

The stained glass is lit by the signal. Its glow layer's opacity follows the output RMS posted by the worklet at 30 Hz, mapped from −60 to 0 dBFS, and falls to its unlit baseline when the engine stops or the amp is off. The glass in the photograph is already lit, so switching the amplifier off lays black **over the glass alone**: two layers chroma-keyed out of the picture at build (`scripts/make-guilt-layers.mjs`), one black wherever the picture is violet, one the violet alone, blurred, screened back on. The silver keeps its studio lighting in both. The key ran as an SVG filter at first — a filter that never changes has no business running in the browser, so it runs once, at build, and ships as two small images. Only opacity moves.

The controls are placed in the picture's own pixels, so the plate and what sits on it cannot drift apart at any scale. A knob contributes one engraved index turning on a cap the picture already draws. **Both switches are photographs of themselves**, on and off, cross-faded: the boost lever aligned on the round escutcheon it turns on (`scripts/make-boost-switch.mjs`), the power rocker on the bezel it is bolted into, which its two renders already share to the pixel (`scripts/make-power-switch.mjs`). In each pair only which image is opaque changes, so the lever tips, the rocker tips, the lamp warms, and the metal under them does not move. The rocker was built in CSS first — a bezel, a face on a `perspective`, a lamp, fifteen declarations of gradients — and it never sat on the same surface as the plate, for the reason the whole head stopped being drawn.

The rocker owns the end of the plate, and the signature is centred in the gap it leaves between LEVEL and it. In the render the two overlapped: the signature ran to the cabinet's corner and the switch had to be squeezed over it. Moving it was not a re-render — the ink was lifted off the plate as a signed residual, the plate laid back flat, and the same residual added back 38 px to the left (`scripts/make-guilt-head.mjs`), so the signature on screen is the one that was drawn, down to the engraved lip that catches the light.

**Nothing on the head writes its value or its state.** A photograph of an amplifier has neither, and the plate is engraved with names already. Name and value come back only while a control is under the hand or under focus, in one tooltip (`.tc-tip` in `app/tokens.css`) shared by the knobs and both switches. A screen reader is told the same through `aria-label` and `aria-valuetext`, always.

The glass and the two meters are the whole visualisation layer. There is no spectrum analyser, no oscilloscope, no `AnalyserNode` and no `<canvas>` anywhere in the product. Under `prefers-reduced-motion` the glass holds a steady illumination.

On a pre-rendered preset page, the same illumination is driven by the RMS envelope computed at build time and animated from `audio.currentTime`, with no audio graph.

---

## 6. Components

**Knob.** A native `<input type="range">` under an SVG dial: keyboard, screen reader, vertical drag, a logarithmic taper for frequencies, an engineering-unit readout, double-click back to the preset's value. In the chain band it is the compact size, label beside it. Inside the head it takes the head's `--knob-accent`.

**Meters.** Two, input (peak, before the trim) and output (RMS). No peak-hold line, no printed scale. The clip colour is `--ember`.

**Segmented control.** Selected segment gets an underline, not a filled background.

**Latency.** Top right, always visible, Plex Mono, a number and nothing more.

**The metronome and the tab.** Synced, the tab starts the click on its first beat and stops it again when it pauses, stops, or reaches the last bar — the tab is what asked for the beat, and a click left ticking over a paused page is a sound nothing on screen claims. A click the player started themselves is theirs and is never taken away.

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
