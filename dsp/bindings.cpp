// The flat C interface exposed to WASM.
//
// AD-13: compiled -fno-exceptions, so nothing here throws. Every failure is
// resolved at init and reported as a status code; process() cannot fail and
// always produces audio — silence at worst, never nothing.

#include <cstdint>

#include "boundary.h"
#include "params.generated.h"

namespace {

// One instance. The audio thread never allocates (AD-13).
tonecraft::Boundary g_boundary;

alignas(16) float g_input[tonecraft::kOversampledBlockFrames];
alignas(16) float g_output[tonecraft::kOversampledBlockFrames];

// Where the main thread writes the weights blob before asking us to load it.
// Sized for the header plus the exact float count this build's model needs.
alignas(16) uint8_t g_weights[3 * sizeof(uint32_t) +
                              tonecraft::kWeightsFloatCount * sizeof(float)];

bool g_initialised = false;

}  // namespace

extern "C" {

enum TcStatus : int32_t {
  TC_OK = 0,
  // A rate so far outside anything real that a conversion filter designed for
  // it would be meaningless. Not a quality judgement — a sanity bound.
  TC_ERR_UNSUPPORTED_SAMPLE_RATE = 1,
};

int32_t tc_init(uint32_t sample_rate) {
  if (sample_rate < 8000 || sample_rate > 384000) {
    return TC_ERR_UNSUPPORTED_SAMPLE_RATE;
  }
  // Establishes every default and every coefficient, including the resampler
  // tables. Nothing in this module relies on a static constructor having run.
  g_boundary.init(sample_rate);
  g_initialised = true;
  return TC_OK;
}

void tc_process(uint32_t frames) {
  if (!g_initialised) {
    // Silence, never nothing (AD-13).
    for (uint32_t i = 0; i < frames; ++i) g_output[i] = 0.0f;
    return;
  }
  g_boundary.process(g_input, g_output, frames);
}

// Returns a WeightsStatus. Every way this can fail is detected here, at init,
// and named — process() has no error path (AD-13).
int32_t tc_load_weights(uint32_t byte_count) {
  tonecraft::WeightsView view;
  const auto status = tonecraft::parseWeights(g_weights, byte_count, &view);
  if (status != tonecraft::WeightsStatus::Ok) return static_cast<int32_t>(status);
  g_boundary.chain().amp().load(view);
  return 0;
}

uint8_t* tc_weights_ptr() { return g_weights; }
uint32_t tc_weights_capacity() { return sizeof(g_weights); }
uint32_t tc_weights_float_count() { return tonecraft::kWeightsFloatCount; }
uint32_t tc_amp_loaded() { return g_boundary.chain().amp().loaded() ? 1u : 0u; }

// A bitmask of bypassed stages, resolved through declared ids (AD-21). The UI
// already owns the parameters; this exists so a test can assert that the chain
// and the schema agree about which stage a bypass belongs to.
// Calibration reads these; nothing in the audio path does (FR-10).
float tc_input_peak() { return g_boundary.chain().probe().peak(); }
float tc_input_brightness() { return g_boundary.chain().probe().brightness(); }
uint32_t tc_probe_frames() { return g_boundary.chain().probe().counted(); }
void tc_probe_clear() { g_boundary.chain().probe().clear(); }

uint32_t tc_bypass_mask() {
  uint32_t mask = 0;
  for (uint32_t s = 0; s < tonecraft::kStageCount; ++s) {
    if (g_boundary.chain().bypassed(s)) mask |= (1u << s);
  }
  return mask;
}

void tc_set_param(uint32_t index, float value) {
  g_boundary.chain().setParam(index, value);
}
float tc_get_param(uint32_t index) { return g_boundary.chain().param(index); }

float* tc_input_ptr() { return g_input; }
float* tc_output_ptr() { return g_output; }
const float* tc_meter_ptr() { return g_boundary.chain().meters(); }

uint32_t tc_param_count() { return tonecraft::kParamCount; }
uint32_t tc_meter_count() { return tonecraft::kMeterSlotCount; }
uint32_t tc_block_frames() { return tonecraft::kBlockFrames; }
uint32_t tc_internal_sample_rate() { return tonecraft::kInternalSampleRate; }

// Zero when the device already runs at the internal rate. Shown as part of the
// round trip rather than hidden (FR-35).
uint32_t tc_added_latency_frames() { return g_boundary.addedLatencyFrames(); }
uint32_t tc_resampling() { return g_boundary.bypassed() ? 0u : 1u; }

// Base-rate samples of delay the 4x window costs. Part of the round trip the
// player sees, rather than something quietly absorbed (FR-35).
float tc_oversample_latency_samples() {
  return tonecraft::Chain::oversampleLatencySamples();
}

}  // extern "C"
