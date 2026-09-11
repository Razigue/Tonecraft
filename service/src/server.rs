//! The page's side door: a WebSocket on loopback, and the control thread
//! behind it. Protocol in `PROTOCOL.md`.
//!
//! Security model: the engine listens on 127.0.0.1 only, so nothing off the
//! machine can reach it; and it refuses every handshake whose `Origin` is not
//! Tonecraft's, so no other site open in the browser can drive the audio
//! interface. The chain it runs is sandboxed WebAssembly, and only its
//! `tc_*` exports can be called.

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

use crate::audio::{self, Command, OpenRequest, Session};
use crate::chain::{Compiler, Kind, MAX_ARGS};
use crate::config::Config;
use crate::{autostart, log};

pub const DEFAULT_PORT: u16 = 47800;
const MAX_PAYLOAD: usize = 256 << 20;
/// Tuner samples per binary frame: about 21 ms at 48 kHz, one display frame.
const TUNER_FRAME: usize = 1024;
/// How long an engine the player launched outlives the last page. A reload
/// reconnects within a couple of seconds (the settings sheet connects at load
/// when the engine is the chosen backend); a closed tab never does.
const GRACE: Duration = Duration::from_secs(10);

pub struct Options {
    pub port: u16,
    /// Extra origins, lower case, no trailing slash.
    pub origins: Vec<String>,
    /// Stays running with no page: started at login, or headless. Otherwise
    /// the engine leaves `GRACE` after the last page does.
    pub resident: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            origins: Vec::new(),
            resident: false,
        }
    }
}

pub enum RunError {
    AlreadyRunning,
    Other(String),
}

/// How the tray talks to the control loop, when there is a tray.
pub struct Hooks {
    /// Called when a page connects (true) or the last one leaves (false).
    pub on_connected: Box<dyn Fn(bool) + Send>,
    /// Set by the tray's Quit: the control loop stops the streams and returns.
    pub quit: Arc<AtomicBool>,
}

/// Whether a page at `origin` may connect.
pub fn allowed(origin: &str, extra: &[String]) -> bool {
    let origin = origin.trim_end_matches('/').to_ascii_lowercase();
    if origin == "https://razigue.github.io" || extra.contains(&origin) {
        return true;
    }
    // Development: any port on the loopback names, and nothing else.
    for base in ["http://localhost", "http://127.0.0.1"] {
        if let Some(rest) = origin.strip_prefix(base)
            && (rest.is_empty()
                || rest
                    .strip_prefix(':')
                    .is_some_and(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())))
        {
            return true;
        }
    }
    false
}

fn config() -> WebSocketConfig {
    let mut c = WebSocketConfig::default();
    // A take is decoded to float32 by the page: a long one is tens of MB.
    c.max_message_size = Some(MAX_PAYLOAD + (1 << 20));
    c.max_frame_size = Some(MAX_PAYLOAD + (1 << 20));
    c
}

/// Takes the port. Doing it before anything else is what makes the port the
/// single-instance lock: a second copy learns it is second before it has
/// shown anything.
pub fn bind(port: u16) -> Result<TcpListener, RunError> {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(l) => {
            log::write(&format!("listening on ws://127.0.0.1:{port}"));
            Ok(l)
        }
        Err(e) if e.kind() == ErrorKind::AddrInUse => Err(RunError::AlreadyRunning),
        Err(e) => Err(RunError::Other(format!("cannot listen on port {port}: {e}"))),
    }
}

/// Binds and serves on this thread, with no tray.
pub fn run(options: Options) -> Result<(), RunError> {
    serve(bind(options.port)?, options.origins, options.resident, None)
}

