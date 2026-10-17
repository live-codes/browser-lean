#!/usr/bin/env bash
# Bake a snapshot against the artifact in a build tree, then install that artifact and the snapshot into the
# local mirror the demo serves from. Run inside the build container:
#
#   docker run --rm --entrypoint bash -w /w \
#     -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" -v "$PWD/wasm-build/out:/out" \
#     -v "$PWD/wasm-build/out/bakeout:/bakeout" \
#     lean4-wasm-single-threaded /w/bake-and-install.sh [build-name]
#
# `build-name` defaults to wasm-2, the single-threaded build tree. The artifact and snapshot have to come from
# the same build: the loader checks the snapshot against the binary that reads it.
set -euo pipefail

BUILD_NAME="${1:-wasm-2}"
TREE="/cache/src/build/${BUILD_NAME}"
NODE=/cache/node24/bin/node
MIRROR=/out/mirror/lean-wasm
SNAPSHOTS="${MIRROR}/snapshots"

# Node 24, not the image's 22: this artifact exports 104,692 functions and an older Node refuses to
# instantiate anything above 100,000.
if [ ! -x "$NODE" ]; then
  echo "no Node 24 at ${NODE}; fetch one into the cache volume first (see wasm-build/README.md)" >&2
  exit 1
fi
if [ ! -f "${TREE}/stage1/bin/lean.js" ]; then
  echo "no artifact at ${TREE}/stage1/bin — build it first" >&2
  exit 1
fi

BAKE_LIB_ROOT="${BAKE_LIB_ROOT:-${TREE}/stage1/lib/lean}" "$NODE" /w/bake-snapshot.cjs "${TREE}/stage1/bin" /bakeout init

mkdir -p "$SNAPSHOTS"
cp "${TREE}/stage1/bin/lean.js" "${TREE}/stage1/bin/lean.wasm" "${MIRROR}/"
cp /bakeout/init.snap /bakeout/init.snap.deps "${SNAPSHOTS}/"
ls -la "${MIRROR}/" "${SNAPSHOTS}/"
