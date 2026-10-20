#!/usr/bin/env bash
# Bake the snapshots a mirror ships: one per header that a demo program uses.
#
#   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" \
#     -v "$PWD/wasm-build/out:/out" -v "$PWD/wasm-build/out/bakeout:/bakeout" \
#     -e BAKE_LIB_ROOT=/cache/src/build/wasm-2/stage1/lib/lean \
#     lean4-wasm-single-threaded /w/bake-snapshots.sh [artifact-dir] [names...]
#
# A snapshot's cache key is the *header's import list*, read back out of the loaded environment, so it only
# helps a program whose imports match it exactly. `init` — no imports — covers anything that imports
# nothing. The others exist because on a single-threaded build the *import* is the expensive part of a first
# run: measured on the Std demo, the per-file fetch is 5 s and loading those 483 modules is 104 s.
#
# Baking is off-line and one-off: each run performs one import and writes a file. Expect minutes, and note
# that the snapshots are hundreds of MB — they trade bytes on the wire for the realization, which is worth it
# here and would deserve re-measuring on a real host.
set -euo pipefail

ARTIFACT="${1:-/cache/src/build/wasm-2/stage1/bin}"
shift || true
NODE=/cache/node24/bin/node

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
