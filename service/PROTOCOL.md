# Tonecraft Engine — protocol

How the page at `https://razigue.github.io/Tonecraft/` (or `localhost` in
development) drives Tonecraft Engine, the native companion that runs the chain on
ASIO, CoreAudio or ALSA.

The rule that shapes everything here: **the engine knows nothing about the
sound.** It opens devices, runs `public/dsp/chain.wasm` — the file the page
itself runs in its AudioWorklet, uploaded by the page — and forwards `tc_*`
calls it does not interpret. Every feature of the sound lives in `dsp/` or in
`engine/engine.ts`, which is why a feature cannot exist in the browser and be
missing here.

## Transport

- WebSocket, `ws://127.0.0.1:47800/`. Loopback only; the engine never listens on
  another interface.
- **Origin allowlist.** The handshake is refused (HTTP 403) unless `Origin` is
  `https://razigue.github.io`, `http://localhost:<port>`,
  `http://127.0.0.1:<port>`, or an origin given with `--allow-origin`. Without
  this, any site open in the browser could drive the audio interface.
- One client at a time. A new connection replaces the old one, which receives
  `{"type":"replaced"}` and is closed: a reloaded tab takes over from itself.
- Text frames are JSON. Binary frames start with a one-byte kind.

## Page → engine

| Message | Meaning |
|---|---|
| `{"type":"hello","abi":1}` | First message. Answered by `hello`. |
| binary `0x01` + wasm bytes | The chain. Compiled (and cached by content hash), answered by `chain`. |
| `{"type":"devices","host":"asio"}` | Lists the host's devices. Answered by `devices`. |
| `{"type":"config"}` | Asks for the device configuration. Answered by `config`. |
| `{"type":"configure", ...}` | Changes any subset of the configuration (below). Saved; answered by `config`, and by `opened` with `"reopened": true` first when a device field changed while streams were open. |
| `{"type":"open", ...}` | Opens the streams and a fresh chain. Answered by `opened` or `error`. |
| `{"type":"close"}` | Stops the streams and drops the chain. Answered by `closed`. |
| `{"type":"call","id":7,"fn":"tc_set_param","args":[17,-12.4]}` | Calls a chain export. `id` is optional; with it, answered by `result`. |
| binary `0x02` + u32 LE header length + header JSON + payload | A call with a payload: header `{"id":7,"fn":"tc_set_ir","args":[0]}`. The engine copies the payload into the chain and calls `fn(pointer, byteLength, ...args)`. |
| `{"type":"tuner","on":true}` | Starts or stops streaming the tuner tap. |
| `{"type":"autostart","enabled":true}` | Starts with the session, or not. `null` only asks. Answered by `autostart`. |
| `{"type":"quit"}` | Exits the engine. |

`open`:

```json
{
  "type": "open",
  "host": "asio",
  "input": "asio:Focusrite USB ASIO",
  "output": "asio:Focusrite USB ASIO",
  "sampleRate": 48000,
  "bufferSize": 64,
  "inputChannels": [0, 1],
  "outputChannels": [0, 1]
}
```

