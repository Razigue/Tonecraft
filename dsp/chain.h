#pragma once

#include <cstdint>

#include "amp/amp.h"
#include "oversample/window.h"
#include "limiter/limiter.h"
#include "params.generated.h"
#include "stage.h"

namespace tonecraft {

class Chain {
 public:
  // No constructor: see the note in Limiter. Everything is established by
  // init(), which tc_init calls, so the module is correct whether or not a
  // loader runs the module's static initialisers.
  void init();
  void reset();
  void process(const float* in, float* out, uint32_t frames);

  void setParam(uint32_t index, float value);
  float param(uint32_t index) const;

  Amp& amp() { return amp_; }

  /// Extra round-trip delay the oversampling window costs, in base-rate samples.
  static constexpr float oversampleLatencySamples() {
    return OversampleWindow::latencySamples();
  }

  const float* meters() const { return meters_; }

 private:
  void meterInto(uint32_t slot, const float* buffer, uint32_t frames);

  Amp amp_;
  OversampleWindow window_;
  Limiter limiter_;
  float params_[kParamCount];
  float meters_[kMeterSlotCount];
};

static_assert(Stage<Limiter>, "Limiter must satisfy the AD-19 stage contract");
static_assert(Stage<Amp>, "Amp must satisfy the AD-19 stage contract");

}  // namespace tonecraft
