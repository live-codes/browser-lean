#!/usr/bin/env node
// Start the demo the way the canonical single-threaded mirror is meant to be used:
//
//   node scripts/serve-canonical.mjs [mirror-dir]
//
// Page on :8129 without isolation headers (the unshared artifact needs none), mirror on :8131, and the URL
// printed is the one to open. The default mirror is `wasm-build/out/mirror-upstream`.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mirror = resolve(process.argv[2] ?? join(root, 'wasm-build/out/mirror-upstream'));

if (!existsSync(join(mirror, 'lean-wasm', 'lean.js'))) {
	console.error(`no Lean mirror at ${mirror}`);
	console.error('Expected lean-wasm/lean.js. Build it with the steps in HANDOVER.md §2, or pass a mirror directory.');
	process.exit(1);
}

const children = [];
function start(args) {
	const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
	children.push(child);
	return child;
}

let stopping = false;
function stop(code = 0) {
	if (stopping) return;
	stopping = true;
	for (const child of children) {
		try {
			child.kill();
		} catch {
			/* ignore */
		}
	}
	process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

start(['serve.js', '8129', 'public', '--no-isolation']);
start(['serve.js', '8131', mirror]);

for (const child of children) {
	child.on('exit', (code) => {
		if (!stopping && code) stop(code);
	});
}

console.log(`\n  Lean demo:  http://localhost:8129/?baseUrl=http://localhost:8131`);
console.log(`  mirror:     ${mirror}`);
console.log('  Ctrl+C stops both servers.\n');
