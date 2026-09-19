// The parts that can be tested without a browser: asset resolution, root parsing, message
// classification and the probe's source generation. The runtime itself is verified by
// `test/page.html`, which needs a cross-origin isolated page.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { requiredAssetPaths, resolveAssets } from '../src/assets.js';
import { collect, problemsToLines } from '../src/messages.js';
import { importedRoots, missingRoots, outsideClosureNotes, unavailableImportNotes } from '../src/roots.js';
import { leanStringLiteral, syntaxProbeSource } from '../src/syntax-probe.js';
import { RUNTIME_WORKER_SOURCE } from '../src/runtime-worker.js';

test('resolveAssets derives the three directories from one base', () => {
	const assets = resolveAssets('https://cdn.example.com/lean/');
	assert.equal(assets.baseUrl, 'https://cdn.example.com/lean/');
	assert.equal(assets.assetBase, 'https://cdn.example.com/lean/lean-wasm');
	assert.equal(assets.libBase, 'https://cdn.example.com/lean/lean-lib');
	assert.equal(assets.layerBase, 'https://cdn.example.com/lean/lean-mathlib');
});

test('resolveAssets accepts a base without a trailing slash, and is idempotent', () => {
	const once = resolveAssets('https://cdn.example.com/lean');
	assert.equal(once.assetBase, 'https://cdn.example.com/lean/lean-wasm');
	assert.equal(resolveAssets(once.baseUrl).assetBase, once.assetBase);
});

test('resolveAssets refuses to guess when baseUrl is missing', () => {
	assert.throws(() => resolveAssets(), /baseUrl is required/);
	assert.throws(() => resolveAssets(''), /baseUrl is required/);
});

test('resolveAssets rejects a non-http base', () => {
	assert.throws(() => resolveAssets('ftp://example.com/lean'), /must be http or https/);
});

test('requiredAssetPaths names all three directories', () => {
	const paths = requiredAssetPaths().join('\n');
	assert.match(paths, /lean-wasm\/lean\.wasm/);
	assert.match(paths, /lean-lib\/lean-lib-files\.json/);
	assert.match(paths, /lean-mathlib\/real-analysis-layer\.json/);
});

test('importedRoots lists distinct roots and ignores comments', () => {
	const code = [
		'import Std.Data.HashMap',
		'import Std.Data.HashSet',
		'import Mathlib.Data.Real.Basic',
		'-- import Batteries',
		'/- import Aesop -/',
		'#eval 1 + 1'
	].join('\n');
	assert.deepEqual(importedRoots(code), ['Std', 'Mathlib']);
});

test('missingRoots reads the compiler’s unknown-prefix diagnostics', () => {
	const problems = [
		{ severity: 'error', text: "uncaught exception: unknown module prefix 'Mathlib'" },
		{ severity: 'error', text: "No directory 'Mathlib' or file 'Mathlib.olean'" }
	];
	assert.deepEqual(missingRoots(problems), ['Mathlib']);
});

test('collect splits by severity, not by stream', () => {
	// With `--json` every message is JSON on stdout, errors included.
	const json = (severity, data) => JSON.stringify({ severity, data, pos: { line: 1, column: 0 } });
	const { info, problems, noise } = collect(
		`${json('information', '2')}\n${json('error', 'Unknown identifier `x`')}\n`,
		'[DEBUG:I] fileName = /workspace/input.lean\n'
	);
	assert.deepEqual(info.map((entry) => entry.text), ['2']);
	assert.deepEqual(problems.map((entry) => entry.text), ['Unknown identifier `x`']);
	assert.equal(noise, 1);
});

test('collect falls back to the stream for plain text', () => {
	const { info, problems } = collect('#eval printed this\n', 'some diagnostic\n');
	assert.deepEqual(info.map((entry) => entry.text), ['#eval printed this']);
	assert.deepEqual(problems.map((entry) => entry.text), ['some diagnostic']);
});

test('problemsToLines does not append a position a message already carries', () => {
	const own = problemsToLines([
		{ severity: 'error', text: 'syntax error at line 2, column 0', pos: { line: 9, column: 4 } }
	]);
	assert.deepEqual(own, ['error: syntax error at line 2, column 0']);

	const appended = problemsToLines([{ severity: 'error', text: 'Unknown identifier `x`', pos: { line: 3, column: 7 } }]);
	assert.deepEqual(appended, ['error: Unknown identifier `x`  (line 3, col 7)']);
});

test('outsideClosureNotes explains a module outside the published Mathlib closure', () => {
	const notes = outsideClosureNotes([
		{
			severity: 'error',
			text: "uncaught exception: object file '/lib/lean/Mathlib/Analysis/SpecialFunctions/Sqrt.olean' of module Mathlib.Analysis.SpecialFunctions.Sqrt does not exist"
		}
	]);
	assert.equal(notes.length, 1);
	assert.match(notes[0], /4,303 modules/);
});

test('unavailableImportNotes points at the fetch command', () => {
	const assets = resolveAssets('https://cdn.example.com/lean/');
	const notes = unavailableImportNotes('import Mathlib.Data.Real.Basic', ['Mathlib'], assets);
	assert.equal(notes.length, 1);
	assert.match(notes[0], /lean-wasm-fetch-assets/);

	const laked = unavailableImportNotes('import Lake', [], assets);
	assert.match(laked[0], /build tool/);
});

test('leanStringLiteral escapes what Lean’s own syntax needs', () => {
	assert.equal(leanStringLiteral('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
	assert.equal(leanStringLiteral('line\nnext'), '"line\\nnext"');
	// A template literal would be broken by backticks; a string literal is not.
	assert.equal(leanStringLiteral('`x`'), '"`x`"');
});

test('syntaxProbeSource carries the program’s imports and embeds its source', () => {
	const code = 'import Std.Data.HashMap\n\ndef x : Nat :=\n';
	const probe = syntaxProbeSource(code);
	assert.match(probe, /^import Std\.Data\.HashMap\nimport Lean\n/);
	assert.match(probe, /Parser\.parseCommand/);
	assert.ok(probe.includes(leanStringLiteral(code)));
	// No imports in the program means the probe still imports Lean, since the parser lives there.
	assert.match(syntaxProbeSource('#eval 1'), /^import Lean\n/);
});

test('the generated runtime worker is present and is the Lean host', () => {
	assert.ok(RUNTIME_WORKER_SOURCE.length > 5000, 'expected the whole worker source');
	assert.match(RUNTIME_WORKER_SOURCE, /lean_wasm_compile/);
	assert.match(RUNTIME_WORKER_SOURCE, /__LEAN_WASM_CONFIG__/);
	// It must survive being embedded in a blob, so it cannot rely on a query string alone.
	assert.match(RUNTIME_WORKER_SOURCE, /load_modules/);
	assert.match(RUNTIME_WORKER_SOURCE, /load_layer/);
});
