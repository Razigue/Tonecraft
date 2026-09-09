# `app/` — the Svelte island

Depends on `engine/` and `schema/`. Never touches the audio graph directly.

One island, one route, `client:only="svelte"`.

- `Rig.svelte` owns the studio layout and existing audio session state. Global controls and amplifier/cabinet/preset selectors sit above the amplifier head; source, device and file controls sit below it.
- `tokens.css` defines the neutral Tonecraft palette. Amplifier-specific materials and accents stay scoped to the head. GUILT is associated with the Lead capture, so editing a parameter does not remove its identity.
- `Knob.svelte` exposes a native range input with keyboard, pointer and touch support, a logarithmic frequency taper and engineering-unit readout. Double-click resets to schema defaults. The wire format remains engineering units.
- The GUILT stained-glass image comes from the supplied prototype. Its illumination uses existing output RMS meters, mapped from −60 to 0 dBFS; no microphone or second audio graph is created for visuals. Stopped, dry and unloaded states use the unlit baseline. Reduced motion keeps illumination steady.
- `Waveform.svelte` provides file seeking; `presets.ts` pairs a capture filename, cabinet and parameter values.
- `Fader.svelte` and `Module.svelte` are retained MVP components, no longer used by the studio layout.
