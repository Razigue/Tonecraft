#!/usr/bin/env bash
# AD-18: a stage may not read the device sample rate and has no rate parameter.
#
# The conversion lives at the boundary and only there. If a stage ever learns
# what rate the hardware runs at, two players with different interfaces hear
# different amplifiers from the same tone link — an LSTM amp is a rate-dependent
# non-linear system. That divergence would arrive silently, through a door no
# other invariant watches, which is why this is checked rather than trusted.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Everything under dsp/ except the boundary itself.
#
# bindings.cpp is excluded because it *is* the boundary's entry point: it takes
# the device rate from the worklet and hands it to Boundary::init. That is the
# one place in the C++ that is allowed to know it, and it does not process audio.
#
# Generated files are excluded because they are not code we write. A Faust DSP
# is rate-parameterised by construction and takes a sample_rate argument. So is
# faust-runtime.h, which only mirrors the interface the generated code expects.
# What matters is what we *pass* them, which is asserted positively below.
mapfile -t STAGE_FILES < <(
  find "${ROOT}/dsp" -name '*.h' -o -name '*.cpp' \
    | grep -v '/boundary\.h$' \
    | grep -v '/bindings\.cpp$' \
    | grep -v '/resample/' \
    | grep -v '\.generated\.h$' \
    | grep -v '/faust-runtime\.h$' \
    | sort
)

status=0
for file in "${STAGE_FILES[@]}"; do
  # A stage may reference kInternalSampleRate — that is its design rate, a
  # compile-time constant. What it may never touch is a rate that came from
  # outside: a parameter, a member, an argument.
  if grep -nE 'deviceRate|device_rate|sampleRate[^s]|sample_rate' "${file}" \
     | grep -vE 'kInternalSampleRate|^\s*//|AD-18'; then
    printf '\n  %s refers to a device sample rate.\n' "${file#"${ROOT}/"}" >&2
    status=1
  fi
done

if [[ ${status} -ne 0 ]]; then
  cat >&2 <<'MSG'

AD-18: stages are designed for kInternalSampleRate and nothing else. Sample-rate
conversion belongs at the boundary (dsp/boundary.h), never inside a stage.

MSG
  exit 1
fi

# The generated amp accepts a rate, so the rule becomes: our wrapper hands it
# the internal design rate and nothing else, ever.
# The amp lives inside the 4x window, so its design rate is the oversampled one.
# Either constant is a compile-time value; what is forbidden is a rate that came
# from the device.
if ! grep -q 'init(static_cast<int>(kOversampledSampleRate))' "${ROOT}/dsp/amp/amp.h"; then
  printf 'dsp/amp/amp.h must initialise the generated amp with kOversampledSampleRate:\n' >&2
  printf 'it runs inside the oversampling window, at four times the chain rate.\n' >&2
  exit 1
fi
if grep -nE 'void init\(.*(rate|Rate)' "${ROOT}/dsp/amp/amp.h"; then
  printf '\ndsp/amp/amp.h takes a sample rate. AD-18: a stage may not have one.\n' >&2
  exit 1
fi

printf 'stage isolation: %d stage files, none reads a device rate\n' "${#STAGE_FILES[@]}"
echo '                 the generated amp is given kInternalSampleRate and nothing else'