Every field but `type` is optional. **The engine owns the device
configuration** (below): a field present in `open` is merged into it and saved,
and a missing one comes from it. `null` means the engine's choice: ASIO where
there is a driver (the platform's default host elsewhere), the host's default
device, the device's default rate, the **smallest buffer the device accepts**
(the lowest latency it offers — raising it is the player's call, when the
dropout count says so), the first two inputs, the first two outputs. The two
input channels become the chain's left and right, where the page's channel
choice (left, right, both, follow) applies as it does in the browser. The
chain's mono output is written to both output channels.

Calls made before `opened` are answered with an error: the chain is created by
`open` and dropped by `close`, and the page pushes its whole state after each
`opened`, exactly as it does after starting the browser engine. **That includes
an `opened` carrying `"reopened": true`**: the engine reopened the streams
itself after a `configure` changed a device, the chain is a new one, and it has
none of the page's state until the page sends it again.

## Configuration

```json
{
  "host": "asio",
  "input": "asio:Focusrite USB ASIO",
  "output": "asio:Focusrite USB ASIO",
  "sampleRate": null,
  "bufferSize": 64,
  "inputChannels": [0, 1],
  "outputChannels": [0, 1],
  "monitor": 0.8
}
```

Saved by the engine on the player's machine — `%APPDATA%\Tonecraft\engine.json`,
`~/Library/Application Support/Tonecraft/engine.json`, or
`$XDG_CONFIG_HOME/tonecraft/engine.json` — so every tab edits the same one and a
new tab finds the interface chosen last time. It is hardware, never tone: none
of it belongs in a tone link. The fields are those of `open`, plus:

- **`monitor`**, 0..1, default 1: the headphone level. Applied by the engine
  after the chain, attenuation only, gliding over 20 ms. It is the level of the
  player's headphones — what the operating system's volume is to the browser —
  so it lives here, not in the chain: a tone shared by link must sound the same
  on someone else's headphones at their own level. Clamped to 0..1, so the
  chain's limiter ceiling holds whatever is set. Changing it never reopens
  anything.

`configure` ignores fields it does not know, returns a field to the engine's
choice with `null`, and refuses a malformed value whole (`error` with context
`configure`), leaving the configuration as it was. Any change is followed by
`config` to the page.

Only exports matching `^tc_[a-z0-9_]+$` can be called. Arguments are converted
to the export's parameter types (`i32` or `f32`); a wrong count is an error.
Payloads are capped at 256 MB.

## Engine → page

| Message | Meaning |
|---|---|
| `{"type":"hello","version":"0.1.0","abi":1,"platform":"windows","hosts":[{"id":"asio","name":"ASIO"},{"id":"wasapi","name":"WASAPI"}],"chain":false,"config":{...}}` | `chain` says whether a chain is already compiled, so a reconnecting page can skip the upload. `config` is the saved configuration. |
| `{"type":"config", ...}` | The configuration, after `config` or any `configure`. |
| `{"type":"chain","ok":true}` / `{"type":"chain","ok":false,"message":"..."}` | |
| `{"type":"devices","host":"asio","inputs":[Device],"outputs":[Device]}` | |
| `{"type":"opened","sampleRate":48000,"bufferSize":64,"inputChannels":2,"outputChannels":2,"inputLatencyMs":1.9,"outputLatencyMs":2.4,"input":"Focusrite USB ASIO","output":"Focusrite USB ASIO"}` | Latencies as the driver reports them, buffer included. `inputLatencyMs` also counts any samples waiting between the input and output callbacks (zero on ASIO). |
| `{"type":"closed"}` | |
| `{"type":"result","id":7,"value":1}` / `{"type":"result","id":7,"value":0,"error":"..."}` | `error` carries `tc_last_error()` when `tc_load_model` fails. |
| `{"type":"meters","meters":[...],"dropouts":0}` | The chain's meter frame (`schema/chain.ts`), about 30 times a second, plus the dropout count since `opened`. Losing one changes nothing (AD-12). |
| binary `0x11` + f32 LE samples | Tuner tap, mono, at the chain's rate, while `tuner` is on. |
| `{"type":"autostart","enabled":true}` | |
| `{"type":"error","context":"open","message":"..."}` | `context` is the request that failed, or `stream` when a running stream dies (device unplugged). |
| `{"type":"replaced"}` | Another page took over. |

`Device`:

```json
{
  "id": "asio:Focusrite USB ASIO",
  "name": "Focusrite USB ASIO",
  "channels": 2,
  "sampleRates": [44100, 48000, 88200, 96000],
  "defaultRate": 48000,
  "bufferSizes": { "min": 16, "max": 1024 }
}
```

`bufferSizes` is `null` when the host cannot say.

## Latency

Nothing in the engine adds latency beyond the device's own buffers:

- the chain adds none (`npm run test:chain` asserts it);
- on ASIO, input and output are one driver callback: the input stream is
  registered first, so its block is processed and played in the same
  `bufferSwitch`;
- the ring between the input and output callbacks never holds more than one
  block: a backlog means the output would be late, so the oldest samples are
  dropped instead (and counted as a dropout) — on ASIO the backlog is zero;
- the buffer defaults to the smallest the device accepts.

## Dropouts

Counted by the engine, never inferred by the page (AD-12): an output callback
arriving more than one and a half buffers after the previous one, or finding
no input block to process.
