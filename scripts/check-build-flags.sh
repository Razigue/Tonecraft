#!/usr/bin/env bash
# AD-4: relaxed SIMD must appear in no build configuration, ever.
#
# It is the tempting optimisation — it maps straight onto native instructions
# and it is measurably faster. It is also defined to permit engine-specific
# floating-point rounding, which would make a shared tone link render
# differently per browser. A future developer chasing CPU will reach for it; a
# comment would not stop them, so this does.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIGS=(
  "${ROOT}/dsp/build.sh"
  "${ROOT}/package.json"
  "${ROOT}/.github/workflows/deploy.yml"
)

status=0
for file in "${CONFIGS[@]}"; do
  [[ -f "${file}" ]] || continue
  if grep -n -- '-mrelaxed-simd\|relaxed_simd\|RELAXED_SIMD' "${file}" \
     | grep -v 'FORBIDDEN\|forbidden\|must appear in no'; then
    printf '\n  %s enables relaxed SIMD.\n' "${file#"${ROOT}/"}" >&2
    status=1
  fi
done

if [[ ${status} -ne 0 ]]; then
  cat >&2 <<'MSG'

AD-4 forbids relaxed SIMD. It permits engine-specific float rounding, so the
same tone state would render differently in different browsers and every shared
tone link would be a lie. Build with -msimd128 only.

MSG
  exit 1
fi

# And the flags that must be there.
for flag in -O3 -msimd128 -flto -fno-exceptions -fno-rtti; do
  grep -q -- "${flag}" "${ROOT}/dsp/build.sh" || {
    printf 'dsp/build.sh is missing the required flag %s (NFR-14).\n' "${flag}" >&2
    exit 1
  }
done

echo 'build flags: -msimd128 only, no relaxed SIMD, NFR-14 flags present'
