/* =============================================================================
   dsp/chain.cpp — the whole signal chain, and the only interface to it
   -----------------------------------------------------------------------------
   Compiled by scripts/build-dsp.mjs into public/dsp/chain.wasm, a standalone
   module with no JavaScript glue. Two hosts run that one file:

     - the browser, in the single AudioWorklet (public/dsp/chain-processor.js);
     - Tonecraft Engine, the native companion for ASIO (service/), through
       wasmtime.

   Neither host knows what is in here. Each moves samples through
   tc_process() and forwards the other tc_* calls from engine/engine.ts without
   interpreting them. So every feature of the sound lives in this directory or
   in engine/engine.ts, and a feature cannot exist in one host and be missing
   from the other: there is nowhere in a host to put it.

   The chain, in order:

       input      live capture or the file source, one or two channels
       frontend   channel choice, trim, noise gate, TS boost (4x, ADAA)
       amp        the NAM capture
       trim       the capture's measured level offset
       cab        synthesised minimum-phase IR, zero-latency convolution
       tone       four-band correction: the Web Audio biquads, exactly
       reverb     in parallel, computed only while audible
       master
       limiter    always on, no control anywhere (FR-18)
       click      the native metronome, after the meters, before the ceiling

   Calling convention for the hosts: every export takes i32 and f32 only. An
   export that takes a payload takes (pointer, bytes, ...) first; the host
   allocates with tc_alloc, copies, calls, and frees. Nothing here keeps a
   pointer it was handed.

   Real time (AD-13): tc_process allocates nothing and cannot throw. Loading a
   capture, an impulse or a take allocates, and runs between blocks.
   ========================================================================== */

#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include <NAM/activations.h>
#include <NAM/dsp.h>
#include <NAM/get_dsp.h>

#include "biquad.h"
#include "chain.generated.h"
#include "click.h"
#include "convolver.h"
#include "frontend.h"
#include "limiter.h"
#include "player.h"
#include "smooth.h"

#define TC_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE

namespace {

constexpr int BLOCK = 128;

/* 20 ms: fast enough to follow the hand, slow enough never to zipper. */
constexpr double FADER_TAU = 0.02;
/* The capture trim moves more gently: it changes with the capture, and a
   level jump between two captures is exactly what it exists to hide. */
constexpr double TRIM_TAU = 0.05;

/* Makeup gain on the A/B's direct path, in dB. Measured, not guessed: the demo
   take through the shipped preset against the same take raw, integrated over
   fourteen seconds off the output meter. It is one number for one preset and
   drifts as the master or the preset moves — matching loudness continuously
   would put a compressor across the only honest comparison in the product.
   `npm run test:browser` prints the offset when it goes stale. */
constexpr double DIRECT_MAKEUP_DB = 17.3;

double dbToLinear(double db) { return std::pow(10.0, db / 20.0); }
double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }

/* The boost's pre-clip gain in dB, as the stage's 0..1 amount: the inverse of
   the gain law inside it, 1 + 24 * amount. */
double boostAmount(double db) { return clampd((dbToLinear(db) - 1.0) / 24.0, 0.0, 1.0); }

/* The boost's tone in Hz, as its 0..1 amount: the inverse of the one-pole's
   cutoff law, 5200 * (0.35 + 1.3 * amount). */
double boostTone(double hz) { return clampd((hz / 5200.0 - 0.35) / 1.3, 0.0, 1.0); }

struct Chain {
  double sr = 48000.0;
  int maxFrames = 0;
  std::vector<float> in[2];
  std::vector<float> out;
  std::vector<float> tuner;
  float meters[TC_METER_COUNT] = {};
  float param[TC_PARAM_COUNT] = {};

  bool powered = true;
  bool direct = false;
  bool tuning = false;
  bool liveOpen = true;
  bool sourceFile = false;
  bool reverbWanted = false;
  long reverbTail = 0;

  tc::Frontend frontend;
  std::unique_ptr<nam::DSP> model;
  tc::Convolver cab;
  tc::Convolver reverb;
  tc::Biquad bass, mid, treble, presence, lowcut;
  double designed[4] = {NAN, NAN, NAN, NAN};
  tc::Limiter limiter;
  tc::Player player;
  tc::Click click;

