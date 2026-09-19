#!/usr/bin/env node
// Materialise the three asset directories this package loads at runtime.
//
// @live-codes/lean-wasm ships no assets and cannot: `lean.wasm` is 96.2 MiB in one file and jsDelivr
// refuses files over 20 MB, before the library data (377 MiB of per-file `.olean`/`.ir` plus a
// 316 MiB Mathlib layer) is even counted. So the runtime is fetched from a host you control, and this
// command is how that host gets filled:
//
//   npx --package @live-codes/lean-wasm lean-wasm-fetch-assets public/lean
//
// It writes the layout `baseUrl` expects:
//
//   <dir>/lean-wasm/     lean.js, lean.wasm, core-layer.json, core-lib/*.pack
//   <dir>/lean-lib/      lean-lib-files.json, then Std/Lean/Batteries module by module
//   <dir>/lean-mathlib/  real-analysis-layer.json, artifacts-*.pack
//
// Resumable — existing files are left alone — so an interrupted ~800 MB run can be restarted.
//
// Serve the directory with BOTH headers, and they are not interchangeable:
//
//   Access-Control-Allow-Origin: *           the wasm and the layers are fetched with fetch()
//   Cross-Origin-Resource-Policy: cross-origin   lean.js arrives via importScripts(), a no-cors
//                                                request that COEP checks against CORP, not CORS
//
// Without the second, every asset downloads and the runtime still fails to boot.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

/** Inflate a buffer if it is gzip, so the script can read an index from either layout. */
function maybeGunzip(buffer) {
	return buffer[0] === 0x1f && buffer[1] === 0x8b ? gunzipSync(buffer) : buffer;
}

// The upstream deploy, and the build the layers were compiled against. The binaries are served by a
// Cloudflare Function that routes on `?v=`, and the *unversioned* URL is an older build whose
// `.olean` files are incompatible with the current packed layer ("incompatible header", at runtime).
const UPSTREAM = 'https://lean.cau.li/lean-wasm';
const ASSET_VERSION = '62b6a2291302d4bbeace37642a066b7510d0145c-dlsym1-compact1';

const LIBRARY_ROOTS = ['Std', 'Lean', 'Batteries'];
const CONCURRENCY = 12;

const USAGE = `Download the Lean runtime assets into a directory you serve.

  lean-wasm-fetch-assets [directory] [options]

  directory        where to write them (default: ./lean)

  --from <url>     asset host to read from (default: the upstream deploy)
  --only <list>    comma-separated: wasm, lib, mathlib (default: all three)
  --no-compress    write lean.wasm and the per-file tree uncompressed
  --check          verify what is already there and exit, downloading nothing
  --force          re-download files that already exist
  --help           print this

Compression (the default) writes \`lean.wasm.gz\` and \`<module>.olean.gz\`, and the runtime fetches
those in preference. It is what makes a static host able to serve this at all: Cloudflare Pages
refuses files over 25 MiB and lean.wasm is 96.2 MiB raw, 16.5 MiB gzipped. Decompression happens in
the browser with DecompressionStream, so it is gzip, not brotli.
`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
	console.log(USAGE);
	process.exit(0);
}

const flag = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};
const force = argv.includes('--force');
const checkOnly = argv.includes('--check');
const compress = !argv.includes('--no-compress');
const from = (flag('--from') ?? UPSTREAM).replace(/\/+$/, '');
const only = (flag('--only') ?? 'wasm,lib,mathlib').split(',').map((part) => part.trim());
const directory = resolve(argv.find((arg) => !arg.startsWith('-') && arg !== flag('--from') && arg !== flag('--only')) ?? 'lean');

// The pinned build only exists behind the upstream Function's `?v=`; a mirror serves it plainly.
const isUpstream = from === UPSTREAM;
const versionQuery = (name) => (isUpstream && (name === 'lean.js' || name === 'lean.wasm') ? `?v=${ASSET_VERSION}` : '');

const mb = (bytes) => (bytes / 1048576).toFixed(1) + ' MiB';

async function fetchRetry(url, attempts = 4) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			const response = await fetch(url);
			if (response.status === 404) return null;
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			return Buffer.from(await response.arrayBuffer());
		} catch (error) {
			if (attempt === attempts - 1) throw error;
			await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
		}
	}
	return null;
}

// ── Validation ──────────────────────────────────────────────────────────────────────────────────
//
// Some hosts answer `200` with their SPA shell for any path they do not have — the upstream deploy
// does exactly that, at `/lean-lib/Std.olean` as much as at `/lean.js`. A URL that is merely *wrong*
// therefore looks like a successful download, and the mirror fills with HTML until Lean reports
// `failed to read file '…', invalid header` somewhere far away. Every asset here has a magic number
// or a shape, so check it before writing rather than debugging it later.

