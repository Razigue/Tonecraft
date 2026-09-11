//! Devices, streams, and the audio thread.
//!
//! The chain lives inside the output stream's callback, moved in when the
//! streams open and dropped when they close. The control thread talks to it
//! only through lock-free single-producer rings: commands in; results, meter
//! frames, tuner samples and spent payloads out. Nothing in the steady-state
//! callback allocates, locks or logs.
//!
//! Latency, which the player asked above all not to lose:
//!
//! - the buffer defaults to the smallest the device accepts;
//! - on ASIO the input stream is registered first. asio-sys keeps stream
//!   callbacks in a `Vec` in registration order and runs them in that order
//!   inside one `bufferSwitch` (asio-sys 0.4.0, `buffer_switch_time_info`),
//!   so the block captured in a switch is processed and played in that same
//!   switch: nothing waits in the ring;
//! - the ring between the two callbacks never holds more than the block being
//!   played (ASIO) or one block of slack (hosts whose input and output run on
//!   separate clocks or threads). Anything older is dropped and counted: a
//!   late sample is worse than a missing one when you are playing along.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, FromSample, HostId, I24, SampleFormat, SizedSample, StreamConfig,
    SupportedBufferSize, SupportedStreamConfigRange,
};
use rtrb::{Consumer, Producer, RingBuffer};
use serde::{Deserialize, Serialize};

use crate::chain::{Chain, Export, MAX_ARGS};

const STANDARD_RATES: [u32; 6] = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000];

/// Enough for any meter frame the schema will plausibly grow to.
pub const MAX_METERS: usize = 64;

#[derive(Serialize)]
pub struct HostInfo {
    pub id: String,
    pub name: String,
}

pub fn hosts() -> Vec<HostInfo> {
    cpal::available_hosts()
        .into_iter()
        .map(|h| HostInfo {
            id: h.to_string(),
            name: h.name().to_string(),
        })
        .collect()
}

#[derive(Serialize)]
pub struct BufferRange {
    pub min: u32,
    pub max: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub channels: u16,
    pub sample_rates: Vec<u32>,
    pub default_rate: u32,
    pub buffer_sizes: Option<BufferRange>,
}

fn host(id: &str) -> Result<cpal::Host, String> {
    let hid: HostId = id
        .parse()
        .map_err(|_| format!("no audio host named {id} here"))?;
    cpal::host_from_id(hid).map_err(|e| e.to_string())
}

fn ranges(device: &cpal::Device, input: bool) -> Vec<SupportedStreamConfigRange> {
    let r = if input {
        device
            .supported_input_configs()
            .map(|c| c.collect::<Vec<_>>())
    } else {
        device
            .supported_output_configs()
            .map(|c| c.collect::<Vec<_>>())
    };
    r.unwrap_or_default()
}

fn buffer_range(ranges: &[SupportedStreamConfigRange]) -> Option<(u32, u32)> {
    ranges
        .iter()
        .fold(None, |acc, r| match (*r.buffer_size(), acc) {
            (SupportedBufferSize::Range { min, max }, None) => Some((min, max)),
            (SupportedBufferSize::Range { min, max }, Some((a, b))) => {
                Some((a.min(min), b.max(max)))
            }
            (SupportedBufferSize::Unknown, acc) => acc,
        })
}

fn describe(device: &cpal::Device, input: bool) -> Option<DeviceInfo> {
    let list = ranges(device, input);
    if list.is_empty() {
        return None;
    }
    let default = if input {
        device.default_input_config()
    } else {
        device.default_output_config()
    };
    let default_rate = default
        .map(|c| c.sample_rate())
        .unwrap_or_else(|_| list[0].max_sample_rate());
    let mut rates: Vec<u32> = STANDARD_RATES
        .iter()
        .copied()
        .filter(|&r| list.iter().any(|c| c.contains_rate(r)))
        .collect();
    if !rates.contains(&default_rate) {
        rates.push(default_rate);
        rates.sort_unstable();
    }
    Some(DeviceInfo {
        id: device.id().ok()?.to_string(),
        name: device
            .description()
            .map(|d| d.name().to_string())
            .unwrap_or_else(|_| "Audio device".into()),
        channels: list.iter().map(|c| c.channels()).max().unwrap_or(0),
        sample_rates: rates,
        default_rate,
        buffer_sizes: buffer_range(&list).map(|(min, max)| BufferRange { min, max }),
    })
}

