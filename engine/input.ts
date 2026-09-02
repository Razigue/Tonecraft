/**
 * Opening the input, and telling the truth about what was found.
 *
 * Split out of `engine.ts` so the constraints can be tested without a browser.
 * The flags below are the single most common failure mode for browser audio
 * applications and they fail silently: the signal simply arrives wrong, and the
 * user concludes the DSP is bad. A test that asserts them is worth more than a
 * comment saying they matter.
 */

/**
 * The WebRTC voice pipeline, off, explicitly and individually.
 *
 * Every one of these is ON by default in `getUserMedia`, and every one destroys
 * a guitar signal:
 *
 * - `echoCancellation` chews sustain and applies a time-varying filter
 * - `noiseSuppression` eats pick attack and the tail of every note
 * - `autoGainControl` fights the player's own volume knob, continuously
 * - `voiceIsolation` is built to keep speech and discard everything else
 *
 * `latency: 0` asks the browser for the smallest buffer it will give us — a
 * request, not a promise.
 *
 * **`channelCount` asks for two, as a preference rather than a requirement.**
 * This used to be a hard `1`, on the reasoning that the chain is mono. The
 * chain is mono, and stays mono — but the *capture* must not be, because a
 * two-input interface puts its instrument jack on the second channel. A
 * Scarlett Solo carries the XLR on the left and the instrument input on the
 * right, so asking for one channel makes the guitar unreachable on precisely
 * the hardware PRODUCT.md names as the primary audience's. Which channel
 * becomes the chain's input is chosen at the worklet boundary.
 *
 * `ideal` rather than `exact` so a genuinely mono device still opens.
 */
export const INPUT_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  voiceIsolation: false,
  channelCount: { ideal: 2 },
  latency: 0,
} as const;

/** The flags that must be false. Exported so the test cannot drift from the code. */
export const MUST_BE_DISABLED = [
  'echoCancellation',
  'noiseSuppression',
  'autoGainControl',
  'voiceIsolation',
] as const;

export type OpenInputFailure = 'permission-denied' | 'no-input-device';

export class InputError extends Error {
  constructor(readonly reason: OpenInputFailure, message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/**
 * Takes `MediaDevices` rather than reaching for the global, so a test can hand
 * in a stub and assert on what was actually requested.
 *
 * `deviceId` is `exact`: asking for a particular interface and silently getting
 * a different one is worse than failing, because the player would be hearing
 * the wrong input with no way to know it.
 */
export async function openInput(
  devices: MediaDevices,
  deviceId?: string,
): Promise<MediaStream> {
  try {
    return await devices.getUserMedia({
      audio: {
        ...INPUT_CONSTRAINTS,
        ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } }),
      } as MediaTrackConstraints,
      video: false,
    });
  } catch (cause) {
    const name = cause instanceof DOMException ? cause.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new InputError(
        'permission-denied',
        'Microphone access was refused. Allow it in the address bar and reload.',
      );
    }
    throw new InputError(
      'no-input-device',
      'No audio input found. Connect an interface and reload.',
    );
  }
}

// ---------------------------------------------------------------------------

/**
 * What kind of thing is on the other end of the cable.
 *
 * `guitar-usb` exists as its own kind for one reason: a 25 EUR guitar-to-USB
 * cable *is* a class-compliant interface and is fully supported (FR-13). It is
 * classified so the product can recognise it, never so it can be warned about.
 * The only kind that ever earns a remark is `onboard`, and even that is a
 * sentence of cause and a sentence of remedy, never a block — and it belongs to
 * story 1.13, not here.
 */
export type DeviceKind = 'interface' | 'guitar-usb' | 'onboard' | 'unknown';

const INTERFACE_HINTS = [
  'scarlett', 'focusrite', 'behringer', 'presonus', 'audiobox', 'steinberg',
  'motu', 'audient', 'ssl 2', 'zoom ', 'line 6', 'pod', 'helix', 'komplete audio',
  'babyface', 'fireface', 'clarett', 'volt',
];

