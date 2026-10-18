#!/usr/bin/env bash
# Pin the Mathlib revision whose Lean is the one this artifact was built from.
#
#   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" \
#     lean4-wasm-single-threaded /w/pin-mathlib.sh
#
# Why this is the route: FINDINGS §9.9 established that upstream's Mathlib layer is oleans built by *their*
# Lean commit (62b6a229) while this artifact is dfe4953, and an `.olean` is only readable by the compiler that
# wrote it. But dfe4953 is an upstream `leanprover/lean4` master commit (2026-09-06), and Mathlib publishes
# prebuilt oleans for the Lean master nightlies it tracks (`lake exe cache get`). So the compatible source is
# Mathlib's cache at the revision whose `lean-toolchain` is the nightly whose head is dfe4953 — not upstream's
# layer.
#
# This script only *pins* that: it clones Mathlib's history without blobs (commits are cheap, files are
# fetched on demand) and prints the revisions that changed `lean-toolchain` around the date, plus the current
# value. Downloading a toolchain and a cache is the expensive part and should not start until the revision is
# known.
set -uo pipefail

META=/cache/mathlib-meta
TARGET_DATE=2026-09-06

command -v git >/dev/null || { echo 'no git' >&2; exit 1; }
echo "--- disk ---"
df -h /cache | tail -2

if [ ! -d "$META/.git" ]; then
	echo "--- cloning Mathlib history, without blobs (this is the slow part) ---"
	git clone --filter=blob:none --no-checkout --quiet https://github.com/leanprover-community/mathlib4 "$META" || exit 1
fi

cd "$META"
echo "--- lean-toolchain revisions around ${TARGET_DATE}, newest first ---"
git log --format='%h %ad %s' --date=short -- lean-toolchain 2>/dev/null | head -30

echo "--- the toolchain values those revisions set, around the date ---"
for sha in $(git log --format='%h' --date=short --since="${TARGET_DATE} - 4 days" --until="${TARGET_DATE} + 6 days" -- lean-toolchain 2>/dev/null | head -12); do
	value=$(git show "${sha}:lean-toolchain" 2>/dev/null | tr -d '\r\n')
	echo "${sha}  $(git log -1 --format=%ad --date=short "$sha")  ${value}"
done

echo '--- candidates: nightlies near the artifact commit, and the Mathlib revision for each ---'
for night in nightly-2026-09-06 nightly-2026-09-07 nightly-2026-09-08; do
	sha=$(git log -1 --format=%H -S "$night" -- lean-toolchain 2>/dev/null | head -1)
	if [ -n "$sha" ]; then
		echo "${night}  ->  ${sha}  ($(git log -1 --format=%ad --date=short "$sha"))"
	else
		echo "${night}  ->  not found in this history"
	fi
done

# `master` tracks *releases* (`v4.34.0-rc2` was current on 2026-09-06, bumped 2026-08-21 and not again until
# 2026-09-15), so no nightly value appears in that history at all — which is what the searches above found.
# Mathlib's CI is what follows Lean nightlies, on one branch per nightly, and those branches are what carry a
# cache built by a nightly.
echo '--- nightly-testing branches ---'
git branch -r 2>/dev/null | grep -o 'nightly-testing-[0-9-]*' | sort -u | tail -20
echo '--- their toolchains, newest few ---'
for b in $(git branch -r 2>/dev/null | grep -o 'nightly-testing-[0-9-]*' | sort -u | tail -8); do
	printf '%s  %s\n' "$b" "$(git show "origin/${b}:lean-toolchain" 2>/dev/null | tr -d '\r\n')"
done