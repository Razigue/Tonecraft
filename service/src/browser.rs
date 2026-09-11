//! Opening Tonecraft in the player's browser. The page is the interface; the
//! engine only ever sends the player there.

/// Where Tonecraft lives.
pub const PAGE: &str = "https://razigue.github.io/Tonecraft/";

/// Opens `url` in the default browser. Best effort: there is no one to tell
/// if it fails, and the icon is still there to try again.
pub fn open(url: &str) {
    let result = spawn(url);
    if let Err(e) = result {
        crate::log::write(&format!("could not open {url}: {e}"));
    }
}

#[cfg(windows)]
fn spawn(url: &str) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    // `start` is a cmd built-in; without this a console flashes up.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/c", "start", "", url])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn(url: &str) -> std::io::Result<()> {
    std::process::Command::new("open").arg(url).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn(url: &str) -> std::io::Result<()> {
    std::process::Command::new("xdg-open")
        .arg(url)
        .spawn()
        .map(|_| ())
}
