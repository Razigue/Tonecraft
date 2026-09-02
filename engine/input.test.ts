/**
 * The test FR-8 asks for by name.
 *
 * These four flags are on by default and each one quietly ruins a guitar
 * signal. Nothing about the failure is visible: audio still arrives, it is just
 * wrong, and the user blames the engine. So this asserts the constraints the
 * engine actually passes to `getUserMedia` — not a copy of them — and fails if
 * any is missing or true.
 */

import {
  INPUT_CONSTRAINTS,
  MUST_BE_DISABLED,
  openInput,
  classifyDevice,
  probeEnvironment,
  detectWasmSimd,
  canRunEngine,
  InputError,
  type DeviceKind,
} from './input.ts';

const failures: string[] = [];
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) { console.log(`  ok    ${name}`); return; }
  failures.push(name);
  console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`);
};

// --- FR-8: the voice pipeline is off, in the call the engine really makes ---

let requested: MediaStreamConstraints | undefined;
const stubDevices = {
  async getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream> {
    requested = constraints;
    return {} as MediaStream;
  },
  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return [];
  },
} as unknown as MediaDevices;

await openInput(stubDevices);

const audio = requested?.audio;
check('getUserMedia is called with an audio constraint object',
  typeof audio === 'object' && audio !== null);

const constraints = audio as Record<string, unknown>;
for (const flag of MUST_BE_DISABLED) {
  check(`${flag} is present and explicitly false`,
    Object.prototype.hasOwnProperty.call(constraints, flag) && constraints[flag] === false,
    `got ${JSON.stringify(constraints[flag])}`);
}
check('channelCount is 1 — the chain is mono end to end',
  constraints['channelCount'] === 1, `got ${JSON.stringify(constraints['channelCount'])}`);
check('latency asks for 0',
  constraints['latency'] === 0, `got ${JSON.stringify(constraints['latency'])}`);
check('video is never requested',
  requested?.video === false);

// The exported constant and the call must not be allowed to drift apart.
check('the call passes exactly INPUT_CONSTRAINTS',
  JSON.stringify(constraints) === JSON.stringify(INPUT_CONSTRAINTS));

// --- failures name a cause and a fix, and never leak a DOMException ---------

const denied = {
  async getUserMedia(): Promise<MediaStream> {
    throw new DOMException('denied', 'NotAllowedError');
  },
} as unknown as MediaDevices;

let caught: unknown;
try { await openInput(denied); } catch (e) { caught = e; }
check('a refused permission becomes a stated cause and fix',
  caught instanceof InputError && caught.reason === 'permission-denied'
    && /\.\s/.test(caught.message));

const missing = {
  async getUserMedia(): Promise<MediaStream> {
    throw new DOMException('none', 'NotFoundError');
  },
} as unknown as MediaDevices;

caught = undefined;
try { await openInput(missing); } catch (e) { caught = e; }
check('a missing device becomes a stated cause and fix',
  caught instanceof InputError && caught.reason === 'no-input-device');

// --- FR-13: a guitar-to-USB cable is a first-class input --------------------

const classifications: [string, DeviceKind][] = [
  ['Line 6 Guitar Link UG-002', 'guitar-usb'],
  ['Rocksmith USB Guitar Adapter', 'guitar-usb'],
  ['Behringer UCG102 GUITAR LINK', 'guitar-usb'],
  ['iRig HD 2', 'guitar-usb'],
  ['Focusrite Scarlett Solo USB', 'interface'],
  ['Behringer UMC22', 'interface'],
  ['Built-in Microphone', 'onboard'],
  ['Realtek High Definition Audio', 'onboard'],
  ['Microphone Array (Intel Smart Sound)', 'onboard'],
  // Genuinely ambiguous, and what many cheap guitar cables report. Guessing
  // "onboard" here would slander a device FR-13 says is fully supported.
  ['USB Audio CODEC', 'unknown'],
];

for (const [label, expected] of classifications) {
  check(`"${label}" reads as ${expected}`, classifyDevice(label) === expected,
    `got ${classifyDevice(label)}`);
}

// --- FR-7 / FR-12: probing happens before anything loads, and never blocks --

const withDevices = {
  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    return [
      { kind: 'audioinput', deviceId: 'a', label: 'Line 6 Guitar Link UG-002' },
      { kind: 'audiooutput', deviceId: 'b', label: 'Headphones' },
      { kind: 'audioinput', deviceId: 'c', label: 'Built-in Microphone' },
    ] as MediaDeviceInfo[];
  },
} as unknown as MediaDevices;

const report = await probeEnvironment({ mediaDevices: withDevices }, true, true);
check('only audio inputs are reported', report.inputs.length === 2);
check('a guitar cable is reported as such', report.inputs[0]?.kind === 'guitar-usb');

const hostile = {
  async enumerateDevices(): Promise<MediaDeviceInfo[]> {
    throw new Error('blocked');
  },
} as unknown as MediaDevices;

const degraded = await probeEnvironment({ mediaDevices: hostile }, false, false);
check('a hostile environment still produces a report rather than throwing',
  degraded.inputs.length === 0 && degraded.secureContext === false);
check('an environment that cannot run the engine is reported, not blocked',
  canRunEngine(degraded) === false && canRunEngine(report) === detectWasmSimd());

check('this runtime reports SIMD support truthfully', detectWasmSimd() === true);

console.log('');
if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