  // Read once per block, as the worklet's k-rate AudioParams were.
  tc::Smoother inGain, gate, boost, tone;
  // Read every sample, as a GainNode's a-rate gain is.
  tc::Smoother trim, chainGain, directGain, dry, wet, master;
  tc::Smoother eq[4];

  float a[BLOCK] = {}, b[BLOCK] = {}, zeros[BLOCK] = {};
  float fe[BLOCK] = {}, amp[BLOCK] = {}, cabbed[BLOCK] = {}, toned[BLOCK] = {};
  float chained[BLOCK] = {}, wetted[BLOCK] = {};

  int meterFrames = 0;
  double outPeak = 0.0, outSum = 0.0;
  double stageSum[TC_SLOT_COUNT] = {};
};

Chain* g = nullptr;
std::string gError;

/* Parameter values and switches, turned into what each stage is steered to. */
void apply(Chain& c) {
  const float* p = c.param;
  const auto on = [p](int id) { return p[id] < 0.5f; };

  c.inGain.set(dbToLinear(p[TC_P_IN_TRIM]));
  // -100 is the stage's "off": no threshold, no gating at all.
  c.gate.set(on(TC_P_GATE_BYPASS) ? p[TC_P_GATE_THRESHOLD] : -100.0);
  c.boost.set(on(TC_P_DRIVE_BYPASS) ? boostAmount(p[TC_P_DRIVE_GAIN]) : 0.0);
  c.tone.set(boostTone(p[TC_P_DRIVE_TONE]));

  const bool flat = !on(TC_P_TONE_BYPASS);
  c.eq[0].set(flat ? 0.0 : p[TC_P_TONE_BASS]);
  c.eq[1].set(flat ? 0.0 : p[TC_P_TONE_MID]);
  c.eq[2].set(flat ? 0.0 : p[TC_P_TONE_TREBLE]);
  c.eq[3].set(flat ? 0.0 : p[TC_P_TONE_PRESENCE]);

  const double mix = on(TC_P_REVERB_BYPASS) ? p[TC_P_REVERB_MIX] : 0.0;
  c.reverbWanted = mix > 0.0;
  // The dry side comes down as the wet goes up, so the total stays put.
  c.wet.set(mix * 0.8);
  c.dry.set(1.0 - mix * 0.35);

  /* The tuner owns silence at the output without closing the input; power off
     silences everything, tails included. */
  const bool audible = c.powered && !c.tuning;
  c.master.set(audible && on(TC_P_OUT_MUTE) ? dbToLinear(p[TC_P_OUT_MASTER]) : 0.0);
  c.chainGain.set(c.direct || !audible ? 0.0 : 1.0);
  c.directGain.set(c.direct && audible ? dbToLinear(DIRECT_MAKEUP_DB) : 0.0);
}

void designEq(Chain& c, bool force) {
  tc::Biquad* bands[4] = {&c.bass, &c.mid, &c.treble, &c.presence};
  for (int k = 0; k < 4; k++) {
    const double gdb = c.eq[k].value;
    if (force || std::fabs(gdb - c.designed[k]) > 1e-6) {
      bands[k]->design(gdb, c.sr);
      c.designed[k] = gdb;
    }
  }
}

