#!/usr/bin/env bash
# Compiles dsp/amp/faust/amp.dsp to C++ (AD-7's rule applies here too: the
# generated file is build output, never committed and never hand-edited).
#
# Faust is a code generator, not a runtime. Nothing from @grame/faustwasm ships:
# its AudioWorkletNode would be a second processor, which AD-1 forbids, and its
# own buffer ABI would sit outside the stage contract in AD-19. What we take is
# the generated C++, wrapped to fit that contract and compiled into the one
# module.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/dsp/amp/faust/amp.dsp"
OUT="${ROOT}/dsp/amp/faust/amp.generated.h"

command -v faust >/dev/null || {
  echo "faust is not installed. On Debian or Ubuntu: sudo apt-get install faust" >&2
  exit 1
}

faust -lang cpp -cn AmpDsp -uim -o "${OUT}" "${SRC}"

# The generated file names `dsp`, `UI` and `Meta`, which we provide ourselves in
# faust-runtime.h rather than pulling in Faust's architecture headers. Both live
# in our namespace, so the generated class joins them there.
python3 - "${OUT}" <<'PY'
import sys, pathlib

p = pathlib.Path(sys.argv[1])
lines = p.read_text().split("\n")

# The namespace has to open *after* the generated file's own #includes, or the
# standard headers land inside it and <algorithm> ends up as tonecraft::.
last_include = max(i for i, l in enumerate(lines) if l.startswith("#include"))

banner = [
    "// GENERATED FILE - DO NOT EDIT.",
    "// Produced by scripts/build-amp.sh from dsp/amp/faust/amp.dsp.",
    "// Edit the .dsp and rebuild; edits here are discarded.",
    "",
]
opening = ['#include "faust-runtime.h"', "", "namespace tonecraft {", ""]
# Faust assigns the fHslider indices itself and reorders them whenever the .dsp
# changes. Hard-coding them in C++ would mean a rename or a new control silently
# repointing "bass" at the gain. So the binding is generated from the compiler's
# own -uim output, and a missing control fails the build rather than the ear.
import re

sliders = dict(
    re.findall(r'FAUST_ADDHORIZONTALSLIDER\("([^"]+)", (fHslider\d+)', "\n".join(lines))
)
expected = {"gain", "bass", "mid", "treble", "master"}
missing = expected - set(sliders)
if missing:
    sys.exit(f"amp.dsp does not declare: {', '.join(sorted(missing))}")
extra = set(sliders) - expected
if extra:
    sys.exit(f"amp.dsp declares controls nothing reads: {', '.join(sorted(extra))}")

binding = ["", "// Generated control binding — see scripts/build-amp.sh.", ""]
for name in sorted(expected):
    binding.append(
        f"inline void ampSet{name.capitalize()}(AmpDsp& d, float v) "
        f"{{ d.{sliders[name]} = v; }}"
    )

out = banner + lines[: last_include + 1] + opening + lines[last_include + 1 :]
out += binding + ["", "}  // namespace tonecraft", ""]
p.write_text("\n".join(out))
PY

printf 'amp: wrote dsp/amp/faust/amp.generated.h (%s lines)\n' "$(wc -l < "${OUT}")"
