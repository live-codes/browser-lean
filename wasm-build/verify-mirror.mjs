#!/usr/bin/env node
// Verify a deployed mirror against its own `mirror.json`.
//
//   node wasm-build/verify-mirror.mjs [directory] [--write]
//
//   directory   default: wasm-build/out/mirror-upstream
//   --write     regenerate mirror.json from what is on disk, then verify it
//
// Every recorded file is checked for size and sha256, and the commits recorded in the unit are compared with
// the files that carry them (`LEAN_COMMIT`, the core layer and Mathlib manifests). A mismatch between the
// *artifact* commit and the *asset* commit is a note, not a failure: the canonical mirror pairs `dfe4953`
// with `62b6a229` deliberately. Anything else is an error.
import { resolve } from 'node:path';

import { verifyMirror, writeMirrorManifest } from './mirror-manifest.mjs';

const args = process.argv.slice(2);
const dir = resolve(args.find((arg) => !arg.startsWith('-')) ?? 'wasm-build/out/mirror-upstream');

if (args.includes('--write')) {
	try {
		const unit = writeMirrorManifest(dir);
		console.log(`wrote ${dir}/mirror.json — ${unit.id}`);
	} catch (error) {
		console.error(`could not write mirror.json: ${error.message}`);
		process.exit(1);
	}
}

const { unit, files, bytes, problems, notes } = verifyMirror(dir);
if (!unit) {
	console.error(problems[0] ?? 'not a Lean mirror');
	process.exit(1);
}

console.log(`mirror ${unit.id} — generated ${unit.generatedAt}`);
console.log(`verified ${files} file(s), ${(bytes / 1048576).toFixed(1)} MiB`);
for (const note of notes) console.log(`note: ${note}`);

if (problems.length > 0) {
	console.error(`\n${problems.length} problem(s):`);
	for (const problem of problems) console.error(`  - ${problem}`);
	console.error('\nThat mirror is not the unit its manifest describes.');
	process.exit(1);
}

console.log('OK');
