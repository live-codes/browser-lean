#!/usr/bin/env node
// Assemble a library tree the CLI *bake* can import from, out of the mirror's three compressed sources.
//
//   node wasm-build/build-bake-lib.mjs [mirror-dir] [out-dir]
//
// A bake runs the real CLI, which resolves modules from `LEAN_PATH` and imports them — so it needs the
// oleans as files on disk, not as packs. The runtime does the slicing itself at load time (`loadPackedLayer`
// → MEMFS); this is the same work, done ahead of time for a directory the container can mount:
//
//   Init     — unpacked from the core layer (it is published only as packs)
//   Std/Lean — gunzipped from the per-file tree (it is stored `.gz`)
//   Mathlib  — unpacked from its layer (published only as packs)
//
// Everything here is built by the same Lean commit as the artifact, which is the whole point: a bake imports
// with that compiler, and an `.olean` is only readable by the writer.
import { gunzipSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const mirror = process.argv[2] ?? 'wasm-build/out/mirror-upstream';
const out = process.argv[3] ?? 'wasm-build/out/bake-lib';

let written = 0;
function put(relativePath, bytes) {
	const target = join(out, relativePath);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
	written += 1;
}

/** Slice a gzip'd pack container into its entries, using the manifest's offsets. */
function unpackLayer(manifestDir, packDir, manifestName, label) {
	const manifestPath = join(manifestDir, manifestName);
	if (!existsSync(manifestPath)) {
		console.log(`${label}: no ${manifestName}, skipping`);
		return;
	}
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	let files = 0;
	for (const pack of manifest.packs) {
		const file = join(packDir, pack.file);
		if (!existsSync(file)) throw new Error(`${label}: missing ${pack.file}`);
		const raw = gunzipSync(readFileSync(file));
		if (raw.length !== pack.bytes) {
			throw new Error(`${label}: ${pack.file} is ${raw.length} bytes, manifest says ${pack.bytes}`);
		}
		for (const entry of pack.entries) {
			put(entry.path, raw.subarray(entry.offset, entry.offset + entry.bytes));
			files += 1;
		}
	}
	console.log(`${label}: ${files} files from ${manifest.packs.length} packs`);
}

/** Walk a tree, gunzipping every `.gz` and writing it under the name without that suffix. */
function unpackTree(root, label) {
	let files = 0;
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			if (!name.endsWith('.gz')) continue;
			put(relative(root, full).replace(/\.gz$/, ''), gunzipSync(readFileSync(full)));
			files += 1;
		}
	};
	if (!existsSync(root)) {
		console.log(`${label}: no ${root}, skipping`);
		return;
	}
	walk(root);
	console.log(`${label}: ${files} files`);
}

// The core layer keeps its packs in `core-lib/`; Mathlib's sit beside its manifest.
unpackLayer(join(mirror, 'lean-wasm'), join(mirror, 'lean-wasm', 'core-lib'), 'core-layer.json', 'Init (core layer)');
unpackTree(join(mirror, 'lean-lib'), 'Std/Lean (per-file tree)');
unpackLayer(join(mirror, 'lean-mathlib'), join(mirror, 'lean-mathlib'), 'real-analysis-layer.json', 'Mathlib (layer)');

console.log(`\nwrote ${written} files to ${out}`);
console.log('Mount it as BAKE_LIB_ROOT when baking, e.g.');
console.log(`  -v "${out}:/bake-lib" -e BAKE_LIB_ROOT=/bake-lib`);