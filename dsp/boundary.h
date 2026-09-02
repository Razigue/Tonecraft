// The chain boundary: the only place that knows the device sample rate (AD-18).
//
// Sits between the worklet and `Chain`. Everything on the chain side runs at
// kInternalSampleRate, in blocks of exactly kBlockFrames. Everything on the
// device side runs at whatever the hardware gives us, in whatever block size
// the worklet hands over.
//
// Deliberately outside `chain.cpp`. `Chain` composes stages, and a stage may
// not read the device rate or have a rate parameter — so the conversion cannot
// live there, and it cannot live in a stage.
//
// When the device already runs at the internal rate this class does nothing at
// all: no filter, no buffering, no added latency, and output identical to a
// build with no resampler in it. That is the common case and it must stay free.

#pragma once

#include <cstdint>

#include "chain.h"
#include "params.generated.h"
#include "resample/resampler.h"

namespace tonecraft {

class Boundary {
 public:
  /// Ring capacity. The worklet quantum is 128 device frames; the widest ratio
  /// we accept turns that into fewer than 256 internal frames, and a chain
  /// block is 128, so 512 leaves room for a full block plus a partial one.
  static constexpr uint32_t kFifoFrames = 512;

  void init(uint32_t deviceRate) {
    deviceRate_ = deviceRate;
    bypass_ = deviceRate == kInternalSampleRate;
    chain_.init();

    if (!bypass_) {
      toInternal_.init(deviceRate, kInternalSampleRate);
      toDevice_.init(kInternalSampleRate, deviceRate);
    }
    reset();
  }

  void reset() {
    chain_.reset();
    toInternal_.reset();
    toDevice_.reset();
    inCount_ = 0;
    outCount_ = 0;
    outRead_ = 0;
    primed_ = false;
  }

  Chain& chain() { return chain_; }
  const Chain& chain() const { return chain_; }

  /// Added latency in device frames, zero when no conversion happens. Reported
  /// so the figure the player sees is the whole truth (FR-35).
  uint32_t addedLatencyFrames() const {
    if (bypass_) return 0;
    // One chain block has to accumulate before the chain can run at all, plus
    // each resampler's own filter delay.
    const double blockInDeviceFrames = static_cast<double>(kBlockFrames) *
                                       static_cast<double>(deviceRate_) /
                                       static_cast<double>(kInternalSampleRate);
    return static_cast<uint32_t>(blockInDeviceFrames) + 2 * SincResampler::latencyFrames();
  }

  bool bypassed() const { return bypass_; }

  void process(const float* in, float* out, uint32_t frames) {
    if (bypass_) {
      chain_.process(in, out, frames);
      return;
    }

    // Device rate in, internal rate into the FIFO.
    inCount_ += toInternal_.process(in, frames, inFifo_ + inCount_, kFifoFrames - inCount_);

    // Run whole chain blocks for as long as there are whole chain blocks.
    while (inCount_ >= kBlockFrames && outCount_ + kBlockFrames <= kFifoFrames) {
      chain_.process(inFifo_, internal_, kBlockFrames);

      outCount_ += toDevice_.process(internal_, kBlockFrames, outFifo_ + outCount_,
                                     kFifoFrames - outCount_);

      inCount_ -= kBlockFrames;
      for (uint32_t i = 0; i < inCount_; ++i) inFifo_[i] = inFifo_[i + kBlockFrames];
    }

    // Drain exactly what the device asked for. The first call or two produce
    // silence while the FIFO fills — that is the added latency, paid once.
    for (uint32_t i = 0; i < frames; ++i) {
      out[i] = outRead_ < outCount_ ? outFifo_[outRead_++] : 0.0f;
    }
    if (outRead_ > 0) {
      outCount_ -= outRead_;
      for (uint32_t i = 0; i < outCount_; ++i) outFifo_[i] = outFifo_[i + outRead_];
      outRead_ = 0;
    }
    primed_ = true;
  }

 private:
  Chain chain_;
  SincResampler toInternal_;
  SincResampler toDevice_;

  // Every buffer static and sized at compile time. The audio path allocates
  // nothing, ever (AD-13).
  float inFifo_[kFifoFrames]{};
  float outFifo_[kFifoFrames]{};
  float internal_[kBlockFrames]{};

  uint32_t deviceRate_ = kInternalSampleRate;
  uint32_t inCount_ = 0;
  uint32_t outCount_ = 0;
  uint32_t outRead_ = 0;
  bool bypass_ = true;
  bool primed_ = false;
};

}  // namespace tonecraft
