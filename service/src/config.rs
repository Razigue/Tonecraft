//! The engine's device configuration, kept on the player's machine.
//!
//! The engine owns it, not the page: every tab that connects edits the same
//! one, so two tabs can never disagree about which interface is in use, and a
//! new tab finds the interface the player chose last time without asking.
//! Tone state is not here and never will be — that belongs to the page and to
//! tone links. This is hardware: which device, which buffer, how loud the
//! headphones are.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::audio::OpenRequest;

/// `None` everywhere means the engine's best choice: the preferred host, the
/// default devices, the device's rate, the smallest buffer, the first two
/// channels.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub host: Option<String>,
    pub input: Option<String>,
    pub output: Option<String>,
    pub sample_rate: Option<u32>,
    pub buffer_size: Option<u32>,
    pub input_channels: Option<Vec<u16>>,
    pub output_channels: Option<Vec<u16>>,
    /// Headphone level, 0..1, applied after the chain. See `audio.rs`.
    pub monitor: f32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: None,
            input: None,
            output: None,
            sample_rate: None,
            buffer_size: None,
            input_channels: None,
            output_channels: None,
            monitor: 1.0,
        }
    }
}

/// What a merge changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changes {
    /// Anything that needs the streams reopened.
    pub device: bool,
    /// The headphone level, which does not.
    pub monitor: bool,
}

impl Config {
    /// Where the configuration lives on this platform.
    pub fn path() -> Option<PathBuf> {
        let env = |k: &str| std::env::var_os(k).map(PathBuf::from);
        if cfg!(windows) {
            env("APPDATA").map(|p| p.join("Tonecraft").join("engine.json"))
        } else if cfg!(target_os = "macos") {
            env("HOME").map(|p| {
                p.join("Library")
                    .join("Application Support")
                    .join("Tonecraft")
                    .join("engine.json")
            })
        } else {
            env("XDG_CONFIG_HOME")
                .or_else(|| env("HOME").map(|p| p.join(".config")))
                .map(|p| p.join("tonecraft").join("engine.json"))
        }
    }

    /// The saved configuration, or the defaults when there is none or it is
    /// unreadable: a damaged file must never stop the engine from starting.
    pub fn load() -> Self {
        Self::path().map(|p| Self::load_from(&p)).unwrap_or_default()
    }

    pub fn load_from(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Self>(&s).ok())
            .map(Self::sane)
            .unwrap_or_default()
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::path().ok_or("no configuration directory on this system")?;
        self.save_to(&path)
    }

    /// Written aside and renamed over, so a crash mid-write leaves the old file.
    pub fn save_to(&self, path: &Path) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    }

    fn sane(mut self) -> Self {
        self.monitor = if self.monitor.is_finite() {
            self.monitor.clamp(0.0, 1.0)
        } else {
            1.0
        };
        self
    }

    /// Applies the fields a message names. Unknown fields are ignored, `null`
    /// returns a field to the engine's choice, and a malformed value refuses
    /// the whole change rather than half of it.
    pub fn merge(&mut self, fields: &Map<String, Value>) -> Result<Changes, String> {
        let Value::Object(mut all) = serde_json::to_value(&*self).map_err(|e| e.to_string())?
        else {
            return Err("configuration is not an object".into());
        };
        for (key, value) in fields {
            if all.contains_key(key) {
                all.insert(key.clone(), value.clone());
            }
        }
        let next: Self = serde_json::from_value(Value::Object(all))
            .map(Self::sane)
            .map_err(|e| format!("bad configuration: {e}"))?;
        let changes = Changes {
            device: next.devices() != self.devices(),
            monitor: next.monitor != self.monitor,
        };
        *self = next;
        Ok(changes)
    }

    fn devices(&self) -> Self {
        Self {
            monitor: 1.0,
            ..self.clone()
        }
    }

    pub fn request(&self) -> OpenRequest {
        OpenRequest {
            host: self.host.clone(),
            input: self.input.clone(),
            output: self.output.clone(),
            sample_rate: self.sample_rate,
            buffer_size: self.buffer_size,
            input_channels: self.input_channels.clone(),
            output_channels: self.output_channels.clone(),
        }
    }

    /// The configuration as a protocol message of the given type.
    pub fn message(&self, kind: &str) -> Value {
        let mut value = serde_json::to_value(self).unwrap_or(Value::Null);
        if let Value::Object(map) = &mut value {
            map.insert("type".into(), Value::String(kind.into()));
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn merge_tells_devices_from_level() {
        let mut c = Config::default();
        let ch = c.merge(&fields(json!({"monitor": 0.5}))).unwrap();
        assert_eq!(ch, Changes { device: false, monitor: true });
        let ch = c.merge(&fields(json!({"bufferSize": 64, "nonsense": 1}))).unwrap();
        assert_eq!(ch, Changes { device: true, monitor: false });
        assert_eq!(c.buffer_size, Some(64));
        // The same value again is not a change: nothing reopens for nothing.
        let ch = c.merge(&fields(json!({"bufferSize": 64}))).unwrap();
        assert_eq!(ch, Changes::default());
        // null gives the choice back to the engine.
        c.merge(&fields(json!({"bufferSize": null}))).unwrap();
        assert_eq!(c.buffer_size, None);
    }

    #[test]
    fn merge_refuses_nonsense_whole() {
        let mut c = Config::default();
        assert!(c.merge(&fields(json!({"bufferSize": "big", "monitor": 0.2}))).is_err());
        assert_eq!(c, Config::default());
        c.merge(&fields(json!({"monitor": 7}))).unwrap();
        assert_eq!(c.monitor, 1.0);
    }

    #[test]
    fn saves_and_loads() {
        let dir = std::env::temp_dir().join(format!("tonecraft-config-{}", std::process::id()));
        let path = dir.join("engine.json");
        let mut c = Config::default();
        c.merge(&fields(json!({"host": "asio", "input": "asio:X", "monitor": 0.25})))
            .unwrap();
        c.save_to(&path).unwrap();
        assert_eq!(Config::load_from(&path), c);
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(Config::load_from(&path), Config::default());
        let _ = std::fs::remove_dir_all(dir);
    }
}
