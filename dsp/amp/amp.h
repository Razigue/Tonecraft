// The neural amp stage.
//
// One LSTM layer of kLstmHiddenSize units followed by a dense layer to one
// output — the shape the architecture fixes at build time and never chooses at
// runtime from measured headroom (AD-5, FR-17). A fast machine keeps its
// unused headroom, because a shared tone has to sound the same for the person
// who receives it, and an adaptive engine would make every tone link a lie.
//
// Until weights are loaded this stage passes audio through untouched. It does
// not fall back to a guess, and it does not go silent: a chain that produces
// nothing is indistinguishable from a broken interface, and the player would
// have no way to tell which they were looking at.

#pragma once

#include <RTNeural/RTNeural.h>

#include <cstdint>
#include <vector>

#include "params.generated.h"
#include "weights.h"

namespace tonecraft {

class Amp {
 public:
  void reset() {
    model_.reset();
  }

  bool loaded() const { return loaded_; }

  /// Init-time only: allocates through RTNeural's setters, which is why this
  /// can never be called from the audio path (AD-13).
  void load(const WeightsView& weights) {
    auto& lstm = model_.template get<0>();
    auto& dense = model_.template get<1>();

    constexpr uint32_t kGateWidth = kLstmGates * kLstmHiddenSize;

    std::vector<std::vector<float>> w(kLstmInputSize, std::vector<float>(kGateWidth));
    for (uint32_t i = 0; i < kLstmInputSize; ++i)
      for (uint32_t g = 0; g < kGateWidth; ++g) w[i][g] = weights.w[i * kGateWidth + g];

    std::vector<std::vector<float>> u(kLstmHiddenSize, std::vector<float>(kGateWidth));
    for (uint32_t h = 0; h < kLstmHiddenSize; ++h)
      for (uint32_t g = 0; g < kGateWidth; ++g) u[h][g] = weights.u[h * kGateWidth + g];

    std::vector<float> b(kGateWidth);
    for (uint32_t g = 0; g < kGateWidth; ++g) b[g] = weights.b[g];

    lstm.setWVals(w);
    lstm.setUVals(u);
    lstm.setBVals(b);

    std::vector<std::vector<float>> dw(1, std::vector<float>(kLstmHiddenSize));
    for (uint32_t h = 0; h < kLstmHiddenSize; ++h) dw[0][h] = weights.denseW[h];
    dense.setWeights(dw);
    dense.setBias(const_cast<float*>(weights.denseB));

    model_.reset();
    loaded_ = true;
  }

  void process(const float* in, float* out, uint32_t frames) {
    if (!loaded_) {
      for (uint32_t i = 0; i < frames; ++i) out[i] = in[i];
      return;
    }
    // Per sample, and unavoidably so: an LSTM carries state from one sample to
    // the next, which is exactly what makes it model an amplifier rather than a
    // filter. It is also why this stage dominates the CPU budget.
    for (uint32_t i = 0; i < frames; ++i) {
      float sample[1] = {in[i]};
      out[i] = model_.forward(sample);
    }
  }

 private:
  RTNeural::ModelT<float, 1, 1,
                   RTNeural::LSTMLayerT<float, kLstmInputSize, kLstmHiddenSize>,
                   RTNeural::DenseT<float, kLstmHiddenSize, 1>>
      model_;
  bool loaded_ = false;
};

}  // namespace tonecraft
