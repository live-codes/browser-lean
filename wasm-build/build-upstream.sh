#!/usr/bin/env bash
# Build the single-threaded wasm at the Lean commit upstream's assets were built from. After this, upstream's
# core layer, per-file tree *and* Mathlib layer are readable — which is the only route to a working Mathlib
# here that does not involve building Mathlib (FINDINGS §9.9, §9.12).
#
# Snapshots are deliberately *not* baked here. They have to be baked against `wasm-build/out/bake-lib` — the
# tree the assembled mirror serves — not the artifact's own `stage1/lib/lean`. The two trees differ only in
# the 40-byte `.olean` githash, and that is the difference between a 3.2× larger environment (and Lean/Mathlib
# saves dying in the serializer) and the snapshots this repo ships (FINDINGS §9.15). The host steps after this
# build are in HANDOVER.md §3: assemble the mirror, build bake-lib, then bake.
#
#   docker run --rm --entrypoint bash -w /w \
#     -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" -v "$PWD/wasm-build/patches:/patches" \
#     -v "$PWD/wasm-build/out:/out" -v "$PWD/wasm-build/out/bakeout:/bakeout" \
#     lean4-wasm-single-threaded /w/build-upstream.sh
#
# Long: a fresh clone (the cached tree belongs to the other commit) and a full stage0 + stage1 build. Olean
# copying is skipped on purpose — this artifact's library comes from upstream, not from this build.
set -euo pipefail

SHA=62b6a2291302d4bbeace37642a066b7510d0145c
SRC=/cache/src-upstream

echo "=== building ${SHA} (fresh tree at ${SRC})"
LEAN_SRC="$SRC" LEAN_PIN="$SHA" \
	LEAN_INITIAL_MEMORY=2147483648 LEAN_WASM_STACK_SIZE=268435456 DRAIN_PROFILE=1 SKIP_OLEAN_COPY=1 \
	/w/build.sh 2

echo '=== build finished'
echo '    Snapshots are baked on the host, against the tree the mirror serves:'
echo '      node wasm-build/assemble-upstream-mirror.mjs'
echo '      node wasm-build/build-bake-lib.mjs'
echo '      node --stack-size=4000 wasm-build/bake-snapshot.cjs wasm-build/out/variant-2 wasm-build/out/bakeout <name> "<probe>"'
echo '    (HANDOVER.md §3 has the full sequence and the probe for each name.)'

ls -la /out/variant-2/