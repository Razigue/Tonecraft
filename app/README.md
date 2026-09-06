# `app/` — the Svelte island

**Depends on `engine/` and `schema/`. Never touches the audio graph directly.**

One island, one route, `client:only="svelte"`. `DESIGN.md` is the source of
truth for anything visual; `tokens.css` is its only home in code, and no
component may hardcode a value.

- `Rig.svelte` — the chain is the interface: the signal path runs left to right
  in the order the audio travels. The amp and the cab carry no fader, because a
  capture is a frozen snapshot and inventing a knob that did nothing would be a
  lie about what it is.
- `Fader.svelte` — the one continuous control. **The taper lives here and only
  here**: the wire format carries engineering units, so retuning a taper changes
  how a fader feels and cannot change what an existing tone sounds like.
- `Waveform.svelte` — SVG, not a canvas, for the same reason nothing else in the
  product is a canvas.
- `presets.ts` — a capture, a cabinet and a set of values in engineering units.
  A preset names a capture **file**, never an index.
