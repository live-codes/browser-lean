// `mirror.json`: one descriptor for the artifact, the three asset trees and the snapshots.
//
// The unit matters because an `.olean` or a snapshot from another Lean build is at best ignored and at worst
// misread, and the binaries, core layer, per-file tree, Mathlib layer and snapshots are produced by different
// scripts. This module writes the manifest during assembly and verifies a deployed copy; keeping both in one
// file is what stops the writer and the checker from disagreeing about the schema.
//
// The artifact commit and the asset commits are allowed to differ — the canonical mirror pairs `dfe4953`
// with `62b6a229` deliberately — so that is a *note* in the verifier, not a failure. A hash or size mismatch
// is a failure.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CORE_MANIFEST = 'lean-wasm/core-layer.json';
const MATHLIB_MANIFEST = 'lean-mathlib/real-analysis-layer.json';

export function commitOf(manifest) {
	const direct = typeof manifest?.leanCommit === 'string' ? manifest.leanCommit.toLowerCase() : '';
	if (/^[0-9a-f]{40}$/.test(direct)) return direct;
	const version = typeof manifest?.version === 'string' ? manifest.version : '';
	return version.match(/[0-9a-f]{10,40}/i)?.[0]?.toLowerCase() ?? null;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function fileInfo(mirror, relative) {
	const path = join(mirror, relative);
	if (!existsSync(path)) return null;
	const bytes = readFileSync(path);
	return {
		path: relative,
		bytes: bytes.length,
		sha256: createHash('sha256').update(bytes).digest('hex')
	};
}

function short(commit) {
	return commit ? commit.slice(0, 12) : 'unknown';
}

/** Write `mirror.json` from what is on disk, and return the descriptor. */
export function writeMirrorManifest(mirror) {
	const snapshots = join(mirror, 'lean-wasm', 'snapshots');
	const coreManifest = readJson(join(mirror, CORE_MANIFEST));
	const mathlibManifest = readJson(join(mirror, MATHLIB_MANIFEST));
	const artifactCommit = existsSync(join(mirror, 'lean-wasm', 'LEAN_COMMIT'))
		? readFileSync(join(mirror, 'lean-wasm', 'LEAN_COMMIT'), 'utf8').trim().toLowerCase()
		: null;
	const libIndex = ['lean-lib/lean-lib-files.json.gz', 'lean-lib/lean-lib-files.json'].find((path) =>
		existsSync(join(mirror, path))
	);

	const snapshotInfo = readdirSync(snapshots)
		.filter((name) => name.endsWith('.snap.gz'))
		.sort()
		.map((name) => fileInfo(mirror, `lean-wasm/snapshots/${name}`));
	const packInfo = (manifest, base) =>
		(manifest.packs ?? []).map((pack) => fileInfo(mirror, `${base}/${pack.file}`)).filter(Boolean);

	const unit = {
		format: 'lean-mirror',
		schema: 1,
		artifact: {
			leanCommit: artifactCommit,
			files: ['lean-wasm/lean.js', 'lean-wasm/lean.js.gz', 'lean-wasm/lean.wasm', 'lean-wasm/lean.wasm.gz']
				.map((path) => fileInfo(mirror, path))
				.filter(Boolean)
		},
		core: {
			leanCommit: commitOf(coreManifest),
			version: coreManifest.version ?? null,
			modules: coreManifest.modules ?? null,
			packCount: Array.isArray(coreManifest.packs) ? coreManifest.packs.length : null,
			manifest: fileInfo(mirror, CORE_MANIFEST),
			packs: packInfo(coreManifest, 'lean-wasm/core-lib')
		},
		mathlib: {
			leanCommit: commitOf(mathlibManifest),
			version: mathlibManifest.version ?? null,
			modules: mathlibManifest.modules ?? null,
			packCount: Array.isArray(mathlibManifest.packs) ? mathlibManifest.packs.length : null,
			manifest: fileInfo(mirror, MATHLIB_MANIFEST),
			packs: packInfo(mathlibManifest, 'lean-mathlib')
		},
		lib: { index: libIndex ? fileInfo(mirror, libIndex) : null },
		snapshots: snapshotInfo
	};

	const snapshotsDigest = createHash('sha256')
		.update(snapshotInfo.map((snapshot) => snapshot.sha256).join('\n'))
		.digest('hex')
		.slice(0, 8);
	unit.id = `lean-${short(unit.core.leanCommit)}-${short(unit.artifact.leanCommit)}-${snapshotsDigest}`;
	unit.generatedAt = new Date().toISOString();

	writeFileSync(join(mirror, 'mirror.json'), `${JSON.stringify(unit, null, 2)}\n`);
	return unit;
}

/**
 * Verify a mirror against its own manifest.
 *
 * @param {string} dir
 * @returns {{unit: object|null, files: number, bytes: number, problems: string[], notes: string[]}}
 */
export function verifyMirror(dir) {
	const problems = [];
	const notes = [];
	const manifestPath = join(dir, 'mirror.json');
	if (!existsSync(manifestPath)) {
		return { unit: null, files: 0, bytes: 0, problems: [`no mirror.json at ${dir}`], notes };
	}

	let unit;
	try {
		unit = readJson(manifestPath);
	} catch (error) {
		return { unit: null, files: 0, bytes: 0, problems: [`mirror.json is not readable JSON: ${error.message}`], notes };
	}
	if (unit.format !== 'lean-mirror') problems.push(`format is ${JSON.stringify(unit.format)}, expected "lean-mirror"`);
	if (unit.schema !== 1) problems.push(`schema is ${JSON.stringify(unit.schema)}, expected 1`);

	const checked = new Map();
	function check(entry, label, { required = true } = {}) {
		if (!entry) {
			if (required) problems.push(`${label}: not recorded in mirror.json`);
			return;
		}
		if (checked.has(entry.path)) return;
		const path = join(dir, entry.path);
		if (!existsSync(path)) {
			problems.push(`${entry.path}: missing (${label})`);
			return;
		}
		const bytes = readFileSync(path);
		if (bytes.length !== entry.bytes) {
			problems.push(`${entry.path}: ${bytes.length} bytes, manifest says ${entry.bytes}`);
		}
		const hash = createHash('sha256').update(bytes).digest('hex');
		if (hash !== entry.sha256) {
			problems.push(`${entry.path}: sha256 ${hash.slice(0, 12)}…, manifest says ${entry.sha256.slice(0, 12)}…`);
		}
		checked.set(entry.path, entry.bytes);
	}

	for (const entry of unit.artifact?.files ?? []) check(entry, 'artifact');
	for (const entry of unit.core?.packs ?? []) check(entry, 'core pack');
	check(unit.core?.manifest, 'core layer manifest');
	for (const entry of unit.mathlib?.packs ?? []) check(entry, 'Mathlib pack');
	check(unit.mathlib?.manifest, 'Mathlib manifest');
	check(unit.lib?.index, 'library index', { required: false });
	for (const entry of unit.snapshots ?? []) check(entry, 'snapshot');

	if (!unit.snapshots?.length) notes.push('no snapshots recorded — first runs pay the full imports');

	// The recorded identity must match the files that carry it.
	const commitPath = join(dir, 'lean-wasm', 'LEAN_COMMIT');
	if (unit.artifact?.leanCommit) {
		if (!existsSync(commitPath)) problems.push('lean-wasm/LEAN_COMMIT is missing but mirror.json records an artifact commit');
		else {
			const commit = readFileSync(commitPath, 'utf8').trim().toLowerCase();
			if (commit !== unit.artifact.leanCommit) {
				problems.push(`lean-wasm/LEAN_COMMIT is ${short(commit)}, mirror.json says ${short(unit.artifact.leanCommit)}`);
			}
		}
	}
	for (const [key, relative] of [
		['core', CORE_MANIFEST],
		['mathlib', MATHLIB_MANIFEST]
	]) {
		const path = join(dir, relative);
		if (!existsSync(path)) continue;
		try {
			const manifest = readJson(path);
			const commit = commitOf(manifest);
			if (unit[key]?.leanCommit && commit !== unit[key].leanCommit) {
				problems.push(`${relative}: leanCommit is ${short(commit)}, mirror.json says ${short(unit[key].leanCommit)}`);
			}
			if (unit[key]?.version && manifest.version && manifest.version !== unit[key].version) {
				problems.push(`${relative}: version is ${manifest.version}, mirror.json says ${unit[key].version}`);
			}
		} catch (error) {
			problems.push(`${relative}: ${error.message}`);
		}
	}

	if (unit.artifact?.leanCommit && unit.core?.leanCommit && unit.artifact.leanCommit !== unit.core.leanCommit) {
		notes.push(
			`artifact ${short(unit.artifact.leanCommit)} and assets ${short(unit.core.leanCommit)} differ — ` +
				'the runtime reports this at load; the bytes above are verified'
		);
	}

	let bytes = 0;
	for (const size of checked.values()) bytes += size;
	return { unit, files: checked.size, bytes, problems, notes };
}