const problems = [];
let manifestCommit;

/** The commit the wasm and core layer were built from, if the manifest is in this directory. */
function pinnedCommit() {
	if (manifestCommit !== undefined) return manifestCommit;
	const path = join(directory, 'lean-wasm', 'core-layer.json');
	manifestCommit = null;
	if (existsSync(path)) {
		try {
			manifestCommit = JSON.parse(readFileSync(path, 'utf8')).leanCommit ?? null;
		} catch {
			manifestCommit = null;
		}
	}
	return manifestCommit;
}

/**
 * Check a file as it would be stored, `name` being the destination name. A `X.y.gz` file must *be*
 * gzip and its contents must then satisfy the rules for `X.y`, so the check is on the stored bytes
 * and a plain mirror validates identically.
 */
function inspect(name, stored) {
	const lead = stored.subarray(0, 512).toString('latin1').replace(/^[\s\uFEFF]+/, '');
	if (lead.startsWith('<')) {
		return { ok: false, reason: `HTML, not an asset: ${JSON.stringify(lead.slice(0, 20))}` };
	}

	if (name.endsWith('.gz')) {
		let inner;
		try {
			inner = gunzipSync(stored);
		} catch {
			return { ok: false, reason: 'not a readable gzip file' };
		}
		return inspect(name.slice(0, -3), inner);
	}

	if (/\.(olean|ir|ir\.sig)$/.test(name)) {
		if (!stored.subarray(0, 5).toString('latin1').startsWith('olean')) {
			return { ok: false, reason: `not an olean file: ${JSON.stringify(stored.subarray(0, 10).toString('latin1'))}` };
		}
		// The header carries the compiler's githash, so the library tree can be checked against the
		// core layer without running anything. This is the check that catches a mixed deployment.
		const githash = stored.subarray(0, 512).toString('latin1').match(/[0-9a-f]{40}/)?.[0];
		const pinned = pinnedCommit();
		if (githash && pinned && githash !== pinned) {
			return { ok: false, reason: `built by Lean ${githash.slice(0, 12)} but the core layer is ${pinned.slice(0, 12)}` };
		}
		return { ok: true };
	}

	if (name.endsWith('.pack')) {
		return { ok: stored[0] === 0x1f && stored[1] === 0x8b, reason: 'not a gzip pack' };
	}
	if (name.endsWith('.wasm')) {
		return { ok: stored.subarray(0, 4).toString('latin1') === '\0asm', reason: 'not a wasm module' };
	}
	if (name.endsWith('.json')) {
		return { ok: lead.startsWith('{') || lead.startsWith('['), reason: `not JSON: ${JSON.stringify(lead.slice(0, 20))}` };
	}
	return { ok: true };
}

/** Write a file that has already been fetched, refusing it if it does not look like what it claims. */
async function writeValidated(path, name, body, url) {
	const verdict = inspect(name, body);
	if (!verdict.ok) {
		problems.push(`${name}: ${verdict.reason} — from ${url}`);
		return false;
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, body);
	return true;
}

/**
 * Download one file unless it is already there.
 *
 * With `compress`, the file is written as `<destination>.gz` — and if the source only *has* the
 * compressed form (mirroring one compressed host onto another), those bytes are copied as they are
 * rather than gzipped twice. A source whose plain name secretly holds gzip is handled the same way,
 * since double compression would decompress to something Lean calls an invalid header.
 */
async function fetchTo(url, destination, label, { compress: gzip = false } = {}) {
	const target = gzip ? `${destination}.gz` : destination;

	if (!force && existsSync(target)) {
		const stored = await readFile(target);
		const verdict = inspect(target, stored);
		if (!verdict.ok) {
			problems.push(`${label}: ${verdict.reason}`);
			return null;
		}
		return stored.length;
	}
	if (checkOnly) return null;

	let body = await fetchRetry(url);
	if (!body && gzip) body = await fetchRetry(`${url}.gz`);
	if (!body) {
		problems.push(`${label}: not published at ${url}`);
		return null;
	}

	const isGzip = body[0] === 0x1f && body[1] === 0x8b;
	let written = body;
	if (gzip) {
		written = isGzip ? body : gzipSync(body, { level: 9 });
	} else if (isGzip) {
		try {
			written = gunzipSync(body);
		} catch (error) {
			problems.push(`${label}: unreadable gzip from ${url} (${error.message})`);
			return null;
		}
	}

	if (!(await writeValidated(target, target, written, url))) return null;
	return (await stat(target)).size;
}

