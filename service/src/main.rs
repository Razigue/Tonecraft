// A release build on Windows is a background program: no console window to
// flash up at login, or to close by accident and take the audio with it.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::process::ExitCode;

use tonecraft_engine::{autostart, browser, log, render, server, tray};

const HELP: &str = "\
Tonecraft Engine — runs Tonecraft's chain on ASIO, CoreAudio or ALSA.
It lives as one tray icon; everything is set from Tonecraft in the browser.

Usage:
  tonecraft-engine [--port N] [--allow-origin ORIGIN]... [--headless]
  tonecraft-engine --install-autostart | --uninstall-autostart
  tonecraft-engine render --wasm FILE --rate HZ --block N --channels C \\
                          --input IN.f32 --calls CALLS.json --output OUT.f32
  tonecraft-engine --version | --help

Options:
  --port N               loopback port to listen on (default 47800)
  --allow-origin ORIGIN  also accept pages from ORIGIN, e.g. https://example.org
  --headless             no tray icon (servers, tests)
  --background           started at login; changes nothing: it always starts minimised
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("render") {
        return match render::main(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("render: {e}");
                ExitCode::FAILURE
            }
        };
    }

    let mut options = server::Options::default();
    let mut headless = false;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--version" | "-V" => {
                println!("tonecraft-engine {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            "--help" | "-h" => {
                print!("{HELP}");
                return ExitCode::SUCCESS;
            }
            "--background" => {}
            "--headless" => headless = true,
            "--install-autostart" | "--uninstall-autostart" => {
                let enable = args[i] == "--install-autostart";
                return match autostart::set(enable) {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(e) => {
                        eprintln!("autostart: {e}");
                        ExitCode::FAILURE
                    }
                };
            }
            "--port" => {
                i += 1;
                match args.get(i).and_then(|p| p.parse().ok()) {
                    Some(port) => options.port = port,
                    None => {
                        eprintln!("--port needs a number");
                        return ExitCode::FAILURE;
                    }
                }
            }
            "--allow-origin" => {
                i += 1;
                match args.get(i) {
                    Some(origin) => options
                        .origins
                        .push(origin.trim_end_matches('/').to_ascii_lowercase()),
                    None => {
                        eprintln!("--allow-origin needs an origin");
                        return ExitCode::FAILURE;
                    }
                }
            }
            other => {
                eprintln!("unknown argument: {other}\n\n{HELP}");
                return ExitCode::FAILURE;
            }
        }
        i += 1;
    }

    if let Some(path) = log::init() {
        log::write(&format!(
            "tonecraft-engine {} starting, log at {}",
            env!("CARGO_PKG_VERSION"),
            path.display()
        ));
    }
    let listener = match server::bind(options.port) {
        Ok(l) => l,
        // Already running: the port is the single-instance lock. Launching it
        // again is the player looking for it, and what they are looking for is
        // Tonecraft — so that is what opens, and this second copy leaves.
        Err(server::RunError::AlreadyRunning) => {
            log::write("another instance holds the port; opening Tonecraft and exiting");
            if !headless {
                browser::open(browser::PAGE);
            }
            return ExitCode::SUCCESS;
        }
        Err(server::RunError::Other(e)) => {
            log::write(&format!("fatal: {e}"));
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    if headless {
        return match server::serve(listener, options.origins, None) {
            Ok(()) => ExitCode::SUCCESS,
            Err(server::RunError::AlreadyRunning) => ExitCode::SUCCESS,
            Err(server::RunError::Other(e)) => {
                log::write(&format!("fatal: {e}"));
                eprintln!("{e}");
                ExitCode::FAILURE
            }
        };
    }
    tray::run(listener, options.origins)
}
