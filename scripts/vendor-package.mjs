/**
 * Copy the package's browser build into `public/`, so the demo is deployable as it stands.
 *
 * A static host serves files, not routes. The page used to import the package's ES module entry
 * through a path prefix that only `serve.js` knew about, which worked locally and failed on
 * Cloudflare Pages: the request fell through to the SPA fallback, came back as `index.html`, and the
 * browser refused it — `Expected a JavaScript-or-Module script but the server responded with a MIME
 * type of "text/html"`. Vendoring the IIFE build is the version that survives being uploaded.
 *
 * It is the artifact a worker or a host would consume anyway — `importScripts('lean-wasm.global.js')`
 * then `self.leanWasm.createCompiler({ baseUrl })` — and it is generated rather than copied by hand,
 * so there is still exactly one implementation of the driver.
 *
 *   node scripts/vendor-package.mjs           write it
 *   node scripts/vendor-package.mjs --check   fail if it is stale (part of `npm run check`)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const checkOnly = process.argv.includes('--check');

const FILES = [['packages/lean-wasm/dist/lean-wasm.global.js', 'public/vendor/lean-wasm.global.js']];

let stale = 0;

for (const [from, to] of FILES) {
	const bytes = readFileSync(join(root, from));
	const target = join(root, to);
	const current = existsSync(target) ? readFileSync(target) : null;

	if (current?.equals(bytes)) {
		console.log(`${to} is in sync`);
		continue;
	}

	if (checkOnly) {
		console.log(`${to} is ${current ? 'out of date' : 'missing'} — run \`npm run sync:vendor\``);
		stale += 1;
		continue;
	}

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, bytes);
	console.log(`${to} written (${(bytes.length / 1024).toFixed(1)} KB)`);
}

if (stale > 0) process.exitCode = 1;
