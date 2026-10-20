#!/usr/bin/env node
// Bake a Mathlib snapshot on the host — no container needed, which matters when the Docker daemon is down.
//
//   node wasm-build/bake-mathlib.mjs            (or detached: Start-Process node bake-mathlib.mjs …)
//
// The probe *is* the demo's header, because a snapshot's cache key is read back out of the loaded environment:
// `import Mathlib.Data.Real.Basic` and `import Mathlib.Tactic.Ring`, in that order. Nothing else about the
// program matters — the snapshot carries the elaborated environment that the import would produce.
//
// The library is `wasm-build/out/bake-lib`, assembled by `build-bake-lib.mjs`: Init unpacked from the core
// layer, Std/Lean gunzipped from the per-file tree, and Mathlib's whole closure unpacked from its 52 packs —
// every one of them built by the artifact's Lean commit, which is the only reason this can import at all.
//
// Expect a long import: Mathlib's closure is an order of magnitude past Std's 483 modules, which took 104 s.
// Whether the *save* succeeds is the open question — a Lean-sized save already overflows the serializer's
// recursion (FINDINGS §9.11), and Mathlib's environment is larger still.
import { spawn } from 'node:child_process';

const probe = ['import Mathlib.Data.Real.Basic', 'import Mathlib.Tactic.Ring', '#check 1'].join('\n');
const args = [
	'wasm-build/bake-snapshot.cjs',
	'wasm-build/out/variant-2',
	'wasm-build/out/bakeout',
	'mathlib',
	probe
];

console.log('baking mathlib.snap with probe:');
console.log(probe.split('\n').map((line) => `  ${line}`).join('\n'));

const child = spawn(process.execPath, args, {
	stdio: 'inherit',
	env: { ...process.env, BAKE_LIB_ROOT: 'wasm-build/out/bake-lib' }
});
child.on('exit', (code) => process.exit(code ?? 1));