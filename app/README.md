# `app/` — the Svelte island

Depends on `engine/`, `schema/` and `store/`. Never touches the audio graph directly.

The session — tone, capture, cabinet, devices, backend, metronome tempo and volume, loop level, file looping, the last DI take — is saved to IndexedDB through `store/` and restored at load. It pre-fills the rig; it never starts the engine or a sound. What the looper recorded is audio and is not among it.

One island, one route, `client:only="svelte"`.

- `Rig.svelte` owns the studio layout and existing audio session state. Global controls and amplifier/cabinet/preset selectors sit above the amplifier head; source, device and file controls sit below it.
- `tokens.css` defines the neutral Tonecraft palette. Amplifier-specific materials and accents stay scoped to the head. GUILT is associated with the Lead capture, so editing a parameter does not remove its identity.
- `Knob.svelte` exposes a native range input with keyboard support and vertical pointer/touch dragging, a logarithmic frequency taper and engineering-unit readout. Double-click restores the value from the last selected preset. The wire format remains engineering units.
- The GUILT stained-glass image comes from the supplied prototype. Its illumination uses existing output RMS meters, mapped from −60 to 0 dBFS; no microphone or second audio graph is created for visuals. Stopped, dry and unloaded states use the unlit baseline. Reduced motion keeps illumination steady.
- `Waveform.svelte` provides file seeking; `presets.ts` pairs a capture filename, cabinet and parameter values.
- `TabReader.svelte` imports GP3/4/5, GPX, GP, MusicXML (plain and zipped), Capella and alphaTex locally with lazy-loaded alphaTab — the accepted extensions are exactly the formats its `ScoreLoader` tries. Rendering is SVG, set explicitly rather than inherited from a default. Its independent score player provides track selection, solo/mute, speed, passage looping, tab/score views and focus mode. Each import builds a fresh `AlphaTabApi`: a layout finishing in alphaTab's worker is resolved against whatever score the api holds by then, so replacing the score under a render still in flight threw on bars that no longer existed; `destroy()` ends that worker and closes its audio context. The price is one soundfont decode per import, and every display setting is therefore passed in from the current state. The last valid score is kept in IndexedDB; malformed replacements leave it intact, because the file is parsed before anything on screen is touched. The Vite plugin supplies the local notation fonts and soundfont, including their licenses.
- `Recorder.svelte` keeps a five-minute mono DI take from the selected input and saves the last completed take locally. WAV export snapshots the Power switch and tone at the click: off exports untouched float32 DI; on renders the current chain in a worker, including effect tails. Score playback, the click and looper playback are excluded from recording.
- `Fader.svelte` and `Module.svelte` are retained MVP components, no longer used by the studio layout.

Welcome routes musicians directly to input settings. Testers use only the DI/file player, with no input enumeration or microphone access. Amplifier Power gates the entire output and live input through `Engine.setPowered`; it preserves the loaded DI and transport. It does not route the dry signal to the output.
