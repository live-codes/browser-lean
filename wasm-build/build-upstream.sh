#!/usr/bin/env bash
# Build the single-threaded wasm at the Lean commit upstream's assets were built from, and bake the snapshots
# against it. After this, upstream's core layer, per-file tree *and* Mathlib layer are all readable — which is
# the only route to a working Mathlib here that does not involve building Mathlib (FINDINGS §9.9, §9.12).
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
ARTIFACT="$SRC/build/wasm-2/stage1/bin"

echo "=== building ${SHA} (fresh tree at ${SRC})"
LEAN_SRC="$SRC" LEAN_PIN="$SHA" \
	LEAN_INITIAL_MEMORY=2147483648 LEAN_WASM_STACK_SIZE=268435456 DRAIN_PROFILE=1 SKIP_OLEAN_COPY=1 \
	/w/build.sh 2

echo '=== baking init and std against the new artifact (snapshots are per-binary)'
FORCE=1 BAKE_LIB_ROOT="${SRC}/build/wasm-2/stage1/lib/lean" /w/bake-snapshots.sh "$ARTIFACT" init std

echo '=== done'
ls -la /out/variant-2/
ls -la /bakeout/