pub fn devices(host_id: &str) -> Result<(Vec<DeviceInfo>, Vec<DeviceInfo>), String> {
    let host = host(host_id)?;
    let mut inputs = Vec::new();
    let mut outputs = Vec::new();
    for device in host.devices().map_err(|e| e.to_string())? {
        if let Some(d) = describe(&device, true) {
            inputs.push(d);
        }
        if let Some(d) = describe(&device, false) {
            outputs.push(d);
        }
    }
    Ok((inputs, outputs))
}

#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    /// `None`: ASIO where there is one, the platform's default host elsewhere.
    pub host: Option<String>,
    pub input: Option<String>,
    pub output: Option<String>,
    pub sample_rate: Option<u32>,
    pub buffer_size: Option<u32>,
    pub input_channels: Option<Vec<u16>>,
    pub output_channels: Option<Vec<u16>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    pub sample_rate: u32,
    pub buffer_size: Option<u32>,
    pub input_channels: u16,
    pub output_channels: u16,
    pub input_latency_ms: f64,
    pub output_latency_ms: f64,
    pub input: String,
    pub output: String,
}

/// A call for the audio thread. Fixed-size, so pushing it never allocates;
/// the payload, if any, was allocated by the control thread and goes back to
/// it through the garbage ring.
pub struct Command {
    pub func: u16,
    pub argc: u8,
    pub args: [f64; MAX_ARGS],
    pub id: Option<u32>,
    pub want_error: bool,
    pub payload: Option<Box<[u8]>>,
}

pub struct Reply {
    pub id: u32,
    pub value: f64,
    /// Only on failure, which is off the steady-state path.
    pub error: Option<String>,
}

pub struct MeterFrame {
    pub len: usize,
    pub values: [f32; MAX_METERS],
}

/// State both threads read. Atomics only.
#[derive(Default)]
pub struct Shared {
    pub dropouts: AtomicU32,
    pub tuner_on: AtomicBool,
    /// f32 bits, in ms: what the driver reports, buffer included.
    pub input_latency: AtomicU32,
    pub output_latency: AtomicU32,
    /// Frames waiting between the input and output callbacks after the last
    /// output callback: latency the ring added on top of the driver's.
    pub backlog: AtomicU32,
    pub started: AtomicBool,
    /// f32 bits, 0..1: the headphone level. See `OutputState::run`.
    pub monitor: AtomicU32,
}

impl Shared {
    fn latency(a: &AtomicU32) -> f64 {
        f32::from_bits(a.load(Ordering::Relaxed)) as f64
    }
}

/// An open pair of streams and the rings to the chain inside them.
pub struct Session {
    // The output stream owns the chain; dropped first, it stops pulling from
    // the input ring before the input stream goes away.
    _output: cpal::Stream,
    _input: cpal::Stream,
    pub commands: Producer<Command>,
    pub replies: Consumer<Reply>,
    pub meters: Consumer<MeterFrame>,
    pub tuner: Consumer<f32>,
    pub garbage: Consumer<Box<[u8]>>,
    pub errors: mpsc::Receiver<String>,
    pub shared: Arc<Shared>,
    pub exports: Vec<Export>,
    pub opened: Opened,
    rate: u32,
}

