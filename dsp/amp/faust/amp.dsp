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

// The saturator.
//
// `ma.tanh` compiles to std::tanh, and five of those per sample at 4x is close
// to a million transcendental calls a second — measured at 10% of one core,
// the entire amp's budget spent on a library function. So it is approximated.
//
// The first approximation was the Pade form of tanh, clamped to |x| <= 3. That
// clamp turned out to be the problem: past it the curve is perfectly flat, so
// once a stage was driven hard enough the output stopped depending on the input
// at all. Measured, the whole amp had 0.2 dB of dynamics between a soft pick
// and a hard one. It sounded saturated and felt dead, and no amount of gain
// tuning could fix it, because the flat region *is* the dead zone.
//
// x / (1 + |x|) never goes flat. It approaches unity and keeps approaching it,
// so playing harder always gives more, and the guitar's volume knob still
// cleans it up. Its knee is softer than tanh's, which means it starts
// distorting earlier and more gradually — which is what a cascade of valve
// stages does anyway. One divide and one absolute value.
saturate(x) = x / (1.0 + abs(x));

// Asymmetric soft clipping. The offset pushes the signal off centre so the two
// halves of the wave clip differently, which is what produces even harmonics;
// the DC blocker afterwards removes the offset itself.
// The DC blocker exists to remove the offset the asymmetry adds, and nothing
// else. Faust's default corner is 35 Hz; four of those in series take 3 dB off
// the low E before any of the highpasses have had their turn. At 12 Hz it still
// removes DC and leaves the instrument alone.
softClip(offset) = +(offset) : saturate : fi.dcblockerat(12);

// One preamp stage: clean up the low end, amplify, clip, tame the top.
stage(g, hp, lp, offset) =
    fi.highpass(1, hp) : *(g) : softClip(offset) : fi.lowpass(1, lp);

// --- The amplifier --------------------------------------------------------

// Gain in dB spread across four stages rather than dumped into one.
//
// The exponent decides how hard each stage is driven. At 0.25 the first two
// stages barely clipped and the third harmonic sat 15 dB below the fundamental
// — audibly a crunch, not a high-gain amp. At 0.45 every stage is working.
drive = ba.db2linear(gain * 0.40);

// Corners chosen against a measured response, not by feel. Four first-order
// highpasses cascade: at 100 Hz, corners of 110/95/120/140 stacked up to about
// 28 dB of cut, which left the bass control nothing to act on and would have
// sounded like paper. These sit low enough to tighten the stages without
// removing the instrument.
// Each stage rolls off further than the last. A real preamp loses top at every
// coupling, and a model that does not sounds like a fuzz pedal in a tin.
// Corners set against a measured response rather than by feel — twice now. At
// 45/55/70/85 the five highpasses and four DC blockers compounded to 28 dB of
// cut at 80 Hz, which removes the low E's fundamental outright. That is the
// whole of "thin, boxy, sounds like a five-watt amp": the instrument's bottom
// octave was being deleted before the gain stages ever saw it.
preamp =
// The multipliers sit below unity on purpose. They were 1.6 down to 1.1, set
// while the highpasses were throwing away the bottom octave — so they were
// compensating for a signal that is now there. With the low end restored they
// drove every stage into saturation even at the lowest gain setting, and the
// fader had no usable range at all. Now the gain control provides the range and
// these only shape how it is distributed.
// The first two stages keep the instrument whole; the last two work on a
// bass-cut signal. This is what a real high-gain preamp's coupling caps do, and
// it resolves the tension between saturation and weight: clipping the full low
// end turns to mud and kills dynamics, so the heavy clipping happens above it
// and the cabinet's own resonance puts the weight back afterwards.
//
// Getting the dose wrong in either direction is audible. All four stages at
// 28-52 Hz gave a fat but undistorted tone; all four at 45-85 Hz — with the
// rate bug on top — deleted the bottom octave and produced the thin, boxy
// five-watt sound this is fixing.
    stage(drive * 1.00, 28, 10000, 0.12)   // bright and forgiving
  : stage(drive * 0.92, 34,  7000, 0.08)
  : stage(drive * 0.86, 95,  5500, 0.04)   // tighter as the gain builds
  : stage(drive * 0.78, 130, 4500, 0.00);  // last stage symmetric

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

// Power stage. Driven properly rather than politely: this is where the weight
// comes from, and at 1.8 in and 0.55 out it was doing almost nothing while
// throwing away 5 dB. A power amp that never works is what makes a model sound
// like a five-watt practice combo.
powerAmp = *(3.2) : saturate : *(0.85);

process = fi.highpass(1, 22) : preamp : toneStack : powerAmp : *(ba.db2linear(master));
