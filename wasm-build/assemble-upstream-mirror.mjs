#!/usr/bin/env node
// Assemble the mirror to serve once build-upstream.sh has finished: upstream's assets, our binary.
//
//   node wasm-build/assemble-upstream-mirror.mjs [--from <url>]
//
// Why this shape: upstream's core layer, per-file tree and Mathlib layer were built by Lean 62b6a229…, and
// an `.olean` is only readable by a compiler of the same version/format. The canonical artifact reports
// `dfe4953` — the fork's default — and the two library trees differ only in the 40-byte `.olean` githash, so
// this pairing works (measured end to end, FINDINGS §9.15). `lean-wasm/LEAN_COMMIT` plus `mirror.json` make
// both identities explicit, and the runtime reports a mismatch at load rather than letting it hide.
//
// Everything except the two binaries comes from upstream. `--only wasm` also downloads *their* pthread
// binaries, so ours replace them afterwards; the core layer that arrives with it is what we want.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { writeMirrorManifest } from './mirror-manifest.mjs';

const mirror = 'wasm-build/out/mirror-upstream';
const artifact = 'wasm-build/out/variant-2';
const bakeout = 'wasm-build/out/bakeout';
const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : null;

if (!existsSync(join(artifact, 'lean.wasm'))) {
	console.error(`no artifact at ${artifact} — run build-upstream.sh first (it builds 62b6a229)`);
	process.exit(1);
}

console.log('=== fetching upstream assets: core layer, per-file tree, Mathlib layer');
mkdirSync(mirror, { recursive: true });
const args = ['packages/lean-wasm/bin/fetch-assets.mjs', mirror, '--only', 'wasm,lib,mathlib'];
if (from) args.push('--from', from);
try {
	execFileSync(process.execPath, args, { stdio: 'inherit' });
} catch {
	// A refusal here is not fatal: the pack and lib paths were both verified individually, and a throttled
	// host refuses files it will serve on a retry. Say so and continue to the part that matters.
	console.warn('! fetch reported problems — see above; the artifact and snapshots below are unaffected');
}

console.log('=== replacing the binaries with the single-threaded build');
for (const name of ['lean.js', 'lean.wasm']) {
	copyFileSync(join(artifact, name), join(mirror, 'lean-wasm', name));
	console.log(`  ${name}`);
}
// `lean.js` is 45.8 MB of mostly repetitive export table and gzips 20×. The runtime probes `.js.gz`
// first; the plain copy stays so `fetch-assets` can still recognise the mirror and old readers still work.
{
	const script = readFileSync(join(artifact, 'lean.js'));
	const gz = gzipSync(script, { level: 9 });
	writeFileSync(join(mirror, 'lean-wasm', 'lean.js.gz'), gz);
	console.log(`  lean.js.gz  ${(gz.length / 1048576).toFixed(1)} MB (from ${(script.length / 1048576).toFixed(1)} MB)`);
}
// The wasm is the last uncompressed transfer. `loadWasmUrl()` already probes `lean.wasm.gz` first and
// decompresses it with `DecompressionStream`; the plain copy stays beside it for tools and older readers.
{
	const wasm = readFileSync(join(artifact, 'lean.wasm'));
	const gz = gzipSync(wasm, { level: 9 });
	writeFileSync(join(mirror, 'lean-wasm', 'lean.wasm.gz'), gz);
	console.log(`  lean.wasm.gz  ${(gz.length / 1048576).toFixed(1)} MB (from ${(wasm.length / 1048576).toFixed(1)} MB)`);
}
// The artifact's own build identity, so the runtime can compare it with the layers it fetches. Without
// it a mirror can pair two different builds silently — which is exactly what happened here once.
const commitFile = join(artifact, 'LEAN_COMMIT');
if (existsSync(commitFile)) {
	copyFileSync(commitFile, join(mirror, 'lean-wasm', 'LEAN_COMMIT'));
	console.log('  LEAN_COMMIT');
}

console.log('=== adding the snapshots baked against that binary (they are per-binary)');
const snapshots = join(mirror, 'lean-wasm', 'snapshots');
mkdirSync(snapshots, { recursive: true });
for (const name of readdirSync(bakeout)) {
	if (name.endsWith('.snap')) {
		// Gzipped, because a snapshot is the largest asset in the mirror and compresses ~2.4×: 946 MB raw for
		// the four, 390 MB gzipped. The runtime probes `.snap.gz` first and falls back to plain.
		const bytes = readFileSync(join(bakeout, name));
		const gz = gzipSync(bytes, { level: 6 });
		writeFileSync(join(snapshots, `${name}.gz`), gz);
		console.log(`  ${name}.gz  ${(gz.length / 1048576).toFixed(1)} MB (from ${(bytes.length / 1048576).toFixed(1)} MB)`);
	} else if (name.endsWith('.snap.deps')) {
		copyFileSync(join(bakeout, name), join(snapshots, name));
	}
}

// ---- The unit's manifest -------------------------------------------------------------------------
//
// Artifact, core layer, per-file tree, Mathlib layer and snapshots are one deployable unit. `mirror.json`
// records what was actually written — commits, versions and a sha256 of every large file — so a host can
// verify an upload and a consumer can see exactly what it serves. The writer and the verifier share
// `mirror-manifest.mjs` so the schema cannot drift between them.
console.log('\n=== mirror.json');
const unit = writeMirrorManifest(mirror);
console.log(`  ${unit.id}`);
console.log(
	`  artifact ${unit.artifact.leanCommit?.slice(0, 12) ?? 'unknown'} · ` +
		`core ${unit.core.leanCommit?.slice(0, 12) ?? 'unknown'} · ` +
		`Mathlib ${unit.mathlib.leanCommit?.slice(0, 12) ?? 'unknown'} · ` +
		`${unit.snapshots.length} snapshots`
);

console.log('\n=== done. Serve it as baseUrl, alongside the page:');
console.log(`  node serve.js 8131 ${mirror}`);
console.log('  http://localhost:8129/?baseUrl=http://localhost:8131');
console.log('\nVerify it at any time with: node wasm-build/verify-mirror.mjs ' + mirror);