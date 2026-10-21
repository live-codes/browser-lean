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
// layer, Std/Lean gunzipped from the per-file tree, and Mathlib's whole closure unpacked from its 52 packs.
// Bake against *this* tree, not the artifact's own `variant-2/olean`: the two olean sets are identical except
// for the 40-byte githash, and that difference changes the saved environment 3.2× and is what lets the
// serializer finish at all (FINDINGS §9.15).
//
// Expect a long import: Mathlib's closure is an order of magnitude past Std's 483 modules, which took 104 s.
// `--stack-size=4000` is for the save's JS recursion, not the wasm stack.
import { spawn } from 'node:child_process';

const probe = ['import Mathlib.Data.Real.Basic', 'import Mathlib.Tactic.Ring', '#check 1'].join('\n');
const args = [
	'--stack-size=4000',
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