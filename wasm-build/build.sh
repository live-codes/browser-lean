#!/bin/bash
# Build a single-threaded Lean 4 wasm. See README.md.
#
#   build.sh [1|2]        1 = the flags only (expected to fail — that failure is the measurement)
#                         2 = the flags plus the sequential task manager (default)
#
# The fork is pinned by commit, because the artifacts are only compatible with the tree that produced
# them (FINDINGS.md §5) and a branch head would drift under us.
set -euxo pipefail

# Accept the names the run commands use, and refuse anything else. This matters more than it looks: the
# patch selection below is a `case`, so an unrecognised variant name skips the runtime patch *and* still gets
# an applied-marker of its own — which is how a build came out with no task manager in it and was read as a
# memory bug. An argument that is not understood is a hard error here.
VARIANT_ARG="${1:-2}"
VARIANT="${VARIANT_ARG#variant-}"
VARIANT="${VARIANT#wasm-}"
case "$VARIANT" in
  1|2|3) ;;
  *) echo "error: unknown variant '${VARIANT_ARG}' — expected 1, 2 or 3 ('wasm-2' and 'variant-2' are accepted)" >&2; exit 2 ;;
esac
FORK=https://github.com/cauli/lean4.git
# cauli/lean4 @ reinstate-wasm, 2026-09-06 — the revision FINDINGS.md §9 quotes.
# The fork commit to build. Overridable so the same harness can build the commit *upstream's* assets were
# built from, which is the only way those assets — core layer, per-file tree, Mathlib layer — become readable
# here: an `.olean` is only readable by the compiler that wrote it. Point `LEAN_SRC` at a second clone when
# doing that, so the cached build tree for the other commit survives.
PIN="${LEAN_PIN:-dfe49531687435bcb38516a73a7c7ff55e3ef25e}"
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
# nothing. So the reset is skipped when the tree already carries this variant's patches.
#
# Whether it does is *asked of the tree*, not remembered. An earlier version kept a marker file per variant
# name and trusted it; a run whose variant argument was not 1, 2 or 3 skipped the runtime patch, wrote the
# marker anyway, and the next run then skipped the reset and built without it.
#
# `patch --batch -R --dry-run` is not the question to ask: in batch mode patch skips a patch it believes is
# already applied and still exits 0, so it reports every patch as applied. `git apply -R --check` asks the
# real one — can this patch be reversed out of the tree? — and fails when it cannot.
variant_patches() {
  echo "/patches/0001-cmake-single-threaded.patch"
  case "$1" in
    2) echo "/patches/0002-sequential-task-manager.patch" ;;
    3) echo "/patches/0003-unthreaded-promise-shim.patch" ;;
  esac
}

patch_is_applied() { git -C "$SRC" apply -R --check -p1 "$1" >/dev/null 2>&1; }

# "Exactly these", not "at least these": variant 1 is the flags-only measurement, and a tree still carrying
# the runtime patch would quietly measure something else.
patches_match() {
  local p
  for p in /patches/0*.patch; do
    if printf '%s\n' "$1" | grep -qx -- "$p"; then
      patch_is_applied "$p" || return 1
    else
      patch_is_applied "$p" && return 1
    fi
  done
  return 0
}

WANTED="$(variant_patches "$VARIANT")"
for p in $WANTED; do
  [ -f "$p" ] || { echo "error: missing patch ${p}" >&2; exit 1; }
done

if [ "${RESET:-0}" = "1" ] || ! patches_match "$WANTED"; then
  # The reset makes the tree pristine, so a patch that does not apply is a hard error rather than a
  # silently unpatched build — which would waste hours and then look like a runtime bug.
  git -C "$SRC" checkout -q -- .
  # `--batch` so a patch that does not apply is a hard failure. Without it patch asks "File to patch:" and
  # reads its answer from *stdin* — which is the patch file — so it consumes hunks as replies and carries
  # on having applied nothing, which then looks like a flags problem hours later.
  for p in $WANTED; do patch --batch -d "$SRC" -p1 <"$p"; done
