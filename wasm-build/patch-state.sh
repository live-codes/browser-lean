#!/usr/bin/env bash
# Report which of the patches in /patches a source tree currently carries.
#
#   docker run --rm --entrypoint bash -w /w \
#     -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" -v "$PWD/wasm-build/patches:/patches" \
#     lean4-wasm-single-threaded /w/patch-state.sh [tree]
#
# Each patch is tested by *reverse*-applying it with `--check`: if the tree already holds the patched
# content, the reverse applies cleanly. That is a fact about the tree.
#
# Not with `patch -R --dry-run`: in batch mode patch skips a patch it believes is already applied and still
# exits 0, so that check reports every patch as applied — including the one that was missing.
#
# The `.applied-variant-*` markers in the source tree are not evidence either: they record that some patch
# run happened for some variant *name*. A run whose variant argument was not recognised still writes its
# marker while applying only the patches that variant's number selects, which is how a build came out with no
# task manager in it and looked like a memory bug. Check the tree, not the marker.
set -uo pipefail

SRC="${1:-/cache/src}"
PATCHES="${2:-/patches}"

echo "tree: $SRC"
for p in "$PATCHES"/0*.patch; do
	if git -C "$SRC" apply -R --check -p1 "$p" >/dev/null 2>&1; then
		printf '  applied     %s\n' "$(basename "$p")"
	else
		printf '  NOT applied %s\n' "$(basename "$p")"
	fi
done
echo 'changed files in the tree (a runtime patch that is applied shows up here):'
git -C "$SRC" diff --stat | sed 's|^|  |'
echo 'markers (informational):'
ls -1 "$SRC"/.applied-variant-* 2>/dev/null | sed 's|.*/|  |' || echo '  none'
