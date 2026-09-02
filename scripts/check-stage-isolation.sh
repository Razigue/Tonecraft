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
mapfile -t STAGE_FILES < <(
  find "${ROOT}/dsp" -name '*.h' -o -name '*.cpp' \
    | grep -v '/boundary\.h$' \
    | grep -v '/bindings\.cpp$' \
    | grep -v '/resample/' \
    | grep -v '/params\.generated\.h$' \
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

printf 'stage isolation: %d stage files, none reads a device rate\n' "${#STAGE_FILES[@]}"
