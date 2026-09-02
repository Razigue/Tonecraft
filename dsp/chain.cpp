// The chain: the only file that knows the stage order.
//
// Story 1.3 composes the skeleton — input trim, a pass-through where the stages
// will go, the output stage and its limiter. There is no gate, drive, amp, cab
// or reverb yet, and no oversampling window. What this proves is the pipeline:
// audio enters the worklet, crosses into WASM, is processed by real code, comes
// back, and is metered — with the limiter already in place, so no stage of
// development can put an unlimited signal in someone's ears.

#include "chain.h"

#include <cmath>
#include <cstring>

#include "params.generated.h"

namespace tonecraft {
namespace {

// Every buffer the audio path touches is here, allocated once, at namespace
// scope (AD-13). process() must never allocate: a garbage-collection pause or
// a malloc in the audio thread becomes an audible glitch, and the CPU budget
// is the dropout budget.
alignas(16) float g_scratch_a[kOversampledBlockFrames];
alignas(16) float g_scratch_b[kOversampledBlockFrames];

float dbToLinear(float db) { return std::pow(10.0f, db * 0.05f); }

}  // namespace

void Chain::init() {
  for (uint32_t i = 0; i < kParamCount; ++i) {
    params_[i] = kParams[i].default_value;
  }
  reset();
}

void Chain::reset() {
  amp_.reset();
  limiter_.reset();
  for (uint32_t i = 0; i < kMeterSlotCount; ++i) meters_[i] = 0.0f;
}

void Chain::setParam(uint32_t index, float value) {
  if (index >= kParamCount) return;
  // Clamp rather than reject: a value out of range is a bug upstream, and the
  // audio thread has no way to report one (AD-13). Clamping keeps it audible
  // and safe instead of undefined.
  const ParamInfo& info = kParams[index];
  params_[index] = value < info.min_value   ? info.min_value
                   : value > info.max_value ? info.max_value
                                            : value;
}

float Chain::param(uint32_t index) const {
  return index < kParamCount ? params_[index] : 0.0f;
}

// RMS of a block, written to a stage's declared meter slot (AD-21). The samples
// are already in registers, so the measurement is free — this is why the cord
// needs no AnalyserNode and no second audio graph.
void Chain::meterInto(uint32_t slot, const float* buffer, uint32_t frames) {
  float sum = 0.0f;
  for (uint32_t i = 0; i < frames; ++i) sum += buffer[i] * buffer[i];
  meters_[slot] = std::sqrt(sum / static_cast<float>(frames));
}

void Chain::process(const float* in, float* out, uint32_t frames) {
  if (frames > kOversampledBlockFrames) return;

  float* a = g_scratch_a;
  float* b = g_scratch_b;

  // --- Input -------------------------------------------------------------
  const float trim = dbToLinear(params_[PARAM_IN_TRIM]);
  for (uint32_t i = 0; i < frames; ++i) a[i] = in[i] * trim;
  meterInto(METER_INPUT, a, frames);

  // --- Gate, drive -------------------------------------------------------
  // Stories 1.9 and 1.10.
  meterInto(METER_GATE, a, frames);
  meterInto(METER_DRIVE, a, frames);

  // --- Amp ---------------------------------------------------------------
  // Gain and the tone stack are story 1.10; this is the model itself. Without
  // weights it passes through rather than going silent — a silent chain is
  // indistinguishable from a dead interface, and the player could not tell
  // which they were looking at.
  amp_.process(a, b, frames);
  meterInto(METER_AMP, b, frames);
  float* tmp = a; a = b; b = tmp;

  // --- Cab, reverb -------------------------------------------------------
  // Stories 1.8 and 1.10.
  meterInto(METER_CAB, a, frames);
  meterInto(METER_REVERB, a, frames);

  // --- Output ------------------------------------------------------------
  const float master = dbToLinear(params_[PARAM_OUT_MASTER]);
  const bool muted = params_[PARAM_OUT_MUTE] >= 0.5f;
  const float gain = muted ? 0.0f : master;
  for (uint32_t i = 0; i < frames; ++i) b[i] = a[i] * gain;

  // Always. No mode, no path, no parameter reaches past this (FR-18).
  limiter_.process(b, out, frames);
  meterInto(METER_OUTPUT, out, frames);
}

}  // namespace tonecraft
