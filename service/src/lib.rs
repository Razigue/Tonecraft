//! Tonecraft Engine: runs Tonecraft's chain on ASIO, CoreAudio or ALSA,
//! controlled from the page over a loopback WebSocket.
//!
//! The engine knows nothing about the sound. It opens devices, runs
//! `public/dsp/chain.wasm` — the same file the browser runs in its
//! AudioWorklet, uploaded by the page — and forwards `tc_*` calls it does not
//! interpret. See `PROTOCOL.md`. On the player's machine it is one tray icon.

pub mod audio;
pub mod autostart;
pub mod b64;
pub mod browser;
pub mod chain;
pub mod config;
pub mod log;
pub mod render;
pub mod server;
pub mod tray;