impl Session {
    /// The headphone level, 0..1. Takes effect within the next callback, gliding.
    pub fn set_monitor(&self, level: f32) {
        self.shared
            .monitor
            .store(level.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }

    /// The driver's latencies plus whatever waits in the ring, in ms.
    pub fn latencies(&self) -> (f64, f64) {
        let backlog = self.shared.backlog.load(Ordering::Relaxed) as f64 * 1e3 / self.rate as f64;
        (
            Shared::latency(&self.shared.input_latency) + backlog,
            Shared::latency(&self.shared.output_latency),
        )
    }
}

fn find_device(host: &cpal::Host, id: Option<&str>, input: bool) -> Result<cpal::Device, String> {
    match id {
        Some(id) => {
            let parsed: cpal::DeviceId =
                id.parse().map_err(|_| format!("{id} is not a device id"))?;
            host.device_by_id(&parsed)
                .ok_or_else(|| format!("{id} is not connected"))
        }
        None if input => host
            .default_input_device()
            .ok_or_else(|| "there is no input device".into()),
        None => host
            .default_output_device()
            .ok_or_else(|| "there is no output device".into()),
    }
}

/// A configuration with at least `need` channels at `rate`, preferring the
/// device's own default format: converting costs nothing, but a format the
/// driver has to convert itself can cost a buffer.
fn pick(
    device: &cpal::Device,
    input: bool,
    rate: u32,
    need: u16,
) -> Result<(SupportedStreamConfigRange, SampleFormat), String> {
    let list = ranges(device, input);
    let default = if input {
        device.default_input_config()
    } else {
        device.default_output_config()
    };
    let default_format = default.map(|c| c.sample_format()).ok();
    let fits: Vec<_> = list
        .into_iter()
        .filter(|r| r.channels() >= need && r.contains_rate(rate))
        .collect();
    let chosen = fits
        .iter()
        .find(|r| Some(r.sample_format()) == default_format)
        .or_else(|| fits.iter().find(|r| r.sample_format() == SampleFormat::F32))
        .or_else(|| fits.first())
        .copied()
        .ok_or_else(|| {
            format!(
                "the {} does not run {need} channel(s) at {rate} Hz",
                if input { "input" } else { "output" }
            )
        })?;
    Ok((chosen, chosen.sample_format()))
}

/// ASIO where the build has it and a driver is installed, since that is what
/// this program exists for; the platform's default host everywhere else.
pub fn preferred_host() -> String {
    let hosts = cpal::available_hosts();
    hosts
        .iter()
        .find(|h| h.name() == "ASIO")
        .map(|h| h.to_string())
        .unwrap_or_else(|| cpal::default_host().id().to_string())
}

pub fn open(
    req: OpenRequest,
    engine: &wasmtime::Engine,
    module: &wasmtime::Module,
    monitor: f32,
) -> Result<Session, String> {
    let host_id = req.host.clone().unwrap_or_else(preferred_host);
    let host = host(&host_id)?;
    let asio = host.id().name() == "ASIO";
    let in_dev = find_device(&host, req.input.as_deref(), true)?;
    let out_dev = find_device(&host, req.output.as_deref(), false)?;
    let in_id = in_dev.id().map(|i| i.to_string()).unwrap_or_default();
    let out_id = out_dev.id().map(|i| i.to_string()).unwrap_or_default();
    if asio && in_id != out_id {
        return Err(
            "ASIO drives one interface at a time: choose the same device for input and output"
                .into(),
        );
    }

    let in_pick: Vec<u16> = req.input_channels.clone().unwrap_or_else(|| vec![0, 1]);
    let out_pick: Vec<u16> = req.output_channels.clone().unwrap_or_else(|| vec![0, 1]);
    if in_pick.is_empty() || in_pick.len() > 2 || out_pick.is_empty() || out_pick.len() > 2 {
        return Err("choose one or two input channels and one or two output channels".into());
    }

    let in_max = ranges(&in_dev, true)
        .iter()
        .map(|r| r.channels())
        .max()
        .unwrap_or(0);
    let out_max = ranges(&out_dev, false)
        .iter()
        .map(|r| r.channels())
        .max()
        .unwrap_or(0);
    // The default "first two" shrinks to one on a mono device rather than failing.
    let in_pick: Vec<u16> = if req.input_channels.is_none() {
        in_pick.into_iter().filter(|&c| c < in_max).collect()
    } else {
        in_pick
    };
    let out_pick: Vec<u16> = if req.output_channels.is_none() {
        out_pick.into_iter().filter(|&c| c < out_max).collect()
    } else {
        out_pick
    };
    if in_pick.is_empty() || out_pick.is_empty() {
        return Err("the device has no channel to use".into());
    }

    let rate = match req.sample_rate {
        Some(r) => r,
        None => in_dev
            .default_input_config()
            .map(|c| c.sample_rate())
            .map_err(|e| e.to_string())?,
    };
    let in_need = in_pick.iter().max().copied().unwrap_or(0) + 1;
    let out_need = out_pick.iter().max().copied().unwrap_or(0) + 1;
    let (in_range, in_format) = pick(&in_dev, true, rate, in_need)?;
    let (out_range, out_format) = pick(&out_dev, false, rate, out_need)?;

    // The smallest buffer both directions accept, unless the player chose one.
    let accepted = |r: &SupportedStreamConfigRange| match *r.buffer_size() {
        SupportedBufferSize::Range { min, max } => Some((min, max)),
        SupportedBufferSize::Unknown => None,
    };
    let bounds = match (accepted(&in_range), accepted(&out_range)) {
        (Some((a, b)), Some((c, d))) => Some((a.max(c), b.min(d))),
        (Some(x), None) | (None, Some(x)) => Some(x),
        (None, None) => None,
    };
    let buffer = match (req.buffer_size, bounds) {
        (Some(n), Some((min, max))) => Some(n.clamp(min, max.max(min))),
        (Some(n), None) => Some(n),
        (None, Some((min, _))) => Some(min),
        (None, None) => None,
    };
    let buffer_size = buffer.map_or(BufferSize::Default, BufferSize::Fixed);
    let in_config = StreamConfig {
        channels: in_range.channels(),
        sample_rate: rate,
        buffer_size,
    };
    let out_config = StreamConfig {
        channels: out_range.channels(),
        sample_rate: rate,
        buffer_size,
    };

    // Hosts that do not honour a fixed size can call back with more; larger
    // callbacks are processed in chunks, so this only needs to be generous.
    let max_frames = buffer.map_or(4096, |n| (n as usize).max(128));
    let chain = Chain::new(engine, module, rate as f32, max_frames)?;
    let exports = chain.exports().to_vec();

    let ring_frames = max_frames.max(1024) * 8;
    let (in_tx, in_rx) = RingBuffer::<f32>::new(ring_frames * 2);
    let (cmd_tx, cmd_rx) = RingBuffer::<Command>::new(1024);
    let (reply_tx, reply_rx) = RingBuffer::<Reply>::new(1024);
    let (meter_tx, meter_rx) = RingBuffer::<MeterFrame>::new(64);
    let (tuner_tx, tuner_rx) = RingBuffer::<f32>::new(rate as usize);
    let (garbage_tx, garbage_rx) = RingBuffer::<Box<[u8]>>::new(1024);
    let (err_tx, err_rx) = mpsc::channel::<String>();
    let shared = Arc::new(Shared::default());
    let monitor = monitor.clamp(0.0, 1.0);
    shared.monitor.store(monitor.to_bits(), Ordering::Relaxed);

    let input = InputState {
        ring: in_tx,
        total: in_config.channels as usize,
        a: in_pick[0] as usize,
        b: in_pick.get(1).map(|&c| c as usize),
        shared: shared.clone(),
    };
    let output = OutputState {
        chain,
        commands: cmd_rx,
        replies: reply_tx,
        meters: meter_tx,
        tuner: tuner_tx,
        garbage: garbage_tx,
        input: in_rx,
        in_channels: in_pick.len(),
        total: out_config.channels as usize,
        pair: [
            out_pick[0] as usize,
            *out_pick.get(1).unwrap_or(&out_pick[0]) as usize,
        ],
        slack: if asio { 0 } else { 1 },
        rate: rate as f64,
        gain: monitor,
        // A 20 ms glide: a volume slider dragged fast must not zipper.
        gain_step: 1.0 - (-1.0 / (0.02 * rate as f64)).exp() as f32,
        last: None,
        started_at: None,
        shared: shared.clone(),
    };

    // Input first: on ASIO that is what puts its callback ahead of the output's
    // in every bufferSwitch (see the module comment).
    let input_stream = build_input(&in_dev, &in_config, in_format, input, err_tx.clone())?;
    let output_stream = build_output(&out_dev, &out_config, out_format, output, err_tx)?;
    input_stream.play().map_err(|e| e.to_string())?;
    output_stream.play().map_err(|e| e.to_string())?;

    // Latencies are only known once the driver has called back. A quarter of
    // a second is several hundred buffers at the sizes that matter.
    let until = Instant::now() + Duration::from_millis(250);
    while !shared.started.load(Ordering::Acquire) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(5));
    }

    let name = |d: &cpal::Device| {
        d.description()
            .map(|x| x.name().to_string())
            .unwrap_or_default()
    };
    let mut session = Session {
        _output: output_stream,
        _input: input_stream,
        commands: cmd_tx,
        replies: reply_rx,
        meters: meter_rx,
        tuner: tuner_rx,
        garbage: garbage_rx,
        errors: err_rx,
        shared,
        exports,
        opened: Opened {
            sample_rate: rate,
            buffer_size: buffer,
            input_channels: in_config.channels,
            output_channels: out_config.channels,
            input_latency_ms: 0.0,
            output_latency_ms: 0.0,
            input: name(&in_dev),
            output: name(&out_dev),
        },
        rate,
    };
    let (i, o) = session.latencies();
    session.opened.input_latency_ms = i;
    session.opened.output_latency_ms = o;
    Ok(session)
}

