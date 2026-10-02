#pragma once
#include <algorithm>
#include "tone3000/Spread.h"

namespace tc {
// TONE3000 Spread, adapted for the existing Tonecraft Doubler controls.
// Spread is now the base delay, with upstream's 25% wobble, 130 Hz crossover
// and diffusion enabled. Both channels receive the crossover phase response.
// No lookahead/buffer latency is added to the reference side.
class Doubler {
 public:
  void init(double rate) { engine_.prepare(rate); }
  void set(bool on, double spreadMs) {
    tone3000::SpreadParams p;
    p.offsetMs = static_cast<float>(std::clamp(spreadMs, 3.0, 20.0));
    engine_.setTarget(p, on);
  }
  bool idle() const { return !engine_.isRunning(); }
  void tick(float x, float& left, float& right) {
    left = right = x;
    engine_.process(&left, &right, 1);
  }
 private:
  tone3000::Spread engine_;
};
} // namespace tc
