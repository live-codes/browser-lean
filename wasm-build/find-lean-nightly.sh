#!/usr/bin/env bash
# Find the Lean nightly whose content is the commit this artifact was built from.
#
#   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" \
#     lean4-wasm-single-threaded /w/find-lean-nightly.sh
#
# Why a *nightly*: Mathlib pins Lean releases (`v4.34.0-rc2` was current on 2026-09-06, bumped 2026-08-21 and
# not again until 2026-09-15), and no nightly value appears anywhere in its toolchain history — so its
# published caches were built by release toolchains and an `.olean` is only readable by the compiler that
# wrote it. This artifact's commit is `dfe4953168…`, an upstream master commit, so the compatible compiler is
# a native Lean built at *that* commit, and a nightly is exactly a native toolchain built at one commit.
#
# A nightly's tree hash is a content hash, so comparing trees is exact — no guessing from dates or version
# strings, which is what made the earlier attempts waste time. The artifact's commit tree is
# `15016980109a50c40fcdd3f45c36026eb09f6bd9`, read from the GitHub API for dfe4953.
#
# With the nightly pinned, the remaining work needs no wasm at all: install it, fetch Mathlib's source as of
# that date, and compile the closure of `Mathlib.Data.Real.Basic` and `Mathlib.Tactic.Ring` into oleans whose
# githash is this artifact's. That is a long job (a toolchain download, a Mathlib checkout, and a native
# compile of a few thousand modules) but it is *additive* — it changes nothing about the artifact or the
# snapshots already working.
set -uo pipefail

TREE=15016980109a50c40fcdd3f45c36026eb09f6bd9
WORK=/cache/lean-nightly-probe
NIGHTS=(nightly-2026-09-06 nightly-2026-09-07 nightly-2026-09-08 nightly-2026-09-09)

mkdir -p "$WORK"
cd "$WORK"
if [ ! -d .git ]; then
	git init -q .
	git remote add origin https://github.com/leanprover/lean4-nightly
fi

for n in "${NIGHTS[@]}"; do
	if git fetch -q --depth 1 --filter=blob:none origin "refs/tags/${n}:refs/tags/${n}" 2>/dev/null; then
		got=$(git rev-parse "${n}^{tree}" 2>/dev/null)
		if [ "$got" = "$TREE" ]; then
			printf '%s  %s  MATCH\n' "$n" "$got"
		else
			printf '%s  %s\n' "$n" "$got"
		fi
	else
		printf '%s  (no such tag)\n' "$n"
	fi
done