struct InputState {
    ring: Producer<f32>,
    total: usize,
    a: usize,
    b: Option<usize>,
    shared: Arc<Shared>,
}

impl InputState {
    fn run<T>(&mut self, data: &[T], info: &cpal::InputCallbackInfo)
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let ts = info.timestamp();
        if let Some(d) = ts.callback.checked_duration_since(ts.capture) {
            self.shared.input_latency.store(
                ((d.as_secs_f64() * 1e3) as f32).to_bits(),
                Ordering::Relaxed,
            );
        }
        let frames = data.len() / self.total.max(1);
        if self.ring.slots() < frames * 2 {
            // The output side has stopped pulling (or is badly late): what
            // cannot be kept is lost, and said so.
            self.shared.dropouts.fetch_add(1, Ordering::Relaxed);
            return;
        }
        if let Ok(mut chunk) = self.ring.write_chunk_uninit(frames * 2) {
            let (first, second) = chunk.as_mut_slices();
            let mut k = 0;
            for frame in data.chunks_exact(self.total) {
                let a: f32 = frame[self.a].to_sample();
                let b: f32 = self.b.map_or(0.0, |c| frame[c].to_sample());
                for v in [a, b] {
                    let slot = if k < first.len() {
                        &mut first[k]
                    } else {
                        &mut second[k - first.len()]
                    };
                    slot.write(v);
                    k += 1;
                }
            }
            // SAFETY: exactly frames * 2 slots were written above.
            unsafe { chunk.commit_all() };
        }
    }
}

