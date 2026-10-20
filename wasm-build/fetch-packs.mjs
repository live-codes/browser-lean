#!/usr/bin/env node
// Fetch the packed layers (core + Mathlib) verbatim, from the manifests already in the mirror.
//
//   node wasm-build/fetch-packs.mjs <mirror-dir> [--from <url>]
//
// Why this exists instead of letting `lean-wasm-fetch-assets` do it: that tool refuses every `.pack` with
// "not a gzip pack" even though the download is gzip — its `.pack` check looks for the gzip magic in a body
// that some earlier step has already decompressed, so the check sees pack contents and rejects a perfectly
// valid pack. The runtime, meanwhile, expects exactly the gzip container that is served and gunzips it itself
// (`loadPackedLayer`: gunzip, then entries addressed by offset/length, then compare against `pack.bytes`).
//
// Verified against one pack by hand before writing this: 6,109,959 bytes on the wire, magic 1f 8b, and
// 16,761,836 bytes after gunzip — exactly what the manifest declares.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const mirror = process.argv[2];
if (!mirror) {
	console.error('usage: fetch-packs.mjs <mirror-dir> [--from <url>]');
	process.exit(2);
}
const fromIndex = process.argv.indexOf('--from');
const from = fromIndex === -1 ? 'https://lean.cau.li/lean-wasm' : process.argv[fromIndex + 1];

// [manifest in the mirror, where its packs live under `from`, where they go in the mirror]
const LAYERS = [
	['lean-wasm/core-layer.json', 'core-lib', 'lean-wasm/core-lib'],
	['lean-mathlib/real-analysis-layer.json', 'real-analysis-lib', 'lean-mathlib']
];

const CONCURRENCY = 6;

async function fetchOne(url, path, expected) {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = Buffer.from(await response.arrayBuffer());
			if (!(body[0] === 0x1f && body[1] === 0x8b)) throw new Error('not gzip');
			writeFileSync(path, body);
			return { bytes: body.length, expected };
		} catch (error) {
			if (attempt === 2) return { error: error.message };
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
		}
	}
}

let total = 0;
let failed = 0;
for (const [manifestPath, sourceDir, destDir] of LAYERS) {
	const full = join(mirror, manifestPath);
	if (!existsSync(full)) {
		console.log(`${manifestPath}: not in the mirror, skipping`);
		continue;
	}
	const manifest = JSON.parse(readFileSync(full, 'utf8'));
	const packs = manifest.packs ?? [];
	let done = 0;
	let next = 0;
	async function worker() {
		for (;;) {
			const i = next++;
			if (i >= packs.length) return;
			const pack = packs[i];
			const result = await fetchOne(`${from}/${sourceDir}/${pack.file}`, join(mirror, destDir, pack.file), pack.bytes);
			if (result.error) {
				failed += 1;
				console.log(`  ! ${pack.file}: ${result.error}`);
			} else {
				total += result.bytes;
			}
			done += 1;
			if (done % 10 === 0) console.log(`  ${destDir}: ${done}/${packs.length}`);
		}
	}
	console.log(`${destDir}: ${packs.length} packs from ${from}/${sourceDir}`);
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}

console.log(`fetched ${(total / 1048576).toFixed(1)} MiB, ${failed} failed`);
process.exit(failed ? 1 : 0);