// tungstenite's refusal type is large; it is built once per refused handshake.
#[allow(clippy::result_large_err)]
pub fn serve(
    listener: TcpListener,
    origins: Vec<String>,
    resident: bool,
    hooks: Option<Hooks>,
) -> Result<(), RunError> {
    let (tx, rx) = mpsc::channel::<WebSocket<TcpStream>>();
    std::thread::Builder::new()
        .name("accept".into())
        .spawn(move || {
            for stream in listener.incoming().flatten() {
                // A client that never finishes its handshake must not hold the door.
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let check = |req: &Request, resp: Response| -> Result<Response, ErrorResponse> {
                    let origin = req
                        .headers()
                        .get("origin")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    if allowed(origin, &origins) {
                        Ok(resp)
                    } else {
                        log::write(&format!("refused a page from {origin:?}"));
                        let mut refusal = ErrorResponse::new(Some(
                            "this origin may not use Tonecraft Engine".into(),
                        ));
                        *refusal.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
                        Err(refusal)
                    }
                };
                match tungstenite::accept_hdr_with_config(stream, check, Some(config())) {
                    Ok(ws) => {
                        let _ = ws.get_ref().set_read_timeout(None);
                        let _ = ws.get_ref().set_nodelay(true);
                        if ws.get_ref().set_nonblocking(true).is_ok() && tx.send(ws).is_err() {
                            return;
                        }
                    }
                    Err(e) => log::write(&format!("handshake failed: {e}")),
                }
            }
        })
        .map_err(|e| RunError::Other(e.to_string()))?;

    let mut control = Control::new(hooks).map_err(RunError::Other)?;
    loop {
        while let Ok(ws) = rx.try_recv() {
            control.adopt(ws);
        }
        let busy = control.read();
        control.pump();
        control.report();
        if !resident && control.alone_since.is_some_and(|t| t.elapsed() >= GRACE) {
            log::write("no page came back: leaving");
            control.quit = true;
        }
        if control
            .hooks
            .as_ref()
            .is_some_and(|h| h.quit.load(Ordering::Relaxed))
        {
            log::write("quit from the tray");
            control.session = None;
            control.quit = true;
        }
        if control.quit {
            control.flush();
            return Ok(());
        }
        if !busy {
            // The control thread is not on the audio path: a couple of
            // milliseconds of polling costs nothing audible and keeps meter
            // frames flowing at their own 30 Hz.
            std::thread::sleep(Duration::from_millis(2));
        }
    }
}

struct Control {
    client: Option<WebSocket<TcpStream>>,
    compiler: Compiler,
    session: Option<Session>,
    /// The device configuration: the engine's own, saved on this machine.
    config: Config,
    hooks: Option<Hooks>,
    /// Whether a page was connected at the last report to the tray.
    connected: bool,
    /// When the last page left, while none has come back. Never set before a
    /// first page: an engine launched ahead of the site waits for it.
    alone_since: Option<Instant>,
    tuner_on: bool,
    tuner: Vec<f32>,
    quit: bool,
}

fn is_would_block(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if io.kind() == ErrorKind::WouldBlock)
}

impl Control {
    fn new(hooks: Option<Hooks>) -> Result<Self, String> {
        Ok(Self {
            client: None,
            compiler: Compiler::new()?,
            session: None,
            config: Config::load(),
            hooks,
            connected: false,
            alone_since: None,
            tuner_on: false,
            tuner: Vec::with_capacity(TUNER_FRAME),
            quit: false,
        })
    }

    /// Acts when a page arrives or leaves, and only then.
    ///
    /// A page leaving takes the sound with it: the streams stop at once, so a
    /// closed tab never leaves the guitar playing in the headphones with
    /// nothing on screen to stop it, nor the ASIO driver held away from every
    /// other program. A reloaded page reopens them when the player starts
    /// again, exactly as after a first connection.
    fn report(&mut self) {
        let now = self.client.is_some();
        if now == self.connected {
            return;
        }
        self.connected = now;
        if now {
            self.alone_since = None;
        } else {
            log::write("no page connected: streams stopped");
            self.session = None;
            self.tuner_on = false;
            self.tuner.clear();
            self.alone_since = Some(Instant::now());
        }
        if let Some(h) = &self.hooks {
            (h.on_connected)(now);
        }
    }

    fn save(&mut self) {
        if let Err(e) = self.config.save() {
            log::write(&format!("configuration not saved: {e}"));
            self.error("configure", format!("the configuration could not be saved: {e}"));
        }
    }