void meterFrame(Chain& c) {
  float* m = c.meters;
  const tc::Frontend& f = c.frontend;
  const double frames = c.meterFrames > 0 ? c.meterFrames : 1;
  m[TC_M_INPUT_PEAK] = static_cast<float>(f.peakIn);
  m[TC_M_DRIVE_PEAK] = static_cast<float>(f.peakOut);
  m[TC_M_GATE] = static_cast<float>(f.gateGain());
  m[TC_M_BRIGHTNESS] = static_cast<float>(f.eAll > 1e-12 ? std::sqrt(f.eHigh / f.eAll) : 0.0);
  m[TC_M_CHANNEL0_PEAK] = static_cast<float>(f.chPeak[0]);
  m[TC_M_CHANNEL1_PEAK] = static_cast<float>(f.chPeak[1]);
  m[TC_M_FOLLOWING] = static_cast<float>(f.following());
  m[TC_M_OUTPUT_PEAK] = static_cast<float>(c.outPeak);
  m[TC_M_OUTPUT_RMS] = static_cast<float>(std::sqrt(c.outSum / frames));
  m[TC_M_FILE_SECONDS] = static_cast<float>(static_cast<double>(c.player.position()) / c.sr);
  m[TC_M_FILE_PLAYING] = c.player.playing() ? 1.0f : 0.0f;
  for (int s = 0; s < TC_SLOT_COUNT; s++) {
    m[TC_M_STAGE_RMS + s] = static_cast<float>(std::sqrt(c.stageSum[s] / frames));
    c.stageSum[s] = 0.0;
  }
  c.frontend.resetMeters();
  c.outPeak = c.outSum = 0.0;
  c.meterFrames = 0;
}

double sumSquares(const float* x, int n) {
  double s = 0.0;
  for (int i = 0; i < n; i++) s += static_cast<double>(x[i]) * x[i];
  return s;
}

/* One block of at most BLOCK frames, starting `off` frames into the host's
   buffers. Returns 1 when a meter frame was completed. */
int processBlock(Chain& c, int off, int n, int inChannels) {
  const float* a;
  const float* b = nullptr;
  if (c.sourceFile) {
    const int ch = c.player.render(c.a, c.b, n);
    a = c.a;
    b = ch > 1 ? c.b : nullptr;
  } else if (c.liveOpen && inChannels > 0) {
    a = c.in[0].data() + off;
    b = inChannels > 1 ? c.in[1].data() + off : nullptr;
  } else {
    a = c.zeros;
  }

  float* tunerTap = c.tuner.data() + off;
  c.frontend.process(a, b, n, c.inGain.block(n), c.gate.block(n), c.boost.block(n), c.tone.block(n),
                     c.fe, tunerTap);

  if (c.model) {
    float* ip = c.fe;
    float* op = c.amp;
    c.model->process(&ip, &op, n);
  } else {
    // No capture: the dry signal passes. The UI says so, loudly (captureLoaded).
    std::memcpy(c.amp, c.fe, sizeof(float) * static_cast<size_t>(n));
  }
  for (int i = 0; i < n; i++) c.amp[i] *= static_cast<float>(c.trim.tick());

  // A cabinet not yet delivered is silence, as a ConvolverNode without a buffer was.
  if (c.cab.empty()) std::memset(c.cabbed, 0, sizeof(float) * static_cast<size_t>(n));
  else c.cab.process(c.amp, c.cabbed, n);

  for (int i = 0; i < n; i++) {
    for (tc::Smoother& s : c.eq) s.tick();
    // Coefficients follow a moving gain every 16 samples: finer than any
    // fader moves, and settled gains cost nothing.
    if ((i & 15) == 0) designEq(c, false);
    float x = c.cabbed[i];
    x = c.bass.tick(x);
    x = c.mid.tick(x);
    x = c.treble.tick(x);
    x = c.presence.tick(x);
    x = c.lowcut.tick(x);
    c.toned[i] = x;
    c.chained[i] = x * static_cast<float>(c.chainGain.tick());
  }

  /* A convolver fed silence keeps ringing its tail, so after the reverb is
     turned down it runs one impulse length longer — then not at all, which is
     the CPU a weak machine needs back. */
  if (c.reverbWanted || c.reverbTail > 0) {
    c.reverb.process(c.reverbWanted ? c.chained : c.zeros, c.wetted, n);
    c.reverbTail = c.reverbWanted ? c.reverb.length() + tc::Convolver::P : c.reverbTail - n;
  } else {
    std::memset(c.wetted, 0, sizeof(float) * static_cast<size_t>(n));
  }

  float* out = c.out.data() + off;
  for (int i = 0; i < n; i++) {
    const float d = static_cast<float>(c.dry.tick());
    const float w = static_cast<float>(c.wet.tick());
    const float dg = static_cast<float>(c.directGain.tick());
    const float mg = static_cast<float>(c.master.tick());
    /* The A/B's direct path is the selected channel as it arrived — before the
       trim, the gate and the boost — because the question it answers is "what
       does this do to my guitar". It rejoins at the master so the volume and
       the limiter still apply. */
    const float mixed = (c.chained[i] * d + c.wetted[i] * w + tunerTap[i] * dg) * mg;
    const float y = c.limiter.tick(mixed);

    const double ay = y < 0 ? -y : y;
    if (ay > c.outPeak) c.outPeak = ay;
    c.outSum += static_cast<double>(y) * y;

    float z = y;
    if (!c.click.idle()) {
      z += c.click.tick();
      z = z > 1.0f ? 1.0f : z < -1.0f ? -1.0f : z;
    }
    out[i] = z;
  }

  c.stageSum[TC_SLOT_INPUT] += sumSquares(tunerTap, n);
  {
    const double* gated = c.frontend.gated();
    double s = 0.0;
    for (int i = 0; i < n; i++) s += gated[i] * gated[i];
    c.stageSum[TC_SLOT_GATE] += s;
  }
  c.stageSum[TC_SLOT_DRIVE] += sumSquares(c.fe, n);
  c.stageSum[TC_SLOT_AMP] += sumSquares(c.amp, n);
  c.stageSum[TC_SLOT_CAB] += sumSquares(c.cabbed, n);
  c.stageSum[TC_SLOT_TONE] += sumSquares(c.toned, n);
  c.stageSum[TC_SLOT_REVERB] += sumSquares(c.wetted, n);
  c.stageSum[TC_SLOT_OUTPUT] += sumSquares(out, n);

  c.meterFrames += n;
  if (c.meterFrames >= c.sr / 30.0) {
    meterFrame(c);
    return 1;
  }
  return 0;
}

}  // namespace

