#!/usr/bin/env node
'use strict';
// Install a baked snapshot the way the browser does — its own memory, MEMFS, no Node file mounts — and say
// which step fails. Run under Node 24 in the build container:
//
//   docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v "$PWD/wasm-build:/w" \
//     lean4-wasm-single-threaded -c '/cache/node24/bin/node /w/verify-snapshot.cjs \
//       /cache/src/build/wasm-2/stage1/bin /bakeout/init.snap'
//
// Node 24 specifically: this artifact exports 104,692 functions and Node 22 refuses to instantiate anything
// above 100,000.
//
// Why this exists: in the browser the whole install is one try/except, so a failure reports as one message
// and cannot distinguish "MEMFS could not hold 230 MB" from "the loader trapped". Here each step reports
// separately, and the heap size is printed before and after so a growth failure is visible as such.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const artifactDir = path.resolve(process.argv[2] || '.');
if (!process.argv[3]) {
	console.error('usage: verify-snapshot.cjs <artifact-dir> <snapshot>');
	process.exit(2);
}
const snapshotPath = path.resolve(process.argv[3]);
const bytes = new Uint8Array(fs.readFileSync(snapshotPath));
console.log(`snapshot: ${snapshotPath}`);
console.log(`          ${(bytes.length / 1048576).toFixed(1)} MB, first 8 bytes ${Array.from(bytes.slice(0, 8)).join(',')}`);

const SNAPSHOT_IN_FS = '/workspace/init.snap';
const mb = (n) => `${(n / 1048576).toFixed(0)} MB`;
// The loader's own tracing. It prints `cached env for […]` on success and `failed: …` with the reason when it
// declines — a better answer than decoding the returned IO result, and one that cannot be got wrong.
const trace = [];

globalThis.Module = {
	noInitialRun: true,
	arguments: [],
	locateFile: (file) => path.join(artifactDir, file),
	print: () => {},
	printErr: (line) => {
		// Unfiltered on purpose. The loader traces its own entry and its own caught failure, and which of those
		// appears — or neither — is what separates a trap inside the deserializer from a refusal that returns
		// 1. Filtering on "error" is exactly what hid the difference the first time.
		if (typeof line === 'string' && line.includes('wasmLoadSnapshot')) trace.push(line);
		console.log(`  wasm: ${line.slice(0, 400)}`);
	},
	preRun: [
		() => {
			Module.FS.mkdirTree('/workspace');
		},
	],
	onRuntimeInitialized: () => {
		run();
	},
};

// A trap inside a wasm export surfaces as a JS exception, but an abort can also leave the runtime dead
// without ever firing ready, so the watchdog is the difference between a hang and a report.
const watchdog = setTimeout(() => {
	console.log('TIMEOUT: the module never became ready');
	process.exit(1);
}, 180000);

function step(label, fn) {
	try {
		const detail = fn();
		console.log(`  ${label}: ok${detail === undefined ? '' : ` — ${detail}`}`);
		return { ok: true, value: detail };
	} catch (error) {
		console.log(`  ${label}: FAILED — ${(error && error.message) || error}`);
		if (error && error.stack) console.log(`    ${error.stack.split('\n')[1]?.trim() || ''}`);
		return { ok: false, error };
	}
}

function run() {
	clearTimeout(watchdog);
	console.log('module instantiated');
	step('heap on start', () => mb(Module.HEAPU8.length));

	step('lean_init_task_manager', () => {
		// Before the snapshot, not after. The loader replays the `[init]` attributes the imported modules would
		// have run, and an initializer that builds a promise needs a *running* task manager: without one it
		// panics — "IO.Promise.new called before the task manager is running" — and that surfaces as a wasm
		// exception, which reads from a distance like a bad or mismatched snapshot file.
		if (typeof Module._lean_init_task_manager !== 'function') return 'not exported on Module';
		Module._lean_init_task_manager();
		return 'called';
	});

	step('FS.writeFile (snapshot)', () => {
		Module.FS.writeFile(SNAPSHOT_IN_FS, bytes);
		return `${mb(bytes.length)} into MEMFS`;
	});
	step('FS.writeFile (deps sidecar)', () => {
		Module.FS.writeFile(`${SNAPSHOT_IN_FS}.deps`, new Uint8Array([0x5b, 0x5d]));
		return '[]';
	});
	step('heap before load', () => mb(Module.HEAPU8.length));

	const loaded = step('lean_wasm_load_snapshot', () => {
		if (typeof Module._lean_wasm_load_snapshot !== 'function') throw new Error('not exported on Module');
		// A `lean_object*`, not a JavaScript string: the export takes a Lean `String`, and a JS string coerces
		// to 0 as an i32, so the loader dereferences a bogus pointer and traps before its first line — which
		// reads exactly like running out of memory. `_lean_wasm_compile` is called this same way.
		const ptr = Module.stringToNewUTF8(SNAPSHOT_IN_FS);
		const obj = Module._lean_mk_string(ptr);
		Module._free(ptr);
		return `returned pointer ${Module._lean_wasm_load_snapshot(obj)}`;
	});
	step('heap after load', () => mb(Module.HEAPU8.length));

	// No trace is not proof of failure, and this script cannot give a verdict on a snapshot. It checks the
	// *shape* of the call: under Node the runtime has not been through the initialization the browser's worker
	// performs, so the loader can raise before it prints anything. The browser measurement is the verdict —
	// with the cache seeded the first run is ~0.3 s, without it ~75 s.
	const verdict = trace.find((line) => line.includes('cached env for'))
		? 'loaded — the loader cached the environment'
		: `inconclusive here — ${trace.find((line) => line.includes('failed')) || 'no trace; the loader needs a fully initialized runtime, which this script does not provide'}`;
	console.log(`RESULT: ${verdict}`);
	process.exit(0);
}

// Script-scope shims for the CJS facilities the glue expects. `vm.runInThisContext` runs the glue outside
// any module wrapper, so `require`, `__filename` and `__dirname` are not in scope for it — and it reaches for
// all three on its first line under Node.
globalThis.require = require;
globalThis.__filename = path.join(artifactDir, 'lean.js');
globalThis.__dirname = artifactDir;
process.argv[1] = '/bin/lean';

vm.runInThisContext(fs.readFileSync(path.join(artifactDir, 'lean.js'), 'utf8'), { filename: 'lean.js' });
