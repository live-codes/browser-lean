#!/usr/bin/env bash
# Slice a packed layer into individual oleans inside a build tree's library, so the CLI can import it.
#
#   docker run --rm --entrypoint bash -w /w \
#     -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" -v "$PWD/wasm-build/out:/out" \
#     lean4-wasm-single-threaded /w/unpack-layer.sh [layer-dir] [lib-root]
#
# The runtime slices packs into MEMFS when it loads a layer (`loadPackedLayer`). A *bake* needs the same files
# on disk instead, because the CLI resolves modules from `LEAN_PATH` and imports them: Mathlib is published
# only as packs, so without this a Mathlib snapshot cannot even be attempted.
#
# `pack.bytes` is the *uncompressed* length, which is what makes the size check meaningful — verified by hand
# on one pack: 6,109,959 bytes on the wire, 16,761,836 after gunzip.
set -euo pipefail

LAYER="${1:-/out/mirror-upstream/lean-mathlib}"
LIB="${2:-/cache/src-upstream/build/wasm-2/stage1/lib/lean}"
NODE=/cache/node24/bin/node

"$NODE" - "$LAYER" "$LIB" <<'NODE'
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const [layer, lib] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(layer, 'real-analysis-layer.json'), 'utf8'));

let written = 0;
for (const pack of manifest.packs) {
	const file = path.join(layer, pack.file);
	if (!fs.existsSync(file)) {
		console.error(`missing ${pack.file}`);
		process.exit(1);
	}
	const raw = zlib.gunzipSync(fs.readFileSync(file));
	if (raw.length !== pack.bytes) {
		console.error(`${pack.file}: ${raw.length} bytes, manifest says ${pack.bytes}`);
		process.exit(1);
	}
	for (const entry of pack.entries) {
		const target = path.join(lib, entry.path);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, raw.subarray(entry.offset, entry.offset + entry.bytes));
		written += 1;
	}
}
console.log(`unpacked ${written} files from ${manifest.packs.length} packs into ${lib}`);
NODE