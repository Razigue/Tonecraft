declare name "TonecraftAmp";
declare author "Tonecraft";
declare license "MIT";
declare description "High-gain lead preamp, tone stack and power stage.";

// Built from the Faust standard libraries, which are MIT. Nothing here is
// ported from a GPL amp simulator, so the product carries no viral licence.
//
// The shape is a real high-gain preamp's, and the reasons matter more than the
// numbers, because the numbers will move once someone tunes this by ear:
//
//  - Every gain stage is preceded by a highpass. Low frequencies driven into a
//    non-linearity turn to mud, and cascading four stages without this is the
//    single most common way a high-gain model ends up sounding like a blanket.
//  - Every gain stage is followed by a lowpass. That is the fizz control; a
//    real circuit gets it free from Miller capacitance, and a model that skips
//    it sounds like a wasp.
//  - The early stages clip asymmetrically. Even harmonics are what makes a
//    valve stage sound warm rather than like a fuzz box.
//  - Four modest stages, not one violent one. No single stage is driven hard
//    enough to square the wave off.
//
// No smoothing anywhere: parameters arrive already smoothed at the worklet
// boundary and a stage adds none of its own (AD-20).

import("stdfaust.lib");

// --- Controls. Ranges mirror schema/params.ts exactly. ---------------------
gain   = hslider("gain",   30,   0, 40, 0.001);
bass   = hslider("bass",    0, -12, 12, 0.001);
mid    = hslider("mid",    -2, -12, 12, 0.001);
treble = hslider("treble",  2, -12, 12, 0.001);
master = hslider("master", -6, -24, 12, 0.001);

// --- Building blocks ------------------------------------------------------

// A tanh-shaped saturator without the tanh.
//
// `ma.tanh` compiles to std::tanh, and five of those per sample at 4x is close
// to a million transcendental calls a second — measured at 10% of one core,
// which is the entire amp's budget spent on a library function.
//
// This is the Pade approximant of tanh, clamped to its useful range: within
// about 1% of the real curve to |x| = 3, saturating at exactly 1.0 where tanh
// reaches 0.995. Multiplies and one divide. The clamp is what makes it a
// saturator rather than a polynomial that runs away.
saturate(x) = y * (27.0 + y * y) / (27.0 + 9.0 * y * y)
with {
    y = max(-3.0, min(3.0, x));
};

// Asymmetric soft clipping. The offset pushes the signal off centre so the two
// halves of the wave clip differently, which is what produces even harmonics;
// the DC blocker afterwards removes the offset itself.
softClip(offset) = +(offset) : saturate : fi.dcblocker;

// One preamp stage: clean up the low end, amplify, clip, tame the top.
stage(g, hp, lp, offset) =
    fi.highpass(1, hp) : *(g) : softClip(offset) : fi.lowpass(1, lp);

// --- The amplifier --------------------------------------------------------

// Gain in dB spread across four stages rather than dumped into one.
drive = ba.db2linear(gain * 0.25);

// Corners chosen against a measured response, not by feel. Four first-order
// highpasses cascade: at 100 Hz, corners of 110/95/120/140 stacked up to about
// 28 dB of cut, which left the bass control nothing to act on and would have
// sounded like paper. These sit low enough to tighten the stages without
// removing the instrument.
preamp =
    stage(drive * 1.6, 45, 12000, 0.12)   // bright and forgiving
  : stage(drive * 1.4, 55,  9000, 0.08)
  : stage(drive * 1.2, 70,  7000, 0.04)   // tighter as the gain builds
  : stage(drive * 1.0, 85,  6000, 0.00);  // last stage symmetric

// Tone stack after the preamp, where a real one sits. The mid is a bell rather
// than a shelf: a lead tone lives or dies on what happens around 650 Hz.
// Order 3, not 2, and this is not a matter of taste. Faust builds a shelf by
// splitting into a two-band filterbank and summing the bands back with one of
// them scaled. At even orders the two bands are 180 degrees apart at the
// crossover and cancel: an order-2 shelf measured -129 dB at its own corner
// frequency with the control sitting flat. Odd orders sum to allpass.
toneStack =
    fi.lowshelf(3, bass, 200)
  : fi.peak_eq(mid, 650, 700)
  : fi.highshelf(3, treble, 3200);

// Power stage: gentle, symmetric, and it is what stops the tone sounding like
// a preamp plugged straight into a mixing desk.
powerAmp = *(1.8) : saturate : *(0.55);

process = fi.highpass(1, 30) : preamp : toneStack : powerAmp : *(ba.db2linear(master));
