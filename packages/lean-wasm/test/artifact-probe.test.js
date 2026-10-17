// The artifact probe: the half that talks to a host.
//
// These run against an in-test HTTP server, so the layouts and the failure modes are the ones a real host
// produces rather than stubs: a gzipped artifact, a plain one, a 404, and the SPA-fallback host that
// answers `200` with HTML for a file it does not have (FINDINGS.md §5 — the failure that looks like a
// successful download). The browser's own `DecompressionStream` is exercised when the demo runs headless;
// these pin the logic, including the budget the probe is allowed to spend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

import { probeArtifactMemory } from '../src/artifact-probe.js';
import { MEMORY_PROBE_BYTES } from '../src/wasm-memory.js';

const leb = (v) => { const out = []; let n = v; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const nm = (t) => [...leb(t.length), ...[...t].map((c) => c.charCodeAt(0))];
const sec = (id, content) => [id, ...leb(content.length), ...content];

function artifact({ shared, initial = 1024, maximum = 65536 }) {
	const flags = (shared ? 0x02 : 0x00) | (maximum === null ? 0x00 : 0x01);
	return Uint8Array.from([
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		...sec(1, [0x01, 0x60, 0x00, 0x00]),
		...sec(2, [0x01, ...nm('env'), ...nm('memory'), 0x02, ...leb(flags), ...leb(initial), ...(maximum === null ? [] : leb(maximum))]),
		...sec(3, [0x01, 0x00]),
		...sec(10, [0x01, 0x04, 0x00, 0x41, 0x00, 0x0b])
	]);
}

/** A module whose import section sits past the probe budget, behind a large custom section. */
function artifactWithPadding(padding) {
	return Uint8Array.from([
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		...sec(0, new Array(padding).fill(0)),
		...artifact({ shared: true })
	]);
}

async function withServer(files, run) {
	const server = createServer((req, res) => {
		const body = files[req.url];
		if (body === undefined) {
			res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
			return;
		}
		res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(Buffer.from(body));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	try {
		await run(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

test('reads a shared artifact from the compressed layout', async () => {
	const shared = artifact({ shared: true });
	await withServer({ '/lean-wasm/lean.wasm.gz': gzipSync(shared) }, async (base) => {
		const result = await probeArtifactMemory(`${base}/lean-wasm`);
		assert.equal(result.mode, 'shared');
		assert.equal(result.url, `${base}/lean-wasm/lean.wasm.gz`);
		assert.deepEqual(result.memory, { module: 'env', field: 'memory', shared: true, initial: 1024, maximum: 65536 });
		// The whole point: a fraction of the artifact, not the artifact.
		assert.ok(result.bytesRead <= MEMORY_PROBE_BYTES / 4, `read ${result.bytesRead} bytes`);
	});
});

test('reads an unshared artifact from the plain layout', async () => {
	const unshared = artifact({ shared: false, initial: 256, maximum: 32768 });
	await withServer({ '/lean-wasm/lean.wasm': unshared }, async (base) => {
		const result = await probeArtifactMemory(`${base}/lean-wasm`);
		assert.equal(result.mode, 'unshared');
		assert.equal(result.memory.shared, false);
		assert.equal(result.bytesRead, unshared.length, 'a small plain artifact is read whole');
	});
});

test('follows the same layout order the boot does', async () => {
	// Both layouts present: the compressed one wins, so the probe agrees with `loadWasmUrl`.
	const shared = artifact({ shared: true });
	await withServer(
		{ '/lean-wasm/lean.wasm.gz': gzipSync(shared), '/lean-wasm/lean.wasm': artifact({ shared: false }) },
		async (base) => {
			const result = await probeArtifactMemory(`${base}/lean-wasm`);
			assert.equal(result.mode, 'shared');
			assert.match(result.url, /\.gz$/);
		}
	);
});

test('a host that 404s reads as unknown', async () => {
	await withServer({}, async (base) => {
		assert.equal(await probeArtifactMemory(`${base}/lean-wasm`), null);
	});
});

test('a host that answers 200 with HTML reads as unknown, not as a memory', async () => {
	// The SPA fallback: `serve.js --spa-fallback` and Cloudflare Pages both do this, and it is how a
	// missing asset tree comes to look like a successful download.
	const html = '<!doctype html>\n<html><body>not a wasm module</body></html>\n';
	await withServer(
		{ '/lean-wasm/lean.wasm.gz': html, '/lean-wasm/lean.wasm': html },
		async (base) => {
			assert.equal(await probeArtifactMemory(`${base}/lean-wasm`), null);
		}
	);
});

test('an import section past the budget reads as unknown rather than as a guess', async () => {
	// This is the contract that lets the caller fall back to assuming a shared memory. The cost of being
	// wrong in the other direction — inventing an unshared memory for a pthread build — is a wedged boot.
	const padded = artifactWithPadding(MEMORY_PROBE_BYTES * 2);
	assert.ok(padded.length > MEMORY_PROBE_BYTES);
	await withServer({ '/lean-wasm/lean.wasm': padded }, async (base) => {
		assert.equal(await probeArtifactMemory(`${base}/lean-wasm`), null);
	});
});

test('an unreachable base reads as unknown instead of throwing', async () => {
	assert.equal(await probeArtifactMemory(''), null);
	assert.equal(await probeArtifactMemory('http://127.0.0.1:1/lean-wasm'), null);
});

test('a .gz URL that is not actually gzipped is still read', async () => {
	// A host that serves the plain file under the compressed name, or a proxy that already decompressed
	// it. Sniffing the magic bytes rather than trusting the URL is what makes this work.
	const unshared = artifact({ shared: false });
	await withServer({ '/lean-wasm/lean.wasm.gz': unshared }, async (base) => {
		const result = await probeArtifactMemory(`${base}/lean-wasm`);
		assert.equal(result?.mode, 'unshared');
	});
});
