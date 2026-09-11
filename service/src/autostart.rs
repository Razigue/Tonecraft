//! Starting with the session. Per user, never system-wide, and never done
//! behind the player's back: only `--install-autostart` or the page's toggle
//! turn it on.

use std::path::PathBuf;

fn exe() -> Result<PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE: &str = "TonecraftEngine";
    // reg.exe is a console program; without this a window flashes up.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn reg(args: &[&str]) -> Result<bool, String> {
        Command::new("reg")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| o.status.success())
            .map_err(|e| e.to_string())
    }

    pub fn enabled() -> bool {
        reg(&["query", KEY, "/v", VALUE]).unwrap_or(false)
    }

    pub fn set(enable: bool) -> Result<(), String> {
        let ok = if enable {
            let command = format!("\"{}\" --background", super::exe()?.display());
            reg(&[
                "add", KEY, "/v", VALUE, "/t", "REG_SZ", "/d", &command, "/f",
            ])?
        } else {
            !enabled() || reg(&["delete", KEY, "/v", VALUE, "/f"])?
        };
        if ok {
            Ok(())
        } else {
            Err("the registry refused the change".into())
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::path::PathBuf;

    fn plist() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join("Library/LaunchAgents/com.tonecraft.engine.plist"))
    }

    pub fn enabled() -> bool {
        plist().is_some_and(|p| p.exists())
    }

    pub fn set(enable: bool) -> Result<(), String> {
        let path = plist().ok_or("HOME is not set")?;
        if !enable {
            return match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        let exe = super::exe()?;
        let body = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.tonecraft.engine</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>--background</string></array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
"#,
            exe.display()
        );
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, body).map_err(|e| e.to_string())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    use std::path::PathBuf;

    fn desktop() -> Option<PathBuf> {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
            .map(|c| c.join("autostart/tonecraft-engine.desktop"))
    }

    pub fn enabled() -> bool {
        desktop().is_some_and(|p| p.exists())
    }

    pub fn set(enable: bool) -> Result<(), String> {
        let path = desktop().ok_or("neither XDG_CONFIG_HOME nor HOME is set")?;
        if !enable {
            return match std::fs::remove_file(&path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            };
        }
        let body = format!(
            "[Desktop Entry]\nType=Application\nName=Tonecraft Engine\n\
             Comment=Runs Tonecraft on your audio interface\nExec=\"{}\" --background\n\
             Terminal=false\nX-GNOME-Autostart-enabled=true\n",
            super::exe()?.display()
        );
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&path, body).map_err(|e| e.to_string())
    }
}

pub fn enabled() -> bool {
    imp::enabled()
}

pub fn set(enable: bool) -> Result<(), String> {
    imp::set(enable)
}
