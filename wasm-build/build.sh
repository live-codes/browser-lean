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
SRC=/src
OUT="/out/variant-$VARIANT"

mkdir -p "$OUT"

# ---- Source ---------------------------------------------------------------------------------------
if [ ! -d "$SRC/.git" ]; then
  git init -q "$SRC"
  git -C "$SRC" remote add origin "$FORK"
fi
if [ ! -f "$SRC/.pinned-$PIN" ]; then
  git -C "$SRC" fetch --depth 1 origin "$PIN"
  git -C "$SRC" checkout -q FETCH_HEAD
  touch "$SRC/.pinned-$PIN"
fi

# ---- Patches --------------------------------------------------------------------------------------
# 0001 is the flags. 0002 is the runtime change that the fork's own CMake says is required before the
# flags can work, and it is the part of this harness that is expected to need iterating on.
git -C "$SRC" checkout -q -- . 
patch -d "$SRC" -p1 --forward < /patches/0001-cmake-single-threaded.patch
if [ "$VARIANT" = "2" ]; then
  patch -d "$SRC" -p1 --forward < /patches/0002-sequential-task-manager.patch
fi

# ---- Configure ------------------------------------------------------------------------------------
source "${EMSDK}/emsdk_env.sh"
# 32-bit stage0 links native libs through pkg-config; point it at the i386 dir.
export PKG_CONFIG_LIBDIR=/usr/lib/i386-linux-gnu/pkgconfig:/usr/share/pkgconfig
# Emscripten's acorn-optimizer needs a big Node heap for the ~100 MB lean.js.
export NODE_OPTIONS="--max-old-space-size=8192"
# OFF gives an artifact comparable in size to the pinned one; ON adds a name section and assertions,
# which is what you want while bringing this up.
EMSCRIPTEN_DEBUG="${EMSCRIPTEN_DEBUG:-OFF}"

mkdir -p "$SRC/build/wasm"
cd "$SRC/build/wasm"

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
    -DEMSCRIPTEN_DEBUG="$EMSCRIPTEN_DEBUG" \
    -DCMAKE_AR="${EMSDK}/upstream/emscripten/emar" \
    -DCMAKE_TOOLCHAIN_FILE="${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
    -DLEAN_INSTALL_SUFFIX=-linux_wasm32 \
    -DSTAGE0_CMAKE_LIBRARY_PATH=/usr/lib/i386-linux-gnu/

# ---- Build ----------------------------------------------------------------------------------------
make "${MAKE_TARGET:-stage1}" -j"$(nproc)"

# ---- Report ---------------------------------------------------------------------------------------
cp "$SRC/build/wasm/stage1/bin/lean.js" "$OUT/"
cp "$SRC/build/wasm/stage1/bin/lean.wasm" "$OUT/"
cp -r "$SRC/build/wasm/stage1/lib/lean" "$OUT/olean"
git -C "$SRC" rev-parse HEAD > "$OUT/LEAN_COMMIT"

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
