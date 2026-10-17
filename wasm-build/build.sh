#!/bin/bash
# Build a single-threaded Lean 4 wasm. See README.md.
#
#   build.sh [1|2]        1 = the flags only (expected to fail — that failure is the measurement)
#                         2 = the flags plus the sequential task manager (default)
#
# The fork is pinned by commit, because the artifacts are only compatible with the tree that produced
# them (FINDINGS.md §5) and a branch head would drift under us.
set -euxo pipefail

VARIANT="${1:-2}"
FORK=https://github.com/cauli/lean4.git
# cauli/lean4 @ reinstate-wasm, 2026-09-06 — the revision FINDINGS.md §9 quotes.
PIN=dfe49531687435bcb38516a73a7c7ff55e3ef25e
# The source tree and the cmake build dir live on a mounted volume, not in the container: a relink after
# a code change is minutes, and re-cloning a 1 GB fork every run is not. `/cache` is bound by the run
# command (`-v "$PWD/cache:/cache"`); without it everything is rebuilt from scratch each time.
SRC="${LEAN_SRC:-/cache/src}"
OUT="/out/variant-$VARIANT"
BUILD_DIR="$SRC/build/wasm-$VARIANT"

mkdir -p "$OUT"

# ---- Source ---------------------------------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$FORK"
fi
if [ ! -f "$SRC/.pinned-$PIN" ]; then
  # Prefer the exact commit. GitHub does not always serve an unadvertised SHA, so fall back to the branch
  # head and *verify* — the patches are generated against this exact tree, and the oleans are only
  # compatible with the binary built from it, so silently building something else is worse than failing.
  if ! git -C "$SRC" fetch --depth 1 origin "$PIN" 2>/dev/null; then
    git -C "$SRC" fetch --depth 1 origin reinstate-wasm
  fi
  git -C "$SRC" checkout -q FETCH_HEAD
  actual="$(git -C "$SRC" rev-parse HEAD)"
  if [ "$actual" != "$PIN" ]; then
    echo "error: fetched $actual, expected $PIN" >&2
    echo "The fork branch moved. Update PIN and re-check patches/ before building." >&2
    exit 1
  fi
  touch "$SRC/.pinned-$PIN"
fi

# ---- Patches --------------------------------------------------------------------------------------
# 0001 is the flags. 0002 is the runtime change that the fork's own CMake says is required before the
# flags can work, and it is the part of this harness that is expected to need iterating on.
#
# Resuming matters here: resetting and re-applying the patches rewrites the patched files, which `make`
# reads as "sources changed" and answers by rebuilding stage0 — tens of minutes thrown away to change
# nothing. So the reset and the patches are skipped when the tree already carries this variant's diff,
# marked by a file in the source tree (which lives on the volume, so it survives the container).
# `RESET=1` forces it, which is what switching variants needs.
if [ "${RESET:-0}" = "1" ] || [ ! -f "$SRC/.applied-variant-$VARIANT" ]; then
  # The reset makes the tree pristine, so a patch that does not apply is a hard error rather than a
  # silently unpatched build — which would waste hours and then look like a runtime bug.
  git -C "$SRC" checkout -q -- .
  patch -d "$SRC" -p1 < /patches/0001-cmake-single-threaded.patch
  if [ "$VARIANT" = "2" ]; then
    patch -d "$SRC" -p1 < /patches/0002-sequential-task-manager.patch
  fi
  touch "$SRC/.applied-variant-$VARIANT"
else
  echo "tree already carries variant $VARIANT's patches; skipping the reset (RESET=1 to force one)"
fi
git -C "$SRC" diff --stat

# ---- Configure ------------------------------------------------------------------------------------
source "${EMSDK}/emsdk_env.sh"
# 32-bit stage0 links native libs through pkg-config; point it at the i386 dir.
export PKG_CONFIG_LIBDIR=/usr/lib/i386-linux-gnu/pkgconfig:/usr/share/pkgconfig
# Emscripten's acorn-optimizer needs a big Node heap for the ~100 MB lean.js.
export NODE_OPTIONS="--max-old-space-size=8192"
# OFF gives an artifact comparable in size to the pinned one; ON adds a name section and assertions,
# which is what you want while bringing this up.
EMSCRIPTEN_DEBUG="${EMSCRIPTEN_DEBUG:-OFF}"

mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

MULTI_THREAD_FLAG="-DMULTI_THREAD=ON"
if [ "$VARIANT" = "1" ]; then
  # The fork's stated direction: drop the macro, so the task manager is compiled out entirely.
  # Expect `IO.Promise.new` to panic during the Init import (FINDINGS.md §9.2).
  MULTI_THREAD_FLAG="-DMULTI_THREAD=OFF"
fi

cmake "$SRC" \
    -DCMAKE_C_COMPILER_WORKS=1 \
    "$MULTI_THREAD_FLAG" \
    -DSTAGE0_USE_GMP=OFF \
    -DSTAGE0_LEAN_EXTRA_CXX_FLAGS='-m32 -msse2 -mfpmath=sse' \
    -DSTAGE0_LEANC_OPTS='-m32 -msse2 -mfpmath=sse' \
    -DSTAGE0_LEAN_EXTRA_LINKER_FLAGS='-m32' \
    -DSTAGE0_CMAKE_CXX_COMPILER=clang++ \
    -DSTAGE0_CMAKE_C_COMPILER=clang \
    -DSTAGE0_CMAKE_EXECUTABLE_SUFFIX="" \
    -DUSE_GMP=OFF \
    -DMMAP=OFF \
    -DSTAGE0_MMAP=OFF \
    -DUSE_MIMALLOC=OFF \
    -DEMSCRIPTEN_DEBUG="$EMSCRIPTEN_DEBUG" \
    -DCMAKE_AR="${EMSDK}/upstream/emscripten/emar" \
    -DCMAKE_TOOLCHAIN_FILE="${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
    -DLEAN_INSTALL_SUFFIX=-linux_wasm32 \
    -DSTAGE0_CMAKE_LIBRARY_PATH=/usr/lib/i386-linux-gnu/

# ---- Build ----------------------------------------------------------------------------------------
make "${MAKE_TARGET:-stage1}" -j"$(nproc)"

# ---- Report ---------------------------------------------------------------------------------------
cp "$BUILD_DIR/stage1/bin/lean.js" "$OUT/"
cp "$BUILD_DIR/stage1/bin/lean.wasm" "$OUT/"
cp -r "$BUILD_DIR/stage1/lib/lean" "$OUT/olean"
git -C "$SRC" rev-parse HEAD > "$OUT/LEAN_COMMIT"
git -C "$SRC" diff > "$OUT/applied.patch"

echo
echo "========================================="
echo "Built variant $VARIANT into $OUT"
echo "  $(du -h "$OUT/lean.wasm" | cut -f1)  lean.wasm"
echo "  lean.js, lean.wasm, olean/ and LEAN_COMMIT written to $OUT"
echo
cat <<EOF

Now, from the repo root — the one question that decides whether this artifact is what
was asked for:

  node wasm-build/verify-memory.mjs out/variant-$VARIANT/lean.wasm

Then, if it says \`unshared\`:
  npm run start:no-isolation       # serve the demo without COOP/COEP
  # mirror the artifact and point the page at it, then run the §4 table

See wasm-build/README.md for what success has to look like, including the parts this
harness cannot check for you.
EOF
