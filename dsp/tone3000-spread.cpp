// Adapted from tone-3000/tone3000-plugin, commit ef6f178ae1ac6412b55fec6f058d86e640e5aaaf.
// Copyright (c) 2026 TONE3000. MIT; see LICENSE.txt and README.md in dsp/tone3000.
#include "tone3000/Spread.h"
#include <cmath>

namespace tc::tone3000 {

void Spread::prepare(double newSampleRate) {
  sampleRate = newSampleRate > 0.0 ? newSampleRate : 48000.0;
  msToSamples = static_cast<float>(sampleRate * 0.001);
  lagGain = std::pow(10.0f, kLagGainDb / 20.0f);

  crossover.prepare(sampleRate, appliedCrossoverHz);

  const int maxDelaySamples = static_cast<int>(std::ceil(
      (SpreadParams::kMaxOffsetMs + kDeckWobbleMaxMs) * 0.001 * sampleRate)) + 8;
  delayLine.prepare(maxDelaySamples);

  diffuser.prepare(sampleRate);
  wobble.prepare(sampleRate);

  offsetCoeff = 1.0f - std::exp(static_cast<float>(-1.0 / (kOffsetSmoothSeconds * sampleRate)));

  wobbleDepth.reset(sampleRate, kDeckFadeSeconds);
  wetGain.reset(sampleRate, kDeckFadeSeconds);
  crossoverMix.reset(sampleRate, kDeckFadeSeconds);
  diffuseMix.reset(sampleRate, kDeckFadeSeconds);

  running = false;
  engaged = false;
  resetDeck();
}

void Spread::resetDeck() {
  crossover.reset();
  delayLine.reset();
  diffuser.reset();
  wobble.reset();
}

void Spread::setTarget(const SpreadParams& params, bool nowEngaged) {
  if (!running) {
    if (!nowEngaged)
      return;  // idle and staying idle
    // Engage from idle: clean deck, offset primed at the knob (no glide up
    // from a stale value; the wet fade-in covers the start), fade from dry.
    resetDeck();
    offsetStateMs = params.offsetMs;
    wobbleDepth.setCurrentAndTargetValue(params.wobbleDepth);
    crossoverMix.setCurrentAndTargetValue(params.crossoverOn ? 1.0f : 0.0f);
    diffuseMix.setCurrentAndTargetValue(params.diffuseOn ? 1.0f : 0.0f);
    wetGain.setCurrentAndTargetValue(0.0f);
    running = true;
  }

  engaged = nowEngaged;
  targetOffsetMs = params.offsetMs;
  wobbleDepth.setTargetValue(params.wobbleDepth);
  crossoverMix.setTargetValue(params.crossoverOn ? 1.0f : 0.0f);
  diffuseMix.setTargetValue(params.diffuseOn ? 1.0f : 0.0f);
  if (params.crossoverHz != appliedCrossoverHz) {
    appliedCrossoverHz = params.crossoverHz;
    crossover.setCutoffFrequency(appliedCrossoverHz);
  }
  wetGain.setTargetValue(engaged ? 1.0f : 0.0f);
}

void Spread::forceIdle() {
  running = false;
  engaged = false;
}

void Spread::process(float* l, float* r, int numSamples) {
  if (!running) return;

  for (int i = 0; i < numSamples; ++i) {
    // The deck is seeded from channel 0 (the mono chain output). With a true
    // stereo source in mono chain mode the channels differ, so each bypass
    // crossfade endpoint is that channel's own untouched signal; the fade
    // must land exactly on the input, never hard-copy ch0 onto ch1.
    const float xl = l[i];
    const float xr = r[i];

    // Crossover, blended toward its bypass (low = 0, high = the full band;
    // the filter keeps running so re-engaging blends into warm state).
    float low = 0.0f, high = 0.0f;
    crossover.processSample(0, xl, low, high);
    const float xoMix = crossoverMix.getNextValue();
    low *= xoMix;
    high = xl + (high - xl) * xoMix;

    delayLine.pushSample(0, high);

    // Wobble: random walk with no audio-rate residue (see DeckWobble).
    const float wobbleMs = kDeckWobbleMaxMs * wobbleDepth.getNextValue() * wobble.next();

    // Smooth the SIGNED offset; side and magnitude derive from the result so
    // zero-crossings pass through identity (spec routing note).
    offsetStateMs += offsetCoeff * (targetOffsetMs - offsetStateMs);
    const float tMs = std::abs(offsetStateMs);
    const bool lagOnR = offsetStateMs >= 0.0f;

    const float delayMs = std::clamp(tMs + wobbleMs, 0.0f, SpreadParams::kMaxOffsetMs + kDeckWobbleMaxMs);
    float lag = delayLine.popSample(0, delayMs * msToSamples);

    // Diffusion cascade, blended toward its bypass (the pure delay).
    lag += (diffuser.process(lag) - lag) * diffuseMix.getNextValue();
    lag *= lagGain;

    // Center-identity blend: below kCenterBlendMs the lag path converges to
    // the dry high band, so the detent is exactly dual-mono (see header).
    const float blend = std::min(tMs * (1.0f / kCenterBlendMs), 1.0f);
    lag = high + (lag - high) * blend;

    const float refOut = low + high;  // LR4 recombination: allpass-flat
    const float lagOut = low + lag;

    const float wet = wetGain.getNextValue();
    const float outL = xl + ((lagOnR ? refOut : lagOut) - xl) * wet;
    const float outR = xr + ((lagOnR ? lagOut : refOut) - xr) * wet;
    l[i] = outL;
    r[i] = outR;
  }

  // Disengage completes once the fade-out lands: output equals input again.
  if (!engaged && !wetGain.isSmoothing() && wetGain.getCurrentValue() <= 0.0f)
    forceIdle();
}

} // namespace tc::tone3000