struct OutputState {
    chain: Chain,
    commands: Consumer<Command>,
    replies: Producer<Reply>,
    meters: Producer<MeterFrame>,
    tuner: Producer<f32>,
    garbage: Producer<Box<[u8]>>,
    input: Consumer<f32>,
    in_channels: usize,
    total: usize,
    pair: [usize; 2],
    slack: usize,
    rate: f64,
    /// The headphone level as it glides towards `Shared::monitor`.
    gain: f32,
    gain_step: f32,
    last: Option<cpal::StreamInstant>,
    started_at: Option<cpal::StreamInstant>,
    shared: Arc<Shared>,
}

impl OutputState {
    fn commands(&mut self) {
        while let Ok(mut cmd) = self.commands.pop() {
            let payload = cmd.payload.take();
            let result = self.chain.call(
                cmd.func as usize,
                &cmd.args[..cmd.argc as usize],
                payload.as_deref(),
            );
            if let Some(id) = cmd.id {
                let reply = match result {
                    Ok(v) => Reply {
                        id,
                        value: v,
                        // Loading a capture is allowed to allocate: it
                        // already does, inside the chain, in both hosts.
                        error: (v == 0.0 && cmd.want_error).then(|| self.chain.last_error()),
                    },
                    Err(e) => Reply {
                        id,
                        value: 0.0,
                        error: Some(e.to_string()),
                    },
                };
                let _ = self.replies.push(reply);
            }
            if let Some(p) = payload {
                // Freed by the control thread, not here.
                let _ = self.garbage.push(p);
            }
        }
    }

