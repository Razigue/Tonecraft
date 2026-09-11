# `app/` — the Svelte island

Depends on `engine/`, `schema/` and `store/`. Never touches the audio graph directly.

The session — tone, capture, cabinet, devices, backend, metronome tempo and volume, loop, the last DI take — is saved to IndexedDB through `store/` and restored at load. It pre-fills the rig; it never starts the engine or a sound.

One island, one route, `client:only="svelte"`.

- `Rig.svelte` owns the studio layout and existing audio session state. Global controls and amplifier/cabinet/preset selectors sit above the amplifier head; source, device and file controls sit below it.
- `tokens.css` defines the neutral Tonecraft palette. Amplifier-specific materials and accents stay scoped to the head. GUILT is associated with the Lead capture, so editing a parameter does not remove its identity.
- `Knob.svelte` exposes a native range input with keyboard support and vertical pointer/touch dragging, a logarithmic frequency taper and engineering-unit readout. Double-click restores the value from the last selected preset. The wire format remains engineering units.
- The GUILT stained-glass image comes from the supplied prototype. Its illumination uses existing output RMS meters, mapped from −60 to 0 dBFS; no microphone or second audio graph is created for visuals. Stopped, dry and unloaded states use the unlit baseline. Reduced motion keeps illumination steady.
- `Waveform.svelte` provides file seeking; `presets.ts` pairs a capture filename, cabinet and parameter values.
- `Fader.svelte` and `Module.svelte` are retained MVP components, no longer used by the studio layout.

Welcome routes musicians directly to input settings. Testers use only the DI/file player, with no input enumeration or microphone access. Amplifier Power gates the entire output and live input through `Engine.setPowered`; it preserves the loaded DI and transport. It does not route the dry signal to the output.
