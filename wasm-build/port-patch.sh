#!/usr/bin/env bash
# Port patch 0001 to the Lean commit upstream's assets were built from, and prove it applies cleanly.
#
#   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" \
#     -v "$PWD/wasm-build/patches:/patches" lean4-wasm-single-threaded /w/port-patch.sh [sha]
#
# Only hunk #1 needs work: hunks #2 and #3 apply to the July tree with an offset. Hunk #1 rewrites the
# Emscripten settings block, and that block changed between July and September — the July tree carried
# `-sDISABLE_EXCEPTION_CATCHING=0` (JS-emulated exceptions) where the September tree carries
# `-fwasm-exceptions` (native wasm EH), with a comment saying native EH miscompiled *on their emsdk 6*.
#
# The port keeps the patch's intent — native EH — because this harness builds on `emscripten/emsdk` 4.0.22,
# where native EH works: the artifact built from the September tree runs on it. That is a deliberate choice and
# the one real risk in the port; if the new artifact miscompiles, this line is the first thing to revisit.
#
# The patch file is rewritten in place, and the old one stays in git history. A tree carries exactly one
# commit's patches — that is already the rule `build.sh` enforces with `git apply -R --check`.
set -euo pipefail

SHA="${1:-62b6a2291302d4bbeace37642a066b7510d0145c}"
SRC=/cache/src
WORK=/cache/port
PATCH=/patches/0001-cmake-single-threaded.patch
NODE=/cache/node24/bin/node

cd "$SRC"
git worktree remove --force "$WORK" 2>/dev/null || true
rm -rf "$WORK"
git worktree add -q --detach "$WORK" "$SHA"

echo '--- applying what applies as written ---'
patch --batch -F3 -d "$WORK" -p1 <"$PATCH" || true
rm -f "$WORK"/src/CMakeLists.txt.rej "$WORK"/src/CMakeLists.txt.orig

echo '--- re-expressing hunk #1 by hand ---'
"$NODE" - <<'NODE'
const fs = require('fs');
const path = '/cache/port/src/CMakeLists.txt';
let source = fs.readFileSync(path, 'utf8');

const settings = [
	'set(EMSCRIPTEN_SETTINGS "-sDISABLE_EXCEPTION_CATCHING=0 -pthread")',
	'set(EMSCRIPTEN_SETTINGS "-fwasm-exceptions")'
];
if (!source.includes(settings[0]) && !source.includes(settings[1])) {
	console.error('neither Emscripten settings line found — the tree is not what this script expects');
	process.exit(1);
}

if (source.includes(settings[0])) {
	source = source.replace(settings[0], settings[1]);
}

const knobs = [
	'',
	'    # wasm-build: the initial wasm memory, as a knob, because it decides whether the `Init` import',
	'    # ever has to *grow* the memory. An unshared memory that grows can be relocated and copied, and',
	'    # the pthread build sidesteps the whole question by reserving its 2 GiB shared buffer up front',
	'    # (see the linker flags below). 64 MiB is upstream\'s value; a larger one trades boot-time RSS for',
	'    # a first compile that does not pay for growth.',
	'    set(LEAN_WASM_INITIAL_MEMORY "67108864" CACHE STRING "initial wasm memory in bytes")',
	'    set(LEAN_WASM_STACK_SIZE "16777216" CACHE STRING "wasm stack in bytes")',
	'',
	'    # wasm-build: instrument the sequential task manager, to answer whether the drain loop is where a',
	'    # first compile\'s time goes. Off by default; see the `drain` comment in runtime/object.cpp.',
	'    option(LEAN_WASM_DRAIN_PROFILE "profile the sequential task manager\'s drain loop" OFF)',
	'    if(LEAN_WASM_DRAIN_PROFILE)',
	'      string(APPEND LEAN_EXTRA_CXX_FLAGS " -D LEAN_WASM_DRAIN_PROFILE")',
	'    endif()'
].join('\n');

if (!source.includes('LEAN_WASM_INITIAL_MEMORY')) {
	const anchor = /^([ \t]*set\(EMSCRIPTEN_LINK_SETTINGS .*\))$/m;
	if (!anchor.test(source)) {
		console.error('no EMSCRIPTEN_LINK_SETTINGS line to anchor the knobs on');
		process.exit(1);
	}
	source = source.replace(anchor, `$1${knobs}`);
}

fs.writeFileSync(path, source);
console.log('hunk #1 re-expressed');
NODE

echo '--- regenerating the patch from this tree, before the runtime patch is applied ---'
# Order matters: regenerating after applying 0002 would fold object.cpp into 0001 and then 0002 would be
# applied a second time on top of itself.
git -C "$WORK" diff >"$PATCH"
echo "wrote $(wc -l <"$PATCH") lines to $PATCH"

echo '--- applying the runtime patch on top ---'
patch --batch -d "$WORK" -p1 < /patches/0002-sequential-task-manager.patch

echo '--- does the regenerated patch apply to a pristine tree? ---'
git worktree remove --force "$WORK" 2>/dev/null || true
rm -rf "$WORK"
git worktree add -q --detach "$WORK" "$SHA"
git -C "$WORK" apply --check -p1 "$PATCH" && echo 'applies cleanly'
git worktree remove --force "$WORK" 2>/dev/null || true