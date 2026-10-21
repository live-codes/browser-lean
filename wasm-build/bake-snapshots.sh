#!/usr/bin/env bash
# Bake the snapshots a mirror ships: one per header that a demo program uses.
#
#   # once, on the host: build the tree the mirror serves
#   node wasm-build/build-bake-lib.mjs
#   # then, in the container (or on the host), bake against it
#   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" \
#     -v "$PWD/wasm-build/out:/out" -v "$PWD/wasm-build/out/bakeout:/bakeout" \
#     -e BAKE_LIB_ROOT=/out/bake-lib \
#     lean4-wasm-single-threaded /w/bake-snapshots.sh [artifact-dir] [names...]
#
# **Bake against `bake-lib`, not the artifact's own build tree.** The two `.olean` sets are identical except
# for a 40-byte githash, and that difference changes the saved environment 3.2×: against the artifact's tree
# Init/Std come out ~230/318 MB and Lean/Mathlib saves die in the serializer; against bake-lib they are
# 74/115/328/428 MB and all four succeed (FINDINGS §9.15). `build-upstream.sh` therefore does not bake.
#
# A snapshot's cache key is the *header's import list*, read back out of the loaded environment, so it only
# helps a program whose imports match it exactly. `init` — no imports — covers anything that imports
# nothing. The others exist because on a single-threaded build the *import* is the expensive part of a first
# run: measured on the Std demo, the per-file fetch is 5 s and loading those 483 modules is 104 s.
#
# Baking is off-line and one-off: each run performs one import and writes a file. Expect minutes.
set -euo pipefail

ARTIFACT="${1:-/out/variant-2}"
shift || true
NODE=/cache/node24/bin/node
BAKE_LIB_ROOT="${BAKE_LIB_ROOT:-/out/bake-lib}"
if [ ! -d "$BAKE_LIB_ROOT" ]; then
	echo "error: no bake library at ${BAKE_LIB_ROOT}" >&2
	echo "Bake against the tree the mirror serves, not the artifact's own build tree:" >&2
	echo "  node wasm-build/build-bake-lib.mjs          # on the host, into wasm-build/out/bake-lib" >&2
	echo "The trees differ only in the .olean githash; the artifact tree makes the environment 3.2x" >&2
	echo "larger and makes Lean/Mathlib saves die in the serializer (FINDINGS §9.15)." >&2
	exit 1
fi
export BAKE_LIB_ROOT

bake() { # <name> <probe>
	local name="$1" probe="$2"
	# Snapshots are valid only for the binary that baked them, so a rebuild invalidates every one of them and
	# `FORCE=1` is a requirement rather than a convenience — there is no "close enough" here, and the loader
	# cannot tell you otherwise: it is the deserializer that traps.
	if [ -f "/bakeout/${name}.snap" ] && [ "${FORCE:-0}" != "1" ]; then
		echo "=== ${name}: already baked, leaving it ($(du -h "/bakeout/${name}.snap" | cut -f1))"
		return
	fi
	echo "=== ${name} from: $(printf '%s' "$probe" | head -1)"
	# The bake performs the import once and exits itself, so nothing after the run is reliable — check the
	# file rather than the exit status.
	#
	# Keep the whole output in a file and show its tail. Piping straight through `tail` cost a diagnosis
	# here: the first Lean bake trapped, and the four lines that survived were the bottom of a stack — the
	# message that said why had already been dropped.
	#
	# `--stack-size`: saving the Lean environment overflowed the call stack, and that was measured *after* a
	# successful 2,308-module import and a successful elaboration — so it is the write, not the import, and
	# not memory either (which is what I assumed first). A flag rather than `-sSTACK_SIZE` deliberately: a
	# relink changes the binary, and a snapshot is valid only for the binary that baked it, so raising the
	# wasm stack that way would also mean re-baking Init and Std.
	"$NODE" --stack-size=4000 /w/bake-snapshot.cjs "$ARTIFACT" /bakeout "$name" "$probe" >"/bakeout/${name}.bake.log" 2>&1 || true
	tail -20 "/bakeout/${name}.bake.log" || true
	if [ ! -f "/bakeout/${name}.snap" ]; then
		echo "no ${name}.snap was written — /bakeout/${name}.bake.log has the whole run" >&2
		exit 1
	fi
	du -h "/bakeout/${name}.snap"
}

# Names in the order they matter. `init` first because it is the one upstream also ships and the one every
# program without imports uses.
if [ "$#" -gt 0 ]; then
	NAMES=("$@")
else
	NAMES=(init std lean)
fi

for name in "${NAMES[@]}"; do
	case "$name" in
	init) bake init '#check 2+2' ;;
	std) bake std 'import Std.Data.HashMap
#check 1' ;;
	lean) bake lean 'import Lean
#check 1' ;;
	# The probe has to *be* the header a program will use: the cache key is read back out of the loaded
	# environment, so `mathlib` covers the demo's program only if these are its two imports, in this order.
	mathlib) bake mathlib 'import Mathlib.Data.Real.Basic
import Mathlib.Tactic.Ring
#check 1' ;;
	*) echo "unknown snapshot name '${name}'" >&2; exit 2 ;;
	esac
done

ls -la /bakeout/*.snap
