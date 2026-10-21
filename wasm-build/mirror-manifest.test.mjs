// Tests for the mirror unit descriptor: it must verify a good mirror, flag tampering, and treat an
// artifact/assets commit difference as a note rather than a failure.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyMirror, writeMirrorManifest } from './mirror-manifest.mjs';

const ARTIFACT = 'd'.repeat(40);
const CORE = 'c'.repeat(40);
const MATHLIB = 'e'.repeat(40);

function makeMirror() {
	const dir = mkdtempSync(join(tmpdir(), 'lean-mirror-'));
	const write = (relative, contents) => {
		const path = join(dir, relative);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, contents);
	};

	write('lean-wasm/lean.js', 'glue');
	write('lean-wasm/lean.js.gz', gzipSync('glue'));
	write('lean-wasm/lean.wasm', 'wasm');
	write('lean-wasm/LEAN_COMMIT', `${ARTIFACT}\n`);
	write(
		'lean-wasm/core-layer.json',
		JSON.stringify({ leanCommit: CORE, version: 'core-v', modules: 1, packs: [{ file: 'artifacts-000.pack' }] })
	);
	write('lean-wasm/core-lib/artifacts-000.pack', 'core-pack');
	write(
		'lean-mathlib/real-analysis-layer.json',
		JSON.stringify({ leanCommit: MATHLIB, version: 'math-v', modules: 1, packs: [{ file: 'artifacts-000.pack' }] })
	);
	write('lean-mathlib/artifacts-000.pack', 'mathlib-pack');
	write('lean-lib/lean-lib-files.json.gz', gzipSync('[]'));
	write('lean-wasm/snapshots/init.snap.gz', 'snapshot');

	writeMirrorManifest(dir);
	return dir;
}

test('a good mirror verifies, and the commit difference is a note', () => {
	const dir = makeMirror();
	try {
		const result = verifyMirror(dir);
		assert.deepEqual(result.problems, []);
		assert.equal(result.files, 9);
		assert.ok(result.notes.some((note) => note.includes('differ')));
		assert.match(result.unit.id, /^lean-c{12}-d{12}-[0-9a-f]{8}$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a tampered byte is a failure', () => {
	const dir = makeMirror();
	try {
		writeFileSync(join(dir, 'lean-wasm/snapshots/init.snap.gz'), 'snapshot!');
		const result = verifyMirror(dir);
		assert.ok(result.problems.some((problem) => problem.includes('init.snap.gz')));
		assert.ok(result.problems.some((problem) => problem.includes('sha256') || problem.includes('bytes')));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a swapped build identity is a failure', () => {
	const dir = makeMirror();
	try {
		writeFileSync(join(dir, 'lean-wasm/LEAN_COMMIT'), `${'f'.repeat(40)}\n`);
		const result = verifyMirror(dir);
		assert.ok(result.problems.some((problem) => problem.includes('LEAN_COMMIT')));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('a missing manifest is reported, not thrown', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lean-mirror-empty-'));
	try {
		const result = verifyMirror(dir);
		assert.equal(result.unit, null);
		assert.ok(result.problems[0].includes('mirror.json'));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
