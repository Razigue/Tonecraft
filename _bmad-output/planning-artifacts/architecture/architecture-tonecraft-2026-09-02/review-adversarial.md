# Adversarial review — Tonecraft v1 spine

Method: construct two units one level down that each obey every AD to the letter yet still build incompatibly. Every pair found is a hole to close.

## H-1 — Sample rate: two units, two tunings *(critical)*

FR-9 creates the `AudioContext` at the device's exact sample rate — 44.1, 48 or 96 kHz depending on the interface. AD-5 fixes model complexity and filter orders at build time. Nothing says what rate those constants are *for*.

**The incompatible pair:** a builder writing `amp/` assumes the LSTM runs at its training rate. A builder writing `cab/` designs the FIR against whatever rate arrives. Both obey every AD.

**Why it is critical, not cosmetic:** an LSTM amp model is a rate-dependent non-linear system. The same weights at 44.1 kHz and at 48 kHz produce **audibly different** tone. So do half-band filters designed for one rate and run at another. That means two users with different interfaces hear different things from the same tone link — the exact failure NFR-6 and AD-4 exist to prevent, arriving through a door neither of them watches. It also silently breaks AD-6: the Node renderer picks one rate, and every user not on that rate hears something else than the preset page.

**Fix:** AD-18. The chain runs at a fixed internal design rate. Rate conversion happens explicitly at the chain boundary, with our own deterministic resampler.

## H-2 — The stage interface is never specified *(high)*

AD-1 puts every stage in one processor and AD-2 constrains their order, but no AD says what a stage *is*.

**The incompatible pair:** `gate/` processes in place on one buffer; `reverb/` requires distinct input and output pointers. Both are reasonable, both obey every AD, and `chain.cpp` cannot compose them. Worse: a stage inside the oversampling window receives 512 frames per call and one outside receives 128 — nothing states this, so a builder writing the drive and a builder writing the limiter will disagree about what a "block" is.

**Fix:** AD-19, fixing the block contract.

## H-3 — Two owners of parameter smoothing *(high)*

AD-9 sets units, AD-11 sets ownership, FR-19 mandates `AudioParam` for continuous values. None says who smooths.

**The incompatible pair:** `engine/` smooths before writing the `AudioParam`; `amp/` also smooths its gain internally "to avoid zipper noise". Result is double smoothing — sluggish and inconsistent from stage to stage. The opposite pair is worse: neither smooths, and every fader zippers.

**Fix:** AD-20. Exactly one layer smooths.

## H-4 — Meter slots addressed by position *(medium)*

AD-12 fixes the transport and the rate but not the addressing.

**The incompatible pair:** `chain.cpp` writes RMS in chain order; `app/` reads slot 3 as "amp" from a hardcoded list. Inserting the compressor in v1.1 shifts every slot and the cord lights the wrong segments — with no error anywhere, because the array is still the right length. The same hole exists for bypass: FR-20 allows bypassing any block, and a positional convention makes bypass state land on the wrong stage.

**Fix:** AD-21. Slot ids come from the schema.

## H-5 — Two definitions of a dropout *(low)*

FR-35 defines a dropout as a missed render deadline but not who detects it. The worklet comparing `currentTime` deltas and the main thread watching for gaps will report different numbers, and §7's headline metric is then whichever one shipped.

**Fix:** folded into AD-12 — the worklet is the only detector.

## What holds

AD-4 and AD-8 are unusually tight: both close a divergence that a competent builder would otherwise introduce while trying to help — reaching for relaxed SIMD to save CPU, renaming a parameter during a cleanup. AD-6 is structurally enforced rather than stated, which is the strongest form. AD-16's build-time budget assertion is likewise enforcement rather than intention.
