// Ask an asset host what memory its wasm declares, without downloading it.
//
// The requirement this settles is FINDINGS.md §2: a `shared` memory needs a `SharedArrayBuffer`, which
// needs cross-origin isolation, and a page that cannot have isolation should say so *before* pulling
// 16.5 MiB off the wire to discover it at the link step. The full module is 96.17 MiB, and the import
// section sits at byte 0x1302 of it, so the answer is in the first fraction of a percent.
//
// Two details make this work against an ordinary static host rather than a cooperating one:
//
//   - **No `Range` request.** `serve.js` here ignores `Range`, Cloudflare Pages honours it, and a
//     bucket may or may not — so the probe reads the ordinary response body and cancels the reader once
//     it has enough. The transfer stops there; the host is not asked for anything unusual.
//   - **A partial gunzip.** The default layout is gzipped, and `DecompressionStream` inflates a prefix
//     of a gzip stream as it goes. It also ends in an error, because the stream is truncated — which is
//     expected here, and the reason the inflated chunks are collected before the error is read.
//
// Every failure is soft. An unreadable artifact returns `null`, and callers treat that as "unknown" and
// fall back to the behaviour of assuming a shared memory, which is what the pthread build needs and what
// this project did before it could ask.

import { MEMORY_PROBE_BYTES, readMemoryImport } from './wasm-memory.js';

/**
 * How much *compressed* input to accept.
 *
 * Derived from the uncompressed budget above rather than picked, on the assumption that gzip will do no
 * worse than 4× — the pinned build actually manages ~6×, so this is the conservative half of the same
 * number and there is only one budget to reason about.
 */
const COMPRESSED_PREFIX_BYTES = MEMORY_PROBE_BYTES / 4;

function take(chunks, limit) {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const out = new Uint8Array(Math.min(total, limit));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= out.length) break;
		const slice = chunk.subarray(0, Math.min(chunk.length, out.length - offset));
		out.set(slice, offset);
		offset += slice.length;
	}
	return out;
}

/**
 * Read `limit` bytes of a response body and stop the transfer.
 *
 * `content-length` is only used for the report; nothing about the answer depends on it.
 */
async function readPrefix(response, limit) {
	if (!response.body) {
		// No streaming: a body of 16.5 MiB is already in memory either way.
		return new Uint8Array(await response.arrayBuffer()).subarray(0, limit);
	}

	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		while (total < limit) {
			const { value, done } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.length;
		}
	} catch {
		// A dropped connection after enough bytes is the same as `done` for our purposes.
	} finally {
		// Not awaited: the point is to stop the download, not to wait for the acknowledgement.
		reader.cancel().catch(() => {});
	}
	return take(chunks, limit);
}

/** Inflate as much of a gzip prefix as it will give, tolerating the error a truncated stream ends with. */
async function inflatePrefix(bytes, limit) {
	const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
	const chunks = [];
	let total = 0;
	try {
		while (total < limit) {
			const { value, done } = await reader.read();
			if (done) break;
			chunks.push(value);
			total += value.length;
		}
	} catch {
		// Expected: this input is a prefix, so the deflate stream never terminates cleanly. What came
		// out before the error is what the reader wanted all along.
	} finally {
		reader.cancel().catch(() => {});
	}
	return take(chunks, limit);
}

function looksGzipped(bytes) {
	return bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Work out what memory the artifact at `assetBase` declares.
 *
 * Both layouts are tried in the order the runtime fetches them, so the probe agrees with the boot:
 * `lean.wasm.gz` first (the compressed layout a size-limited host needs), then `lean.wasm`.
 *
 * @param {string} assetBase - the directory holding `lean.wasm`/`lean.wasm.gz`.
 * @returns {Promise<null|{mode: 'shared'|'unshared', memory: object, url: string, bytesRead: number}>}
 *   `null` when the artifact could not be read — a 404, an SPA fallback answering HTML, a host that
 *   will not stream, or an import section beyond the probe budget.
 */
export async function probeArtifactMemory(assetBase) {
	const base = String(assetBase ?? '').replace(/\/+$/, '');
	const candidates = [`${base}/lean.wasm.gz`, `${base}/lean.wasm`];

	for (const candidate of candidates) {
		let response;
		try {
			response = await fetch(candidate);
		} catch {
			continue;
		}
		if (response.status === 404) continue;
		if (!response.ok) continue;

		try {
			const raw = await readPrefix(response, COMPRESSED_PREFIX_BYTES);
			const bytes = looksGzipped(raw) ? await inflatePrefix(raw, MEMORY_PROBE_BYTES) : raw;
			const memory = readMemoryImport(bytes);
			if (!memory) continue;
			return {
				mode: memory.shared ? 'shared' : 'unshared',
				memory,
				url: candidate,
				bytesRead: raw.length
			};
		} catch {
			// A host that will not stream, or a decompressor that will not cooperate: try the next layout.
			continue;
		}
	}

	return null;
}
