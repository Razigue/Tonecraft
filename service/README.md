# Tonecraft Engine

A small background program that lets Tonecraft play through **ASIO** on
Windows — and through CoreAudio on macOS and ALSA on Linux — while the page in
the browser stays the interface.

## Why it exists

A browser cannot open an ASIO driver. On Windows that means the browser's audio
goes through the operating system's mixer, which adds tens of milliseconds a
guitarist feels under the fingers. Tonecraft Engine opens the interface
directly, runs the **same chain** the page runs — `public/dsp/chain.wasm`,
uploaded by the page itself — and sends the sound straight to the interface's
outputs. The page keeps every control, meter and preset; only the audio moves.

The engine knows nothing about the sound. It moves samples in and out of the
chain and forwards calls it does not interpret (`PROTOCOL.md`). A feature added
to Tonecraft is therefore in the engine the moment the page ships it, with
nothing to update here.

Without the engine, Tonecraft works exactly as before, in the browser.

## Install

Download the file for your system from the
[latest release](https://github.com/Razigue/Tonecraft/releases/latest), unzip
it, and run `tonecraft-engine`. It has no window: open Tonecraft, choose
**Tonecraft Engine** in the audio settings, and the page connects by itself.

- **Windows** — `tonecraft-engine-windows-x64.zip`. The program is not signed,
  so SmartScreen may say "Windows protected your PC": choose *More info*, then
  *Run anyway*. Install your interface's ASIO driver (Focusrite, Behringer,
  Steinberg…); ASIO4ALL also works.
- **macOS** — `tonecraft-engine-macos-universal.zip` (Apple silicon and Intel).
  The program is not notarised, so Gatekeeper blocks it on first launch. Either
  right-click it and choose *Open*, or run
  `xattr -d com.apple.quarantine tonecraft-engine` in the folder where you
  unzipped it. macOS asks for microphone access the first time an input is
  opened: allow it, or the engine hears silence.
- **Linux** — `tonecraft-engine-linux-x64.tar.gz`. Uses ALSA, which PipeWire
  and PulseAudio systems also provide.

### Start with the session

`tonecraft-engine --install-autostart` starts it at every login (the page
offers the same switch); `--uninstall-autostart` stops that. It is per user:
the Windows `Run` key in HKCU, a LaunchAgent on macOS, an XDG autostart entry
on Linux.

Logs: `%LOCALAPPDATA%\Tonecraft\Engine\engine.log`, `~/Library/Logs/Tonecraft/`,
or `~/.local/state/tonecraft/`.

## Latency

Nothing in the engine adds latency beyond the device's own buffers:

- the buffer defaults to the **smallest the device accepts**. Raise it in the
  page's settings only if the dropout count says so;
- on ASIO, the input and output are served by one driver callback. The input
  stream is registered first, and asio-sys runs stream callbacks in
  registration order inside each `bufferSwitch`, so a block is captured,
  processed and played in the same switch;
- between the input and output callbacks the engine keeps at most the block
  being played (ASIO) or one block of slack (hosts with separate input and
  output clocks). Anything older is dropped and counted as a dropout rather
  than allowed to make everything late;
- the chain itself adds none (`npm run test:chain`, `cargo test`).

The audio thread allocates nothing, takes no lock and writes no log: the chain
lives inside the output callback and talks to the rest of the program through
lock-free rings.

## Security

- It listens on `127.0.0.1` only: nothing off the machine can reach it.
- It refuses every WebSocket handshake whose `Origin` is not Tonecraft's
  (`https://razigue.github.io`, or `localhost` in development; add others with
  `--allow-origin`). Without that, any site open in the browser could drive the
  audio interface.
- What it runs is sandboxed WebAssembly, and only the chain's `tc_*` exports
  can be called.

Chrome may ask whether the page may "access devices on your local network" the
first time it connects: that is this loopback connection. Safari does not allow
a secure page to reach a local program at all; use Chrome, Edge or Firefox.

## Build

Rust 1.85 or later.

```sh
cargo build --release
```

On Windows, ASIO support needs LLVM (for `libclang`): install it and set
`LIBCLANG_PATH` to its `bin` directory if bindgen cannot find it. The ASIO SDK
is downloaded by the `asio-sys` build script. On Linux, install
`libasound2-dev`.

`cargo test` runs the chain from `../public/dsp/chain.wasm`, so build it first
(`npm run build:dsp` at the repository root).

`tonecraft-engine render …` runs a signal through the chain offline, through
the same code the live engine uses; the repository's cross-host parity test
compares it with the browser's worklet sample for sample.

## Licence

GPL-3.0-or-later (`LICENSE`). The ASIO SDK is used under Steinberg's GPLv3
licence option, which is what lets this program be distributed at all.
