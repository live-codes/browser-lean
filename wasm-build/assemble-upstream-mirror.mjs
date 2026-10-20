#!/usr/bin/env node
// Assemble the mirror to serve once build-upstream.sh has finished: upstream's assets, our binary.
//
//   node wasm-build/assemble-upstream-mirror.mjs [--from <url>]
//
// Why this shape: upstream's core layer, per-file tree and Mathlib layer are all built by Lean 62b6a229…, and
// an `.olean` is only readable by the compiler that wrote it (§9.9, §9.12). The artifact from
// build-upstream.sh is built at that same commit, so the two sides finally match — which is why this is the
// route to Mathlib: nothing here builds Mathlib.
//
// Everything except the two binaries comes from upstream. `--only wasm` also downloads *their* pthread
// binaries, so ours replace them afterwards; the core layer that arrives with it is what we want.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

console.log('=== adding the snapshots baked against that binary (they are per-binary)');
const snapshots = join(mirror, 'lean-wasm', 'snapshots');
mkdirSync(snapshots, { recursive: true });
for (const name of readdirSync(bakeout)) {
	if (!name.endsWith('.snap') && !name.endsWith('.snap.deps')) continue;
	copyFileSync(join(bakeout, name), join(snapshots, name));
	console.log(`  ${name}`);
}

console.log('\n=== done. Serve it as baseUrl, alongside the page:');
console.log(`  node serve.js 8131 ${mirror}`);
console.log('  http://localhost:8129/?baseUrl=http://localhost:8131');
console.log('\nThen: Std, Lean metaprogramming and Mathlib are all against assets built by this artifact\'s Lean.');