/**
 * Asset sources come in two shapes, and this tool reads both:
 *
 *   flat    upstream's own layout — one directory holding `lean.js`, `core-layer.json`, `lean-lib/`
 *           and `real-analysis-layer.json`. `--from https://lean.cau.li/lean-wasm` is this.
 *   mirror  what this tool writes, and what the runtime expects: three sibling directories,
 *           `lean-wasm/ lean-lib/ lean-mathlib/`. `--from https://your-cdn/lean` is this, and it is
 *           also what you get when re-mirroring one compressed host onto another.
 *
 * Told apart by asking for `lean.js`, which only the flat shape has at the root — and the answer is
 * *checked*, because a wrong base (the site root rather than `/lean-wasm`) gets the SPA shell with a
 * `200`, and taking that as a yes is how a mirror ends up full of HTML.
 */
async function resolveSource(from) {
	const hasLeanJs = async (url) => {
		const body = await fetchRetry(url);
		return body != null && inspect('lean.js', body).ok;
	};

	if (await hasLeanJs(`${from}/lean.js`)) {
		return {
			kind: 'flat',
			wasmBase: from,
			libBase: from,
			layerManifest: `${from}/real-analysis-layer.json`,
			layerPackBase: `${from}/real-analysis-lib`
		};
	}
	if (await hasLeanJs(`${from}/lean-wasm/lean.js`)) {
		return {
			kind: 'mirror',
			wasmBase: `${from}/lean-wasm`,
			libBase: `${from}/lean-lib`,
			layerManifest: `${from}/lean-mathlib/real-analysis-layer.json`,
			layerPackBase: `${from}/lean-mathlib`
		};
	}
	throw new Error(`No lean.js at ${from} or ${from}/lean-wasm — is that an asset host?`);
}

/**
 * Fetch a packed layer: the manifest, then every pack it names. Packs are written under `packDir`
 * inside `outRoot`, which is where the runtime looks for them.
 */
async function fetchLayer({ manifestUrl, packBase, outRoot, packDir, manifestName, label }) {
	const manifestPath = join(outRoot, manifestName);
	let manifest;
	if (existsSync(manifestPath) && !force) {
		manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	} else {
		if (checkOnly) return 0;
		const body = await fetchRetry(manifestUrl);
		if (!body) throw new Error(`${manifestUrl} is not published`);
		if (!(await writeValidated(manifestPath, manifestName, body, manifestUrl))) {
			throw new Error(`${manifestName} is not a valid manifest at ${manifestUrl}`);
		}
		manifest = JSON.parse(body.toString('utf8'));
	}

	let bytes = (await stat(manifestPath)).size;
	let done = 0;
	for (const pack of manifest.packs) {
		const written = await fetchTo(`${packBase}/${pack.file}`, join(outRoot, packDir, pack.file), `${label}/${pack.file}`);
		if (written != null) bytes += written;
		done += 1;
	}
	console.log(`${label}: ${manifest.modules} modules, ${done} packs, ${mb(bytes)}`);
	return bytes;
}

/**
 * Fetch the per-file library tree for the given roots.
 *
 * Compressed as a set: the index becomes `lean-lib-files.json.gz`, and every module file gains a `.gz`
 * suffix. The runtime probes the index once to decide how the whole directory is stored, so the two
 * must not be mixed.
 */
