// The amplifier stage.
//
// A cascade of gain stages, a tone stack and a power stage, described in Faust
// and compiled to C++ that is built into this module. The circuit lives in
// `faust/amp.dsp`; this file only makes it obey the stage contract (AD-19).
//
// **This replaces a neural model, deliberately.** The architecture originally
// bound an LSTM, and an LSTM's one real advantage is fidelity to a *particular*
// amplifier — a specific unit with its own ageing components and bias point.
// `PRODUCT.md` section 7 forbids modelling any named amplifier, so the product
// was paying that model's whole price for an advantage it had no use for: an
// asset that did not exist, a capture rig, a training run, and 9.7% of one core
// on a machine whose floor we cannot measure.
//
// What is given up is honest to state: this cannot be made to sound like one
// specific amplifier on request. It has to be tuned by ear until it sounds
// good, and "good" is a judgement rather than an error metric.

#pragma once

#include <cstdint>

// Angle brackets and -isystem: generated code is code we did not write, and
// -Werror has to stay sharp on the code we did.
#include <amp.generated.h>
#include "params.generated.h"

namespace tonecraft {

class Amp {
 public:
  void init() {
    dsp_.init(static_cast<int>(kInternalSampleRate));
    reset();
  }

  void reset() { dsp_.instanceClear(); }

  /// Parameters arrive already smoothed at the worklet boundary and this stage
  /// adds none of its own (AD-20). Written straight into the generated object's
  /// public fields — no UI machinery on the audio path, or anywhere.
  /// The setters are generated alongside the circuit, because Faust reorders
  /// its own slider indices whenever the .dsp changes — a hand-written mapping
  /// would eventually point "bass" at the gain, silently.
  void setControls(float gainDb, float bassDb, float midDb, float trebleDb,
                   float masterDb) {
    ampSetGain(dsp_, gainDb);
    ampSetBass(dsp_, bassDb);
    ampSetMid(dsp_, midDb);
    ampSetTreble(dsp_, trebleDb);
    ampSetMaster(dsp_, masterDb);
  }

  void process(const float* in, float* out, uint32_t frames) {
    // Faust wants arrays of channel pointers. The chain is mono end to end, so
    // this is one pointer each and costs nothing. The const cast is safe: the
    // generated `compute` only reads its inputs.
    float* inputs[1] = {const_cast<float*>(in)};
    float* outputs[1] = {out};
    dsp_.compute(static_cast<int>(frames), inputs, outputs);
  }

 private:
  AmpDsp dsp_;
};

}  // namespace tonecraft
