//! A log file, because a background program has nowhere else to say why it
//! refused a page or lost a device. Never written from the audio thread.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: Mutex<Option<File>> = Mutex::new(None);

/// Where logs go on this platform.
pub fn dir() -> Option<PathBuf> {
    let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
    if cfg!(windows) {
        env("LOCALAPPDATA").map(|p| p.join("Tonecraft").join("Engine"))
    } else if cfg!(target_os = "macos") {
        env("HOME").map(|p| p.join("Library").join("Logs").join("Tonecraft"))
    } else {
        env("XDG_STATE_HOME")
            .or_else(|| env("HOME").map(|p| p.join(".local").join("state")))
            .map(|p| p.join("tonecraft"))
    }
}

/// Opens the log, starting it over when it has grown past a megabyte.
pub fn init() -> Option<PathBuf> {
    let dir = dir()?;
    fs::create_dir_all(&dir).ok()?;
    let path = dir.join("engine.log");
    let big = fs::metadata(&path)
        .map(|m| m.len() > 1 << 20)
        .unwrap_or(false);
    let file = OpenOptions::new()
        .create(true)
        .append(!big)
        .write(true)
        .truncate(big)
        .open(&path)
        .ok()?;
    *FILE.lock().ok()? = Some(file);
    Some(path)
}

pub fn write(message: &str) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if cfg!(debug_assertions) {
        eprintln!("[{secs}] {message}");
    }
    if let Ok(mut guard) = FILE.lock()
        && let Some(file) = guard.as_mut()
    {
        let _ = writeln!(file, "[{secs}] {message}");
    }
}
