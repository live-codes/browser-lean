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

import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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
  --check          verify what is already there and exit, downloading nothing
  --force          re-download files that already exist
  --help           print this
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

/** Download one file unless it is already there. Returns the bytes written, or null if absent. */
async function fetchTo(url, destination, label) {
	if (!force && existsSync(destination)) return (await stat(destination)).size;
	if (checkOnly) return null;

	const body = await fetchRetry(url);
	if (!body) {
		console.warn(`  ! ${label} is not published at ${url}`);
		return null;
	}
	await mkdir(dirname(destination), { recursive: true });
	await writeFile(destination, body);
	return body.length;
}

/** Fetch a packed layer: the manifest, then every pack it names. */
async function fetchLayer(sourceBase, manifestRel, packDirRel, outRoot, label) {
	const manifestPath = join(outRoot, manifestRel);
	let manifest;
	if (existsSync(manifestPath) && !force) {
		manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
	} else {
		if (checkOnly) return 0;
		const body = await fetchRetry(`${sourceBase}/${manifestRel}`);
		if (!body) throw new Error(`${manifestRel} is not published at ${sourceBase}`);
		await mkdir(dirname(manifestPath), { recursive: true });
		await writeFile(manifestPath, body);
		manifest = JSON.parse(body.toString('utf8'));
	}

	let bytes = (await stat(manifestPath)).size;
	let done = 0;
	for (const pack of manifest.packs) {
		const written = await fetchTo(
			`${sourceBase}/${packDirRel}/${pack.file}`,
			join(outRoot, packDirRel, pack.file),
			`${label}/${pack.file}`
		);
		if (written != null) bytes += written;
		done += 1;
	}
	console.log(`${label}: ${manifest.modules} modules, ${done} packs, ${mb(bytes)}`);
	return bytes;
}

/** Fetch the per-file library tree for the given roots. */
async function fetchLibs(sourceBase, outRoot, roots) {
	const indexPath = join(outRoot, 'lean-lib-files.json');
	let index;
	if (existsSync(indexPath) && !force) {
		index = JSON.parse(await readFile(indexPath, 'utf8'));
	} else {
		if (checkOnly) return 0;
		const body = await fetchRetry(`${sourceBase}/lean-lib-files.json`);
		if (!body) throw new Error(`lean-lib-files.json is not published at ${sourceBase}`);
		await mkdir(outRoot, { recursive: true });
		await writeFile(indexPath, body);
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
				const written = await fetchTo(`${sourceBase}/${rel}`, join(outRoot, rel), `lean-lib/${rel}`);
				if (written != null) bytes += written;
			} catch (error) {
				console.warn(`  ! ${rel}: ${error.message}`);
			}
			done += 1;
			if (done % 1000 === 0) console.log(`  lean-lib: ${done}/${targets.length} files, ${mb(bytes)}`);
		}
	}
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	console.log(`lean-lib: ${roots.join(', ')} → ${done} files, ${mb(bytes)}`);
	return bytes;
}

const total = { bytes: 0, started: Date.now() };
const sourceLabel = isUpstream ? 'the upstream deploy' : from;
console.log(`${checkOnly ? 'Verifying' : 'Fetching'} Lean assets from ${sourceLabel}`);
console.log(`into ${directory}\n`);

try {
	if (only.includes('wasm')) {
		const root = join(directory, 'lean-wasm');
		let bytes = 0;
		for (const name of ['lean.js', 'lean.wasm']) {
			bytes += (await fetchTo(`${from}/${name}${versionQuery(name)}`, join(root, name), name)) ?? 0;
		}
		bytes += await fetchLayer(from, 'core-layer.json', 'core-lib', root, 'lean-wasm');
		console.log(`lean-wasm: ${mb(bytes)}\n`);
		total.bytes += bytes;
	}

	if (only.includes('lib')) {
		total.bytes += await fetchLibs(from, join(directory, 'lean-lib'), LIBRARY_ROOTS);
		console.log('');
	}

	if (only.includes('mathlib')) {
		total.bytes += await fetchLayer(
			from,
			'real-analysis-layer.json',
			'real-analysis-lib',
			join(directory, 'lean-mathlib'),
			'lean-mathlib'
		);
		console.log('');
	}

	console.log(`${checkOnly ? 'found' : 'fetched'} ${mb(total.bytes)} in ${Math.round((Date.now() - total.started) / 1000)}s`);
	if (!checkOnly) {
		console.log('\nServe that directory as `baseUrl`, with both headers:');
		console.log('  Access-Control-Allow-Origin: *');
		console.log('  Cross-Origin-Resource-Policy: cross-origin');
		console.log('\nLean needs a cross-origin isolated page (COOP/COEP) to run at all.');
	}
} catch (error) {
	console.error(`\nfailed: ${error.message}`);
	process.exit(1);
}
