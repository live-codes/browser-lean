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
	if [ -f "/bakeout/${name}.snap" ]; then
		echo "=== ${name}: already baked, leaving it ($(du -h "/bakeout/${name}.snap" | cut -f1))"
		return
	fi
	echo "=== ${name} from: $(printf '%s' "$probe" | head -1)"
	# The bake performs the import once and exits itself, so nothing after the run is reliable — check the
	# file rather than the exit status.
	"$NODE" /w/bake-snapshot.cjs "$ARTIFACT" /bakeout "$name" "$probe" 2>&1 | tail -4 || true
	if [ ! -f "/bakeout/${name}.snap" ]; then
		echo "no ${name}.snap was written — the output above says why" >&2
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
	*) echo "unknown snapshot name '${name}'" >&2; exit 2 ;;
	esac
done

ls -la /bakeout/*.snap
