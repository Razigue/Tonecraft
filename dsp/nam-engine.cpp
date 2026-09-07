/* =============================================================================
   dsp/nam-engine.cpp — the flat C interface around NeuralAmpModelerCore
   -----------------------------------------------------------------------------
   Compiled by scripts/build-nam.mjs into public/nam/nam.wasm, with SIMD. The
   function names and argument order are those of the @opendaw/nam-wasm 1.2.0
   build this replaced, so public/nam/nam-processor.js did not have to change.

   Why build it ourselves: the vendored binary was scalar. Measured on the
   shipped "standard" WaveNet captures, this build runs the model in 2.9x less
   time (scripts/bench-nam.mjs), which is the difference between a chain that
   fits a weak laptop and one that crackles on it. Output agrees with the
   vendored build to -115 dB.

   Real-time rules (AD-13): nam_process allocates nothing and cannot throw.
   Loading a model is the only path that can fail, and it fails by returning
   0 — native WebAssembly exceptions are enabled so a malformed capture is a
   refused load rather than a dead engine. They cost nothing on the path that
   does not throw.
   ========================================================================== */

#include <memory>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>

#include <NAM/activations.h>
#include <NAM/dsp.h>
#include <NAM/get_dsp.h>

namespace {

struct Instance {
  std::unique_ptr<nam::DSP> model;
};

std::vector<std::unique_ptr<Instance>> gInstances;
double gSampleRate = 48000.0;
int gMaxBufferSize = 512;
std::string gLastError;

Instance* get(int id) {
  if (id < 0 || (size_t)id >= gInstances.size()) return nullptr;
  return gInstances[(size_t)id].get();
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE void nam_setSampleRate(float sr) { gSampleRate = sr; }
EMSCRIPTEN_KEEPALIVE float nam_getSampleRate() { return (float)gSampleRate; }
EMSCRIPTEN_KEEPALIVE void nam_setMaxBufferSize(int n) { gMaxBufferSize = n > 0 ? n : 128; }
EMSCRIPTEN_KEEPALIVE int nam_getMaxBufferSize() { return gMaxBufferSize; }

EMSCRIPTEN_KEEPALIVE int nam_createInstance() {
  // The fast tanh is what the reference plugin ships with; it is a global
  // NAM-core setting, enabled once. Measured against the vendored build,
  // which used it too: identical to -115 dB.
  static bool once = false;
  if (!once) {
    nam::activations::Activation::enable_fast_tanh();
    once = true;
  }
  auto inst = std::make_unique<Instance>();
  for (size_t i = 0; i < gInstances.size(); i++) {
    if (gInstances[i] == nullptr) {
      gInstances[i] = std::move(inst);
      return (int)i;
    }
  }
  gInstances.push_back(std::move(inst));
  return (int)gInstances.size() - 1;
}

EMSCRIPTEN_KEEPALIVE void nam_destroyInstance(int id) {
  if (id < 0 || (size_t)id >= gInstances.size()) return;
  gInstances[(size_t)id].reset();
}

EMSCRIPTEN_KEEPALIVE int nam_getInstanceCount() {
  int n = 0;
  for (auto& i : gInstances) if (i) n++;
  return n;
}

/* Not real-time safe: parses JSON, allocates the network and prewarms it. */
EMSCRIPTEN_KEEPALIVE int nam_loadModel(int id, const char* json) {
  Instance* inst = get(id);
  if (inst == nullptr) { gLastError = "invalid instance"; return 0; }
  try {
    std::unique_ptr<nam::DSP> model = nam::get_dsp(nlohmann::json::parse(json));
    if (model == nullptr) { gLastError = "model construction returned null"; return 0; }
    model->ResetAndPrewarm(gSampleRate, gMaxBufferSize);
    inst->model = std::move(model);
    return 1;
  } catch (const std::exception& e) {
    gLastError = e.what();
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE void nam_unloadModel(int id) {
  Instance* inst = get(id);
  if (inst) inst->model.reset();
}

EMSCRIPTEN_KEEPALIVE int nam_hasModel(int id) {
  Instance* inst = get(id);
  return (inst && inst->model) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE void nam_reset(int id) {
  Instance* inst = get(id);
  if (inst && inst->model) inst->model->ResetAndPrewarm(gSampleRate, gMaxBufferSize);
}

EMSCRIPTEN_KEEPALIVE int nam_hasModelLoudness(int id) {
  Instance* inst = get(id);
  return (inst && inst->model && inst->model->HasLoudness()) ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE float nam_getModelLoudness(int id) {
  Instance* inst = get(id);
  return (inst && inst->model && inst->model->HasLoudness())
    ? (float)inst->model->GetLoudness() : 0.0f;
}

/* Real-time safe. Passes the signal through when there is nothing to run. */
EMSCRIPTEN_KEEPALIVE void nam_process(int id, float* in, float* out, int frames) {
  Instance* inst = get(id);
  if (inst == nullptr || frames <= 0) return;
  if (inst->model == nullptr || frames > gMaxBufferSize) {
    for (int i = 0; i < frames; i++) out[i] = in[i];
    return;
  }
  NAM_SAMPLE* ip = in;
  NAM_SAMPLE* op = out;
  inst->model->process(&ip, &op, frames);
}

EMSCRIPTEN_KEEPALIVE const char* nam_getLastError() { return gLastError.c_str(); }

}  // extern "C"