async function fetchLibs(sourceBase, outRoot, roots) {
	const gz = compress ? '.gz' : '';
	const indexPath = join(outRoot, `lean-lib-files.json${gz}`);
	let index;
	const stored = existsSync(indexPath) ? await readFile(indexPath) : null;
	const verdict = stored ? inspect(indexPath, stored) : null;

	if (stored && verdict.ok && !force) {
		index = JSON.parse(maybeGunzip(stored).toString('utf8'));
	} else {
		if (stored && !verdict.ok) problems.push(`lean-lib-files.json${gz}: ${verdict.reason}`);
		if (checkOnly) return 0;
		const body = await fetchRetry(`${sourceBase}/lean-lib-files.json`);
		if (!body) throw new Error(`lean-lib-files.json is not published at ${sourceBase}`);
		const written = compress ? gzipSync(body, { level: 9 }) : body;
		if (!(await writeValidated(indexPath, `lean-lib-files.json${gz}`, written, `${sourceBase}/lean-lib-files.json`))) {
			throw new Error(`lean-lib-files.json is not a valid index at ${sourceBase}`);
		}
		index = JSON.parse(body.toString('utf8'));
	}

	const modules = index.filter((path) => roots.some((root) => path === `${root}.olean` || path.startsWith(`${root}/`)));
	// A module's `.ir` is only used when its `.ir.sig` is present, so all three travel together.
	const targets = [];
	for (const module of modules) {
		targets.push(module, module.replace(/\.olean$/, '.ir'), module.replace(/\.olean$/, '.ir.sig'));
	}

	let bytes = 0;
	let done = 0;
	let next = 0;
	async function worker() {
		for (;;) {
			const i = next++;
			if (i >= targets.length) return;
			const rel = targets[i];
			try {
				const written = await fetchTo(`${sourceBase}/${rel}`, join(outRoot, rel), `lean-lib/${rel}`, { compress });
				if (written != null) bytes += written;
			} catch (error) {
				console.warn(`  ! ${rel}: ${error.message}`);
			}
			done += 1;
			if (done % 1000 === 0) console.log(`  lean-lib: ${done}/${targets.length} files, ${mb(bytes)}`);
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	console.log(`lean-lib: ${roots.join(', ')} → ${done} files, ${mb(bytes)}${compress ? ' (gzipped)' : ''}`);
	return bytes;
}

const total = { bytes: 0, started: Date.now() };
const sourceLabel = isUpstream ? 'the upstream deploy' : from;
console.log(`${checkOnly ? 'Verifying' : 'Fetching'} Lean assets from ${sourceLabel}`);
console.log(`into ${directory}\n`);

try {
	const source = await resolveSource(from);
	console.log(`source shape: ${source.kind}\n`);

	if (only.includes('wasm')) {
		const outRoot = join(directory, 'lean-wasm');
		let bytes = 0;
		// lean.js stays plain: it is 148 KB of text, and every CDN compresses text in transit anyway.
		bytes += (await fetchTo(`${source.wasmBase}/lean.js${versionQuery('lean.js')}`, join(outRoot, 'lean.js'), 'lean.js')) ?? 0;
		bytes +=
			(await fetchTo(`${source.wasmBase}/lean.wasm${versionQuery('lean.wasm')}`, join(outRoot, 'lean.wasm'), 'lean.wasm', {
				compress
			})) ?? 0;
		// The core layer is already gzip containers, so there is nothing to gain by wrapping it again.
		bytes += await fetchLayer({
			manifestUrl: `${source.wasmBase}/core-layer.json`,
			packBase: `${source.wasmBase}/core-lib`,
			outRoot,
			packDir: 'core-lib',
			manifestName: 'core-layer.json',
			label: 'lean-wasm'
		});
		console.log(`lean-wasm: ${mb(bytes)}${compress ? ' (wasm gzipped)' : ''}\n`);
		total.bytes += bytes;
	}

	if (only.includes('lib')) {
		total.bytes += await fetchLibs(source.libBase, join(directory, 'lean-lib'), LIBRARY_ROOTS);
		console.log('');
	}

	if (only.includes('mathlib')) {
		total.bytes += await fetchLayer({
			manifestUrl: source.layerManifest,
			packBase: source.layerPackBase,
			outRoot: join(directory, 'lean-mathlib'),
			packDir: '',
			manifestName: 'real-analysis-layer.json',
			label: 'lean-mathlib'
		});
		console.log('');
	}

	console.log(`${checkOnly ? 'found' : 'fetched'} ${mb(total.bytes)} in ${Math.round((Date.now() - total.started) / 1000)}s`);

	if (problems.length) {
		console.log(`\n${problems.length} file(s) did not look like Lean assets:`);
		for (const problem of problems.slice(0, 8)) console.log(`  - ${problem}`);
		if (problems.length > 8) console.log(`  … and ${problems.length - 8} more`);
		console.log(
			checkOnly
				? '\nThat deployment cannot be used as it stands.'
				: '\nThey were refused rather than written — check that --from points at the asset directory itself.'
		);
		process.exitCode = 1;
	} else if (!checkOnly) {
		console.log('\nServe that directory as `baseUrl`, with both headers:');
		console.log('  Access-Control-Allow-Origin: *');
		console.log('  Cross-Origin-Resource-Policy: cross-origin');
		console.log('\nLean needs a cross-origin isolated page (COOP/COEP) to run at all.');
		if (compress) {
			console.log('Compressed layout: the runtime prefers <file>.gz and falls back to the plain name,');
			console.log('so you can delete the uncompressed originals to halve what you host.');
		}
	}
} catch (error) {
	console.error(`\nfailed: ${error.message}`);
	process.exit(1);
}