const GUITAR_USB_HINTS = [
  'guitar link', 'guitarlink', 'rocksmith', 'ucg10', 'gi-', 'ua-',
  'guitar to usb', 'irig',
];

/**
 * Onboard inputs are the ones that will sound thin: a passive pickup wants a
 * 500 kΩ to 1 MΩ load and a laptop mic input offers a few kΩ plus a bias
 * voltage meant for an electret.
 */
const ONBOARD_HINTS = [
  'internal', 'built-in', 'builtin', 'intégré', 'integre', 'interne',
  'realtek', 'smart sound', 'microphone array', 'macbook', 'default - ',
];

export function classifyDevice(label: string): DeviceKind {
  const l = label.toLowerCase();
  // Checked before `interface`: some cables name a brand that also makes
  // interfaces, and a cable is the more specific answer.
  if (GUITAR_USB_HINTS.some((h) => l.includes(h))) return 'guitar-usb';
  if (INTERFACE_HINTS.some((h) => l.includes(h))) return 'interface';
  if (ONBOARD_HINTS.some((h) => l.includes(h))) return 'onboard';
  // "USB Audio CODEC" and friends: genuinely ambiguous, and cheap guitar cables
  // report exactly that. Unknown is the honest answer, and it carries no
  // warning — guessing "onboard" here would slander a supported device.
  return 'unknown';
}

export interface EnvironmentReport {
  readonly secureContext: boolean;
  readonly audioWorklet: boolean;
  readonly wasmSimd: boolean;
  /** Empty before permission is granted — browsers withhold labels until then. */
  readonly inputs: readonly { readonly id: string; readonly label: string; readonly kind: DeviceKind }[];
}

/** True if the engine could run here at all. Reported, never used to block. */
export function canRunEngine(report: EnvironmentReport): boolean {
  return report.secureContext && report.audioWorklet && report.wasmSimd;
}

/**
 * Probed before any engine loads (FR-7): no `AudioContext`, no WASM, no
 * microphone permission. Nothing here blocks and nothing here decides.
 */
export async function probeEnvironment(
  nav: Pick<Navigator, 'mediaDevices'>,
  isSecure: boolean,
  hasAudioWorklet: boolean,
): Promise<EnvironmentReport> {
  let inputs: EnvironmentReport['inputs'] = [];
  try {
    const devices = await nav.mediaDevices.enumerateDevices();
    inputs = devices
      .filter((d) => d.kind === 'audioinput')
      .map((d) => ({ id: d.deviceId, label: d.label, kind: classifyDevice(d.label) }));
  } catch {
    // Enumeration can fail outright in a hardened context. That is information,
    // not an error to surface — the player can still press start.
    inputs = [];
  }

  return {
    secureContext: isSecure,
    audioWorklet: hasAudioWorklet,
    wasmSimd: detectWasmSimd(),
    inputs,
  };
}

/**
 * SIMD is what makes the CPU budget reachable (NFR-14).
 *
 * A minimal module declaring `() -> v128` whose body is `i32.const 0`,
 * `i8x16.splat`, `i8x16.popcnt`. Both instructions are v128, so an engine
 * without SIMD fails validation. Relaxed SIMD is deliberately *not* probed:
 * AD-4 forbids it, so its availability is none of our business.
 */
export function detectWasmSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,  // magic, version
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,        // type: () -> v128
        0x03, 0x02, 0x01, 0x00,                          // one function
        0x0a, 0x0a, 0x01, 0x08, 0x00,                    // code, one body
        0x41, 0x00,                                      // i32.const 0
        0xfd, 0x0f,                                      // i8x16.splat
        0xfd, 0x62,                                      // i8x16.popcnt
        0x0b,                                            // end
      ]),
    );
  } catch {
    return false;
  }
}