/* ------------------------------ lifecycle ------------------------------ */

TC_EXPORT int tc_abi_version() { return TC_ABI_VERSION; }

TC_EXPORT void* tc_alloc(int bytes) { return std::malloc(bytes > 0 ? static_cast<size_t>(bytes) : 1); }
TC_EXPORT void tc_free(void* p) { std::free(p); }

/* Builds the chain for one sample rate and a host block of at most maxFrames.
   Everything the audio path will ever touch is allocated here. */
TC_EXPORT int tc_init(float sampleRate, int maxFrames) {
  static bool fastTanh = false;
  if (!fastTanh) {
    // The fast tanh is what the reference plugin ships with; a global setting.
    nam::activations::Activation::enable_fast_tanh();
    fastTanh = true;
  }
  delete g;
  g = new Chain();
  Chain& c = *g;
  c.sr = sampleRate > 0 ? sampleRate : 48000.0;
  c.maxFrames = maxFrames > 0 ? maxFrames : BLOCK;
  for (auto& ch : c.in) ch.assign(static_cast<size_t>(c.maxFrames), 0.0f);
  c.out.assign(static_cast<size_t>(c.maxFrames), 0.0f);
  c.tuner.assign(static_cast<size_t>(c.maxFrames), 0.0f);

  c.frontend.init(c.sr);
  c.click.init(c.sr);
  // Post-cabinet correction: the classic four-band layout, fixed frequencies,
  // only the gains move.
  c.bass.setup(tc::Biquad::LowShelf, 110.0, 1.0);
  c.mid.setup(tc::Biquad::Peaking, 650.0, 0.9);
  c.treble.setup(tc::Biquad::HighShelf, 2600.0, 1.0);
  c.presence.setup(tc::Biquad::HighShelf, 4200.0, 1.0);
  // Below the low E there is nothing but cone excursion and rumble.
  c.lowcut.setup(tc::Biquad::HighPass, 55.0, 0.707);
  c.lowcut.design(0.0, c.sr);

  for (int i = 0; i < TC_PARAM_COUNT; i++) c.param[i] = TC_PARAM_DEFAULT[i];
  for (tc::Smoother* s : {&c.inGain, &c.gate, &c.boost, &c.tone}) s->init(FADER_TAU, c.sr, 0.0);
  for (tc::Smoother* s : {&c.chainGain, &c.directGain, &c.dry, &c.wet, &c.master}) s->init(FADER_TAU, c.sr, 0.0);
  for (tc::Smoother& s : c.eq) s.init(FADER_TAU, c.sr, 0.0);
  c.trim.init(TRIM_TAU, c.sr, 1.0);
  apply(c);
  // Start where the controls are, not gliding towards them.
  for (tc::Smoother* s : {&c.inGain, &c.gate, &c.boost, &c.tone, &c.chainGain, &c.directGain,
                          &c.dry, &c.wet, &c.master}) s->value = s->target;
  for (tc::Smoother& s : c.eq) s.value = s.target;
  designEq(c, true);
  return 1;
}

