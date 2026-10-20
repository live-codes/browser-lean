#!/usr/bin/env bash
# Can this harness build the single-threaded wasm at the Lean commit upstream's assets were built from?
#
#   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" \
#     -v "$PWD/wasm-build/patches:/patches" lean4-wasm-single-threaded /w/check-upstream-commit.sh [sha]
#
# Upstream's core layer, lib tree and Mathlib layer are all built by Lean `62b6a229…`, and an `.olean` is only
# readable by the compiler that wrote it (FINDINGS §9.9, §9.12). This artifact is `dfe4953…`, so none of those
# assets can be read here — which is why Mathlib worked with the pinned pthread artifact and stopped working
# when the artifact became fork-built. Building at *their* commit makes every one of those assets compatible at
# once, and is the only route to a working Mathlib that does not involve building Mathlib.
#
# Three things could stop that, and this checks them before anything long starts: the commit is fetchable, it
# carries the wasm exports this harness needs, and the patches apply to its tree. The patches are generated
# against dfe4953, so a failure here is informative rather than fatal — `patch-stack-knob.sh` shows how to
# regenerate them against a different tree.
set -uo pipefail

SHA="${1:-62b6a2291302d4bbeace37642a066b7510d0145c}"
SRC=/cache/src
WORK=/cache/upstream-check

cd "$SRC" || exit 1
echo "--- fetching ${SHA} ---"
git fetch -q --depth 1 origin "$SHA" 2>/dev/null || echo 'fetch failed (the fork may not have it)'
if git cat-file -e "${SHA}^{commit}" 2>/dev/null; then
	echo 'commit present'
else
	echo "commit absent — ${SHA} cannot be built from this remote"
	exit 1
fi
git log -1 --format='%h %ad %s' --date=short "$SHA"

echo '--- wasm exports this harness needs ---'
for fn in lean_wasm_compile lean_wasm_load_snapshot lean_wasm_reset; do
	printf '  %s: %s\n' "$fn" "$(git show "${SHA}:src/emscripten-exports.txt" 2>/dev/null | grep -c "^_${fn}$")"
done

echo '--- patches against that tree (applied cumulatively) ---'
rm -rf "$WORK"
git worktree add -q --detach "$WORK" "$SHA" 2>/dev/null || {
	echo 'worktree failed'
	exit 1
}
for p in /patches/0001-cmake-single-threaded.patch /patches/0002-sequential-task-manager.patch; do
	if patch --batch -d "$WORK" -p1 <"$p" >/tmp/patch.out 2>&1; then
		echo "  applied: $(basename "$p")"
	else
		echo "  FAILED:  $(basename "$p")"
		sed -n '1,4p' /tmp/patch.out | sed 's/^/    /'
	fi
done
git worktree remove --force "$WORK" 2>/dev/null || rm -rf "$WORK"