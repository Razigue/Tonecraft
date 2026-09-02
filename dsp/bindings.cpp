// The flat C interface exposed to WASM.
//
// AD-13: compiled -fno-exceptions, so nothing here throws. Every failure is
// resolved at init and reported as a status code; process() cannot fail and
// always produces audio — silence at worst, never nothing.

#include <cstdint>

#include "chain.h"
#include "params.generated.h"

namespace {

// One instance, constructed once. The audio thread never allocates (AD-13).
tonecraft::Chain g_chain;

alignas(16) float g_input[tonecraft::kOversampledBlockFrames];
alignas(16) float g_output[tonecraft::kOversampledBlockFrames];

bool g_initialised = false;

}  // namespace

extern "C" {

enum TcStatus : int32_t {
  TC_OK = 0,
  // Story 1.5 adds the boundary resampler, after which any device rate is
  // fine. Until then the engine must refuse rather than quietly run stages
  // designed for 48 kHz at some other rate — that would be exactly the
  // divergence AD-18 exists to prevent, arriving silently.
  TC_ERR_UNSUPPORTED_SAMPLE_RATE = 1,
};

int32_t tc_init(uint32_t sample_rate) {
  if (sample_rate != tonecraft::kInternalSampleRate) {
    return TC_ERR_UNSUPPORTED_SAMPLE_RATE;
  }
  // Establishes every default and every coefficient. Nothing in this module
  // relies on a static constructor having run.
  g_chain.init();
  g_initialised = true;
  return TC_OK;
}

void tc_process(uint32_t frames) {
  if (!g_initialised) {
    // Silence, never nothing (AD-13).
    for (uint32_t i = 0; i < frames; ++i) g_output[i] = 0.0f;
    return;
  }
  g_chain.process(g_input, g_output, frames);
}

void tc_set_param(uint32_t index, float value) { g_chain.setParam(index, value); }
float tc_get_param(uint32_t index) { return g_chain.param(index); }

float* tc_input_ptr() { return g_input; }
float* tc_output_ptr() { return g_output; }
const float* tc_meter_ptr() { return g_chain.meters(); }

uint32_t tc_param_count() { return tonecraft::kParamCount; }
uint32_t tc_meter_count() { return tonecraft::kMeterSlotCount; }
uint32_t tc_block_frames() { return tonecraft::kBlockFrames; }
uint32_t tc_internal_sample_rate() { return tonecraft::kInternalSampleRate; }

}  // extern "C"