    fn run<T>(&mut self, data: &mut [T], info: &cpal::OutputCallbackInfo)
    where
        T: SizedSample + FromSample<f32>,
    {
        self.commands();

        let frames = data.len() / self.total.max(1);
        let ts = info.timestamp();
        if let Some(d) = ts.playback.checked_duration_since(ts.callback) {
            self.shared.output_latency.store(
                ((d.as_secs_f64() * 1e3) as f32).to_bits(),
                Ordering::Relaxed,
            );
        }
        let started = *self.started_at.get_or_insert(ts.callback);
        // The first quarter second is the driver settling and, on hosts with
        // separate input and output threads, the ring filling for the first
        // time. Neither is a dropout the player caused or can fix.
        let settling = ts.callback.duration_since(started) < Duration::from_millis(250);
        let mut dropout = false;
        if let Some(prev) = self.last {
            let gap = ts.callback.duration_since(prev).as_secs_f64();
            if gap > 1.5 * frames as f64 / self.rate {
                dropout = true;
            }
        }
        self.last = Some(ts.callback);

        // The ring holds interleaved pairs. Keep the newest `frames` plus the
        // allowed slack; older samples would only make everything late.
        let available = self.input.slots() / 2;
        let keep = frames + self.slack * frames;
        if available > keep {
            let stale = (available - keep) * 2;
            if let Ok(chunk) = self.input.read_chunk(stale) {
                chunk.commit_all();
            }
            dropout = true;
        }
        let have = self.input.slots() / 2 >= frames;
        if !have {
            dropout = true;
        }

        /* The headphone level. Host-level on purpose: it is the level of the
           player's headphones — what the operating system's volume is to the
           browser — and not tone state, so it lives in the engine's config and
           never in a tone link. After the chain, attenuation only: clamped to
           0..1, so the limiter's ceiling still holds whatever is set. */
        let target = f32::from_bits(self.shared.monitor.load(Ordering::Relaxed)).clamp(0.0, 1.0);

        let max = self.chain.max_frames();
        let mut off = 0;
        while off < frames {
            let n = (frames - off).min(max);
            {
                let (a, b) = self.chain.inputs_mut();
                if have {
                    if let Ok(chunk) = self.input.read_chunk(n * 2) {
                        let (x, y) = chunk.as_slices();
                        for i in 0..n {
                            let at = |k: usize| if k < x.len() { x[k] } else { y[k - x.len()] };
                            a[i] = at(2 * i);
                            b[i] = at(2 * i + 1);
                        }
                        chunk.commit_all();
                    }
                } else {
                    // No input yet: the chain still runs, on silence, so its
                    // tails, meters and metronome keep going.
                    a[..n].fill(0.0);
                    b[..n].fill(0.0);
                }
            }
            let ready = self.chain.process(n, self.in_channels);
            let out = if self.chain.dead() {
                None
            } else {
                Some(self.chain.output())
            };
            for i in 0..n {
                self.gain += self.gain_step * (target - self.gain);
                let v = out.map_or(0.0, |o| o[i]) * self.gain;
                let frame = &mut data[(off + i) * self.total..(off + i + 1) * self.total];
                for (c, s) in frame.iter_mut().enumerate() {
                    *s = if c == self.pair[0] || c == self.pair[1] {
                        T::from_sample(v)
                    } else {
                        T::EQUILIBRIUM
                    };
                }
            }
            if ready {
                let m = self.chain.meters();
                let mut frame = MeterFrame {
                    len: m.len().min(MAX_METERS),
                    values: [0.0; MAX_METERS],
                };
                frame.values[..frame.len].copy_from_slice(&m[..frame.len]);
                let _ = self.meters.push(frame);
            }
            if self.shared.tuner_on.load(Ordering::Relaxed) {
                for &v in &self.chain.tuner()[..n] {
                    if self.tuner.push(v).is_err() {
                        break;
                    }
                }
            }
            off += n;
        }

        self.shared
            .backlog
            .store((self.input.slots() / 2) as u32, Ordering::Relaxed);
        if dropout && !settling {
            self.shared.dropouts.fetch_add(1, Ordering::Relaxed);
        }
        self.shared.started.store(true, Ordering::Release);
    }
}