TC_EXPORT float* tc_input_ptr(int channel) {
  return g != nullptr && (channel == 0 || channel == 1) ? g->in[channel].data() : nullptr;
}
TC_EXPORT float* tc_output_ptr() { return g != nullptr ? g->out.data() : nullptr; }
TC_EXPORT float* tc_tuner_ptr() { return g != nullptr ? g->tuner.data() : nullptr; }
TC_EXPORT float* tc_meters_ptr() { return g != nullptr ? g->meters : nullptr; }
TC_EXPORT int tc_meters_len() { return TC_METER_COUNT; }
TC_EXPORT int tc_max_frames() { return g != nullptr ? g->maxFrames : 0; }

/* The host has written `frames` samples per channel at tc_input_ptr. The chain
   writes as many to tc_output_ptr and tc_tuner_ptr. Returns 1 when a new meter
   frame is waiting at tc_meters_ptr. */
TC_EXPORT int tc_process(int frames, int inChannels) {
  if (g == nullptr) return 0;
  Chain& c = *g;
  if (frames > c.maxFrames) frames = c.maxFrames;
  int ready = 0;
  for (int off = 0; off < frames; off += BLOCK) {
    const int n = frames - off < BLOCK ? frames - off : BLOCK;
    ready |= processBlock(c, off, n, inChannels);
  }
  return ready;
}

/* ------------------------------ parameters ----------------------------- */

/* A parameter by wire index, in engineering units (AD-9). Values are clamped
   to the schema's range: whatever a host sends, the chain stays in the space
   the product was tuned in. */
TC_EXPORT void tc_set_param(int index, float value) {
  if (g == nullptr || index < 0 || index >= TC_PARAM_COUNT) return;
  switch (index) {
    case TC_P_IN_TRIM:
    case TC_P_GATE_THRESHOLD:
    case TC_P_GATE_BYPASS:
    case TC_P_DRIVE_GAIN:
    case TC_P_DRIVE_TONE:
    case TC_P_DRIVE_BYPASS:
    case TC_P_REVERB_MIX:
    case TC_P_REVERB_BYPASS:
    case TC_P_OUT_MASTER:
    case TC_P_OUT_MUTE:
    case TC_P_TONE_BASS:
    case TC_P_TONE_MID:
    case TC_P_TONE_TREBLE:
    case TC_P_TONE_PRESENCE:
    case TC_P_TONE_BYPASS:
      g->param[index] = static_cast<float>(clampd(value, TC_PARAM_MIN[index], TC_PARAM_MAX[index]));
      apply(*g);
      break;
    default:
      // Deprecated (AD-8): still decoded from old links, ignored here.
      break;
  }
}

/* ------------------------------- switches ------------------------------ */

TC_EXPORT void tc_set_powered(int on) { if (g) { g->powered = on != 0; apply(*g); } }
TC_EXPORT void tc_set_direct(int on) { if (g) { g->direct = on != 0; apply(*g); } }
TC_EXPORT void tc_set_tuning(int on) { if (g) { g->tuning = on != 0; apply(*g); } }
/* Whether live samples reach the chain at all. engine/engine.ts decides, from
   power, tuner and source; the chain only obeys. */
TC_EXPORT void tc_set_live_input(int open) { if (g) g->liveOpen = open != 0; }
TC_EXPORT void tc_set_input_channel(int code) { if (g) g->frontend.setChannel(code); }
/* The capture's measured level offset (public/models/index.json, trimDb). */
TC_EXPORT void tc_set_capture_trim(float db) { if (g) g->trim.set(dbToLinear(db)); }

