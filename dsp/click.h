/* =============================================================================
   dsp/click.h — the metronome, for the host that has no Web Audio
   -----------------------------------------------------------------------------
   In the browser the metronome is its own AudioContext, and stays that way: it
   has to tick with the engine switched off. The native host is different —
   under ASIO the driver usually owns the device, and a click from the browser
   would come out of the laptop's speakers instead of the headphones on the
   interface. There the click has to leave through the chain's own output.

   The voices are not decided here. `engine/metronome.ts` owns them and sends
   each beat's waveform, pitch, level and length through `tc_click_voice`, so
   the two metronomes cannot disagree about what a beat sounds like — only
   about who synthesises it. The synthesis is the Web Audio one: an oscillator
   under exponential ramps from 0.0001 to the level in 2 ms and back by the
   voice's duration, stopped at 60 ms. The triangle is band-limited, as a Web
   Audio OscillatorNode's is.

   Sample-accurate: beats are counted in samples, where the browser's version
   schedules against a 25 ms timer.
   ========================================================================== */
#pragma once

#include <cmath>

namespace tc {

class Click {
 public:
  struct Voice {
    int wave = 0;          // TC_WAVE_SINE or TC_WAVE_TRIANGLE
    double frequency = 980.0;
    double level = 0.72;
    double duration = 0.038;
  };
  static constexpr int BEATS = 4;

  void init(double sampleRate) {
    sr_ = sampleRate;
    gainKeepFast_ = std::exp(-1.0 / (0.006 * sr_));
    gainKeepSlow_ = std::exp(-1.0 / (0.015 * sr_));
    running_ = false;
    gain_ = gainTarget_ = 0.0;
    age_ = -1;
  }

  void voice(int beat, int wave, double frequency, double level, double duration) {
    if (beat < 0 || beat >= BEATS) return;
    voices_[beat] = Voice{wave, frequency, level < 1e-4 ? 1e-4 : level, duration < 0.003 ? 0.003 : duration};
  }

  void play(double bpm, double gain) {
    if (bpm <= 0) return;
    interval_ = sr_ * 60.0 / bpm;
    // The browser version schedules its first beat 40 ms ahead of now.
    next_ = 0.04 * sr_;
    beat_ = 0;
    running_ = true;
    gain_ = gainTarget_ = gain;
    keep_ = gainKeepSlow_;
  }

  void setGain(double gain) {
    gainTarget_ = gain;
    keep_ = gainKeepSlow_;
  }

  void stop() {
    running_ = false;
    gainTarget_ = 0.0;
    keep_ = gainKeepFast_;
  }

  bool idle() const { return !running_ && age_ < 0 && gain_ < 1e-6; }

  float tick() {
    if (running_) {
      next_ -= 1.0;
      if (next_ <= 0.0) {
        current_ = voices_[beat_];
        age_ = 0;
        phase_ = 0.0;
        beat_ = (beat_ + 1) % BEATS;
        next_ += interval_;
      }
    }
    gain_ = gainTarget_ + (gain_ - gainTarget_) * keep_;
    if (age_ < 0) return 0.0f;

    const double t = age_ / sr_;
    const double stopAt = 0.06;
    if (t >= stopAt) {
      age_ = -1;
      return 0.0f;
    }
    double env;
    const Voice& v = current_;
    if (t < 0.002) env = 1e-4 * std::pow(v.level / 1e-4, t / 0.002);
    else if (t < v.duration) env = v.level * std::pow(1e-4 / v.level, (t - 0.002) / (v.duration - 0.002));
    else env = 1e-4;

    const double s = v.wave == 1 ? triangle(phase_, v.frequency) : std::sin(2.0 * M_PI * phase_);
    phase_ += v.frequency / sr_;
    if (phase_ >= 1.0) phase_ -= 1.0;
    age_++;
    return static_cast<float>(s * env * gain_);
  }

 private:
  /* Odd harmonics under Nyquist, 1/n^2 with alternating sign: the Fourier
     series of a triangle, normalised to a peak of one when complete. */
  double triangle(double phase, double f) const {
    double s = 0.0;
    for (int k = 0;; k++) {
      const int n = 2 * k + 1;
      if (n * f >= sr_ / 2) break;
      s += ((k & 1) ? -1.0 : 1.0) * std::sin(2.0 * M_PI * n * phase) / (n * n);
    }
    return s * 8.0 / (M_PI * M_PI);
  }

  double sr_ = 48000.0;
  Voice voices_[BEATS];
  Voice current_;
  bool running_ = false;
  double interval_ = 0.0, next_ = 0.0;
  int beat_ = 0;
  long age_ = -1;
  double phase_ = 0.0;
  double gain_ = 0.0, gainTarget_ = 0.0, keep_ = 0.0;
  double gainKeepFast_ = 0.0, gainKeepSlow_ = 0.0;
};

}  // namespace tc