    fn send_config(&mut self) {
        let message = self.config.message("config");
        self.json(message);
    }

    /// Applies the fields a page sent: saved, the headphone level at once, and
    /// the streams reopened when a device changed while they were running.
    fn configure(&mut self, msg: Value) {
        let Value::Object(mut fields) = msg else {
            return self.error("configure", "not an object");
        };
        fields.remove("type");
        let changes = match self.config.merge(&fields) {
            Ok(c) => c,
            Err(e) => return self.error("configure", e),
        };
        self.save();
        if changes.monitor
            && let Some(s) = &self.session
        {
            s.set_monitor(self.config.monitor);
        }
        if changes.device && self.session.is_some() {
            self.start(true);
        }
        self.send_config();
    }

    fn adopt(&mut self, ws: WebSocket<TcpStream>) {
        // A second tab takes over from the first. The streams keep running:
        // the new page decides whether to reopen them. (A closed or reloaded
        // tab is a page leaving, not this: see `report`.)
        if let Some(mut old) = self.client.take() {
            let _ = old.send(Message::text(json!({"type": "replaced"}).to_string()));
            let _ = old.close(None);
            let _ = old.flush();
        }
        log::write("a page connected");
        self.client = Some(ws);
    }

    fn send(&mut self, message: Message) {
        let Some(ws) = self.client.as_mut() else {
            return;
        };
        match ws.write(message) {
            Ok(()) => {}
            // Queued; flushed on the next pass.
            Err(e) if is_would_block(&e) => {}
            Err(_) => self.client = None,
        }
    }

    fn json(&mut self, value: Value) {
        self.send(Message::text(value.to_string()));
    }

    fn error(&mut self, context: &str, message: impl std::fmt::Display) {
        self.json(json!({"type": "error", "context": context, "message": message.to_string()}));
    }

    fn flush(&mut self) {
        if let Some(ws) = self.client.as_mut()
            && let Err(e) = ws.flush()
            && !is_would_block(&e)
        {
            self.client = None;
        }
    }

    /// Reads one message if there is one. Returns whether there was.
    fn read(&mut self) -> bool {
        let Some(ws) = self.client.as_mut() else {
            return false;
        };
        match ws.read() {
            Ok(Message::Text(text)) => {
                let text = text.to_string();
                self.text(&text);
                true
            }
            Ok(Message::Binary(bytes)) => {
                self.binary(bytes.to_vec());
                true
            }
            Ok(_) => true,
            Err(e) if is_would_block(&e) => false,
            Err(_) => {
                log::write("the page disconnected");
                self.client = None;
                false
            }
        }
    }

