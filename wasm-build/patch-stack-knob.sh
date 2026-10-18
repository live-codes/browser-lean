#!/usr/bin/env bash
# Give the wasm stack a build knob, by regenerating patch 0001 from a real tree.
#
#   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" \
#     lean4-wasm-single-threaded /w/patch-stack-knob.sh
#
# `-sSTACK_SIZE` is a literal 16 MiB inside the patch. That is already a raised value — the fork raised it
# from Emscripten's 64 KB default because with no worker threads the import runs on the main wasm stack — and
# *saving* a Lean-sized environment overflows it: the import completes (2,308 modules) and the probe
# elaborates, then the write dies in deep wasm recursion. Raising it again is the same fix one order of
# magnitude up, so it becomes a knob.
#
# The patch is regenerated rather than edited: hand-editing a hunk shifts the line counts in its `@@` headers
# and `patch` then refuses the file, a failure mode this repo has already paid for once.
set -euo pipefail

SRC=/cache/src
PATCH=/w/patches/0001-cmake-single-threaded.patch

cd "$SRC"
git checkout -q -- .
patch --batch -d "$SRC" -p1 <"$PATCH"

sed -i 's/-s STACK_SIZE=16777216/-s STACK_SIZE=${LEAN_WASM_STACK_SIZE}/' src/CMakeLists.txt
sed -i 's|^\(    set(LEAN_WASM_INITIAL_MEMORY .*\)$|\1\n    set(LEAN_WASM_STACK_SIZE "16777216" CACHE STRING "wasm stack in bytes")|' src/CMakeLists.txt

echo '--- the two lines that changed ---'
grep -n 'LEAN_WASM_STACK_SIZE\|STACK_SIZE' src/CMakeLists.txt

git diff >"$PATCH"
echo "regenerated ${PATCH}: $(wc -l <"$PATCH") lines"

# It has to survive both directions: apply to a pristine tree, and reverse out of this one — which is the
# check `build.sh` makes to decide whether the tree already carries this variant's patches.
git checkout -q -- .
git apply --check -p1 <"$PATCH" && echo 'applies cleanly to a pristine tree'