macro_rules! by_format {
    ($format:expr, $build:ident, $($arg:expr),*) => {
        match $format {
            SampleFormat::F32 => $build::<f32>($($arg),*),
            SampleFormat::I16 => $build::<i16>($($arg),*),
            SampleFormat::I24 => $build::<I24>($($arg),*),
            SampleFormat::I32 => $build::<i32>($($arg),*),
            SampleFormat::F64 => $build::<f64>($($arg),*),
            SampleFormat::U16 => $build::<u16>($($arg),*),
            SampleFormat::U8 => $build::<u8>($($arg),*),
            SampleFormat::I8 => $build::<i8>($($arg),*),
            other => Err(format!("the device's sample format {other} is not supported")),
        }
    };
}

fn build_input(
    device: &cpal::Device,
    config: &StreamConfig,
    format: SampleFormat,
    state: InputState,
    errors: mpsc::Sender<String>,
) -> Result<cpal::Stream, String> {
    fn go<T>(
        device: &cpal::Device,
        config: &StreamConfig,
        mut state: InputState,
        errors: mpsc::Sender<String>,
    ) -> Result<cpal::Stream, String>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        device
            .build_input_stream::<T, _, _>(
                *config,
                move |data, info| state.run(data, info),
                move |e| {
                    let _ = errors.send(e.to_string());
                },
                None,
            )
            .map_err(|e| e.to_string())
    }
    by_format!(format, go, device, config, state, errors)
}

fn build_output(
    device: &cpal::Device,
    config: &StreamConfig,
    format: SampleFormat,
    state: OutputState,
    errors: mpsc::Sender<String>,
) -> Result<cpal::Stream, String> {
    fn go<T>(
        device: &cpal::Device,
        config: &StreamConfig,
        mut state: OutputState,
        errors: mpsc::Sender<String>,
    ) -> Result<cpal::Stream, String>
    where
        T: SizedSample + FromSample<f32>,
    {
        device
            .build_output_stream::<T, _, _>(
                *config,
                move |data, info| state.run(data, info),
                move |e| {
                    let _ = errors.send(e.to_string());
                },
                None,
            )
            .map_err(|e| e.to_string())
    }
    by_format!(format, go, device, config, state, errors)
}