else
  echo "tree already carries variant ${VARIANT}'s patches; skipping the reset (RESET=1 to force one)"
fi

# Verify. Both ways this goes wrong — a patch that quietly did not apply, and a tree left patched for a
# different variant — produce a binary that links, boots, and then misbehaves a long way from the cause.
if ! patches_match "$WANTED"; then
  echo "error: ${SRC} does not carry exactly variant ${VARIANT}'s patches; refusing to build" >&2
  for p in /patches/0*.patch; do
    if patch_is_applied "$p"; then echo "  applied: $(basename "$p")" >&2; else echo "  missing: $(basename "$p")" >&2; fi
  done
  exit 1
fi
touch "$SRC/.applied-variant-$VARIANT"
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

# 1 and 3 drop the macro. 1 is the flags-only measurement — the fork's stated direction, where the task
# manager is compiled out and `IO.Promise.new` panics during the `Init` import. 3 adds the promise/IO shim
# that makes a manager-less runtime work, so the same configuration can actually be measured.
# Initialised empty for the variants that keep the macro: passing it empty is fine, leaving it unset is not,
# since this script runs under `set -u`.
MULTI_THREAD_FLAG=""
if [ "$VARIANT" = "1" ] || [ "$VARIANT" = "3" ]; then
  MULTI_THREAD_FLAG="-DMULTI_THREAD=OFF"
fi

# Two experiment knobs, passed through so measuring does not need a patch edit:
#   LEAN_INITIAL_MEMORY — the wasm memory's initial size in bytes (default: upstream's 64 MiB). It decides
#                         whether the `Init` import ever has to grow an unshared memory.
#   DRAIN_PROFILE=1     — instrument the sequential task manager's drain loop.
#
# The comments live above the invocation, not inside it: a `#` on a backslash-continued line ends the
# command there, and the rest of these arguments would go to a second, nonsense `cmake`.
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
    -DLEAN_WASM_INITIAL_MEMORY="${LEAN_INITIAL_MEMORY:-67108864}" \
    -DLEAN_WASM_STACK_SIZE="${LEAN_WASM_STACK_SIZE:-16777216}" \
    -DLEAN_WASM_DRAIN_PROFILE="${DRAIN_PROFILE:-OFF}" \
    -DEMSCRIPTEN_DEBUG="$EMSCRIPTEN_DEBUG" \
    -DCMAKE_AR="${EMSDK}/upstream/emscripten/emar" \
    -DCMAKE_TOOLCHAIN_FILE="${EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake" \
    -DLEAN_INSTALL_SUFFIX=-linux_wasm32 \
    -DSTAGE0_CMAKE_LIBRARY_PATH=/usr/lib/i386-linux-gnu/

# ---- Build ----------------------------------------------------------------------------------------
make "${MAKE_TARGET:-stage1}" -j"$(nproc)"

# ---- Report ---------------------------------------------------------------------------------------
# `rm -rf` first: on a re-run the directory exists, and `cp -r src dest` with an existing dest copies
# *into* it — leaving `olean/olean/` and silently halving what the packer then finds.
#
# SKIP_OLEAN_COPY=1 for a relink iteration: the oleans do not change when only C++ flags change, and copying
# 2.2 GB / 32k files across a Docker Desktop bind mount costs ~25 minutes — which was, by a wide margin,
# the slowest part of an otherwise ten-minute experiment loop.
cp "$BUILD_DIR/stage1/bin/lean.js" "$OUT/"
cp "$BUILD_DIR/stage1/bin/lean.wasm" "$OUT/"
if [ "${SKIP_OLEAN_COPY:-0}" = "1" ]; then
  echo "skipping the olean copy (SKIP_OLEAN_COPY=1) — reusing the ones already in $OUT"
else
  rm -rf "$OUT/olean"
  cp -r "$BUILD_DIR/stage1/lib/lean" "$OUT/olean"
fi
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
