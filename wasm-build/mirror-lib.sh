#!/usr/bin/env bash
# Mirror Std/Lean/Batteries from a build tree into a mirror's lean-lib/, with the index the runtime probes.
#
#   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build/out:/out" \
#     lean4-wasm-single-threaded /w/mirror-lib.sh [build-name] [mirror-dir]
#
# Why the build tree and not upstream: the fork-built artifact's core layer is dfe4953, while upstream's
# per-file tree is built by 62b6a229 — `lean-wasm-fetch-assets` refuses that mixture, and it is right to,
# because an `.olean` is only readable by the compiler that wrote it. A single-threaded fork build therefore
# has to mirror its *own* library, and the build tree already holds all 32k files; this packs up the three
# roots that are fetched on demand.
#
# `Init` is not here on purpose: it is packed into the core layer the runtime always loads.
set -euo pipefail

BUILD_NAME="${1:-wasm-2}"
MIRROR="${2:-/out/mirror}"
LIB_ROOT="/cache/src/build/${BUILD_NAME}/stage1/lib/lean"
DEST="${MIRROR}/lean-lib"
ROOTS=(Std Lean Batteries)

[ -d "${LIB_ROOT}/Std" ] || { echo "no Std in ${LIB_ROOT} — build that tree first" >&2; exit 1; }

mkdir -p "$DEST"
for root in "${ROOTS[@]}"; do
	if [ ! -d "${LIB_ROOT}/${root}" ]; then
		echo "note: no ${root} in this tree, skipping" >&2
		continue
	fi
	# .olean, .ir and .ir.sig travel together: an .ir is only read when its .ir.sig is present.
	(cd "$LIB_ROOT" && find "$root" -type f \( -name '*.olean' -o -name '*.ir' -o -name '*.ir.sig' \) -print0 |
		xargs -0 -r cp --parents -t "$DEST")
	echo "${root}: $(find "${DEST}/${root}" -name '*.olean' | wc -l) modules"
done

# The index is a JSON array of `.olean` paths — the one file the runtime probes to learn how the directory is
# stored. Written plain and not `.gz`, because a `.gz` index tells the runtime to expect every module
# compressed too; mixing the two layouts breaks the tree rather than degrading it.
(
	cd "$DEST"
	find "${ROOTS[@]}" -name '*.olean' 2>/dev/null | sort | sed 's/^/  "/; s/$/",/' | sed '$ s/,$//' | sed '1i [' | sed '$a ]'
) >"${DEST}/lean-lib-files.json"
echo "index: $(find "$DEST" -name '*.olean' | wc -l) modules listed"
du -sh "$DEST"