    fn text(&mut self, text: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else {
            return self.error("message", "not JSON");
        };
        match msg["type"].as_str().unwrap_or("") {
            "hello" => {
                let platform = if cfg!(windows) {
                    "windows"
                } else if cfg!(target_os = "macos") {
                    "macos"
                } else {
                    "linux"
                };
                let chain = self.compiler.module().is_some();
                let config = serde_json::to_value(&self.config).unwrap_or(Value::Null);
                self.json(json!({
                    "type": "hello",
                    "version": env!("CARGO_PKG_VERSION"),
                    "abi": crate::chain::ABI_VERSION,
                    "platform": platform,
                    "hosts": audio::hosts(),
                    "chain": chain,
                    "config": config,
                }));
            }
            "config" => self.send_config(),
            "configure" => self.configure(msg),
            "devices" => {
                let host = msg["host"].as_str().unwrap_or("").to_string();
                match audio::devices(&host) {
                    Ok((inputs, outputs)) => {
                        self.json(json!({"type": "devices", "host": host, "inputs": inputs, "outputs": outputs}))
                    }
                    Err(e) => self.error("devices", e),
                }
            }
            "open" => self.open(msg),
            "close" => {
                self.session = None;
                self.json(json!({"type": "closed"}));
            }
            "call" => {
                let id = msg["id"].as_u64().map(|v| v as u32);
                let name = msg["fn"].as_str().unwrap_or("").to_string();
                let args: Vec<f64> = msg["args"]
                    .as_array()
                    .map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect())
                    .unwrap_or_default();
                self.call(id, &name, &args, None);
            }
            "tuner" => {
                self.tuner_on = msg["on"].as_bool().unwrap_or(false);
                if let Some(s) = &self.session {
                    s.shared.tuner_on.store(self.tuner_on, Ordering::Relaxed);
                }
                self.tuner.clear();
            }
            "autostart" => {
                if let Some(enable) = msg["enabled"].as_bool()
                    && let Err(e) = autostart::set(enable)
                {
                    return self.error("autostart", e);
                }
                self.json(json!({"type": "autostart", "enabled": autostart::enabled()}));
            }
            "quit" => {
                log::write("the page asked to quit");
                self.session = None;
                self.quit = true;
            }
            other => self.error("message", format!("unknown message type {other:?}")),
        }
    }

    fn binary(&mut self, bytes: Vec<u8>) {
        match bytes.first() {
            Some(0x01) => {
                let result = self.compiler.compile(&bytes[1..]);
                match result {
                    Ok(_) => self.json(json!({"type": "chain", "ok": true})),
                    Err(e) => {
                        log::write(&format!("chain refused: {e}"));
                        self.json(json!({"type": "chain", "ok": false, "message": e}));
                    }
                }
            }
            Some(0x02) if bytes.len() >= 5 => {
                let len = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]) as usize;
                let Some(header) = bytes.get(5..5 + len) else {
                    return self.error("call", "truncated payload header");
                };
                let Ok(header) = serde_json::from_slice::<Value>(header) else {
                    return self.error("call", "payload header is not JSON");
                };
                let id = header["id"].as_u64().map(|v| v as u32);
                let name = header["fn"].as_str().unwrap_or("").to_string();
                let args: Vec<f64> = header["args"]
                    .as_array()
                    .map(|a| a.iter().map(|v| v.as_f64().unwrap_or(0.0)).collect())
                    .unwrap_or_default();
                let payload = bytes[5 + len..].to_vec();
                self.call(id, &name, &args, Some(payload));
            }
            _ => self.error("message", "unknown binary message"),
        }
    }

    /// Opens with the saved configuration. Whatever the message names is
    /// merged into it first and saved: the engine's configuration is the one
    /// place devices are chosen, whoever chooses them.
    fn open(&mut self, msg: Value) {
        if let Value::Object(mut fields) = msg {
            fields.remove("type");
            if let Err(e) = self.config.merge(&fields) {
                return self.error("open", e);
            }
            self.save();
        }
        self.start(false);
    }

    /// (Re)opens the streams and a fresh chain from the configuration.
    /// `reopened` tells the page the chain is new and needs its state again.
    fn start(&mut self, reopened: bool) {
        // The previous streams go first: on ASIO the driver is one per process.
        self.session = None;
        let req: OpenRequest = self.config.request();
        let Some(module) = self.compiler.module().cloned() else {
            return self.error("open", "upload the chain first");
        };
        match audio::open(req, self.compiler.engine(), &module, self.config.monitor) {
            Ok(session) => {
                session
                    .shared
                    .tuner_on
                    .store(self.tuner_on, Ordering::Relaxed);
                let opened = serde_json::to_value(&session.opened).unwrap_or(Value::Null);
                log::write(&format!("opened {opened}"));
                let mut reply = json!({"type": "opened"});
                if let (Some(r), Value::Object(o)) = (reply.as_object_mut(), opened) {
                    r.extend(o);
                    if reopened {
                        r.insert("reopened".into(), Value::Bool(true));
                    }
                }
                self.session = Some(session);
                self.json(reply);
            }
            Err(e) => {
                log::write(&format!("open failed: {e}"));
                self.error("open", e);
            }
        }
    }

    fn call(&mut self, id: Option<u32>, name: &str, args: &[f64], payload: Option<Vec<u8>>) {
        if let Err(e) = self.enqueue(id, name, args, payload) {
            match id {
                Some(id) => self.json(json!({"type": "result", "id": id, "value": 0, "error": e})),
                None => self.error("call", e),
            }
        }
    }

    fn enqueue(
        &mut self,
        id: Option<u32>,
        name: &str,
        args: &[f64],
        payload: Option<Vec<u8>>,
    ) -> Result<(), String> {
        let session = self
            .session
            .as_mut()
            .ok_or("no chain is running: open first")?;
        let index = session
            .exports
            .iter()
            .position(|e| e.name == name)
            .ok_or_else(|| format!("no chain export named {name}"))?;
        let export = &session.exports[index];
        let skip = if payload.is_some() { 2 } else { 0 };
        if export.params.len() != args.len() + skip {
            return Err(format!(
                "{name} takes {} argument(s)",
                export.params.len().saturating_sub(skip)
            ));
        }
        if skip == 2 && export.params[..2] != [Kind::I32, Kind::I32] {
            return Err(format!("{name} does not take a payload"));
        }
        if payload.as_ref().is_some_and(|p| p.len() > MAX_PAYLOAD) {
            return Err("payloads are capped at 256 MB".into());
        }
        let mut fixed = [0.0; MAX_ARGS];
        fixed[..args.len()].copy_from_slice(args);
        let command = Command {
            func: index as u16,
            argc: args.len() as u8,
            args: fixed,
            id,
            want_error: name == "tc_load_model",
            payload: payload.map(Vec::into_boxed_slice),
        };
        session
            .commands
            .push(command)
            .map_err(|_| "the engine is busy: try again".to_string())
    }

    /// Everything the audio thread produced since the last pass, to the page.
    fn pump(&mut self) {
        let Some(session) = self.session.as_mut() else {
            self.flush();
            return;
        };
        let mut out: Vec<Message> = Vec::new();
        while let Ok(reply) = session.replies.pop() {
            let mut v = json!({"type": "result", "id": reply.id, "value": reply.value});
            if let Some(e) = reply.error {
                v["error"] = Value::String(e);
            }
            out.push(Message::text(v.to_string()));
        }
        let dropouts = session.shared.dropouts.load(Ordering::Relaxed);
        while let Ok(frame) = session.meters.pop() {
            let meters: Vec<f32> = frame.values[..frame.len].to_vec();
            out.push(Message::text(
                json!({"type": "meters", "meters": meters, "dropouts": dropouts}).to_string(),
            ));
        }
        while let Ok(v) = session.tuner.pop() {
            if !self.tuner_on {
                continue;
            }
            self.tuner.push(v);
            if self.tuner.len() == TUNER_FRAME {
                let mut bytes = Vec::with_capacity(1 + TUNER_FRAME * 4);
                bytes.push(0x11);
                for s in &self.tuner {
                    bytes.extend_from_slice(&s.to_le_bytes());
                }
                self.tuner.clear();
                out.push(Message::binary(bytes));
            }
        }
        // Payloads the chain has finished with, freed here and not on the
        // audio thread.
        while session.garbage.pop().is_ok() {}
        let failed = session.errors.try_recv().ok();

        for m in out {
            self.send(m);
        }
        if let Some(e) = failed {
            // A stream that died (an unplugged interface) does not come back
            // by itself; the page reopens when the player says so.
            log::write(&format!("stream error: {e}"));
            self.session = None;
            self.error("stream", e);
        }
        self.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn origins() {
        let extra = vec!["https://tonecraft.example".to_string()];
        assert!(allowed("https://razigue.github.io", &[]));
        assert!(allowed("http://localhost:4321", &[]));
        assert!(allowed("http://127.0.0.1:8137", &[]));
        assert!(allowed("https://tonecraft.example", &extra));
        assert!(!allowed("https://evil.example", &[]));
        assert!(!allowed("http://localhost.evil.example", &[]));
        assert!(!allowed("http://localhost:4321@evil", &[]));
        assert!(!allowed("https://razigue.github.io.evil.example", &[]));
        assert!(!allowed("", &[]));
        assert!(!allowed("null", &[]));
    }
}