/* ------------------------------- content ------------------------------- */

/* An impulse response, mono float32. Slot TC_IR_CAB or TC_IR_REVERB. */
TC_EXPORT int tc_set_ir(const float* data, int bytes, int slot) {
  if (g == nullptr || data == nullptr || bytes < 4) return 0;
  tc::Convolver* target = slot == TC_IR_CAB ? &g->cab : slot == TC_IR_REVERB ? &g->reverb : nullptr;
  if (target == nullptr) return 0;
  target->setIR(data, bytes / 4);
  if (slot == TC_IR_REVERB) g->reverbTail = 0;
  return 1;
}

/* A NAM capture, as its JSON text. On failure the chain passes the dry signal,
   as it did before, and says why through tc_last_error. */
TC_EXPORT int tc_load_model(const char* json, int bytes) {
  if (g == nullptr || json == nullptr || bytes <= 0) { gError = "no chain"; return 0; }
  try {
    std::unique_ptr<nam::DSP> model = nam::get_dsp(nlohmann::json::parse(json, json + bytes));
    if (model == nullptr) {
      gError = "model construction returned null";
      g->model.reset();
      return 0;
    }
    model->ResetAndPrewarm(g->sr, BLOCK);
    g->model = std::move(model);
    return 1;
  } catch (const std::exception& e) {
    gError = e.what();
    g->model.reset();
    return 0;
  }
}

TC_EXPORT int tc_model_loaded() { return g != nullptr && g->model != nullptr ? 1 : 0; }
TC_EXPORT int tc_model_has_loudness() {
  return g != nullptr && g->model != nullptr && g->model->HasLoudness() ? 1 : 0;
}
TC_EXPORT float tc_model_loudness() {
  return tc_model_has_loudness() ? static_cast<float>(g->model->GetLoudness()) : 0.0f;
}
TC_EXPORT const char* tc_last_error() { return gError.c_str(); }

/* ----------------------------- file source ----------------------------- */

TC_EXPORT void tc_set_source(int file) { if (g) g->sourceFile = file != 0; }
/* `channels` runs of float32, already at the chain's sample rate. */
TC_EXPORT int tc_file_load(const float* data, int bytes, int channels) {
  if (g == nullptr || data == nullptr || channels < 1) return 0;
  return g->player.load(data, bytes / 4 / channels, channels) ? 1 : 0;
}
TC_EXPORT void tc_file_play(int fromFrame) { if (g) g->player.play(fromFrame); }
TC_EXPORT void tc_file_stop() { if (g) g->player.stop(); }
TC_EXPORT void tc_file_loop(int on) { if (g) g->player.setLoop(on != 0); }

/* ------------------------------ metronome ------------------------------ */

TC_EXPORT void tc_click_voice(int beat, int wave, float frequency, float level, float duration) {
  if (g) g->click.voice(beat, wave, frequency, level, duration);
}
TC_EXPORT void tc_click_play(float bpm, float gain) { if (g) g->click.play(bpm, gain); }
TC_EXPORT void tc_click_gain(float gain) { if (g) g->click.setGain(gain); }
TC_EXPORT void tc_click_stop() { if (g) g->click.stop(); }

/* ----------------------------- measurement ----------------------------- */

/* The boost on its own, at any oversampling factor, with or without ADAA, for
   `npm run measure` and `npm run measure:latency`. A separate instance: the
   live chain always runs what ships (AD-5), and nothing here can reach it. */
TC_EXPORT int tc_measure_boost(int stages, int adaa, float amount, float tone,
                               const float* in, float* out, int frames, int reset) {
  static tc::Frontend* m = nullptr;
  if (m == nullptr) m = new tc::Frontend();
  if (reset != 0) m->init(g != nullptr ? g->sr : 48000.0, stages, adaa != 0);
  for (int off = 0; off < frames; off += BLOCK) {
    const int n = frames - off < BLOCK ? frames - off : BLOCK;
    m->process(in + off, nullptr, n, 1.0, -100.0, amount, tone, out + off, nullptr);
  }
  return 1;
}
