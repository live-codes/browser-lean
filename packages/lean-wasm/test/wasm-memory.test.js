// The memory-import reader, which decides whether this runtime needs cross-origin isolation.
//
// The synthetic cases pin the flag semantics and the fail-soft behaviour. The last two read the real
// artifact when it has been mirrored (`npm run assets`, gitignored), which is the only way to know that
// `MEMORY_PROBE_BYTES` is enough for the pinned build rather than merely plausible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createGunzip, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { MEMORY_PROBE_BYTES, memoryMode, readMemoryImport } from '../src/wasm-memory.js';

const PINNED = { module: 'env', field: 'memory', shared: true, initial: 1024, maximum: 65536 };

const leb = (value) => {
	const out = [];
	let n = value;
	do {
		let byte = n & 0x7f;
		n >>>= 7;
		if (n) byte |= 0x80;
		out.push(byte);
	} while (n);
	return out;
};
const name = (text) => [...leb(text.length), ...[...text].map((c) => c.charCodeAt(0))];
const section = (id, content) => [id, ...leb(content.length), ...content];

/** A minimal module whose only interesting feature is the memory import's flags. */
function moduleWithMemory({ shared, initial = 1024, maximum = 65536, module = 'env', field = 'memory' }) {
	const flags = (shared ? 0x02 : 0x00) | (maximum === null ? 0x00 : 0x01);
	const limits = [...leb(flags), ...leb(initial), ...(maximum === null ? [] : leb(maximum))];
	return Uint8Array.from([
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // \0asm, version 1
		...section(1, [0x01, 0x60, 0x00, 0x00]), // type: () -> ()
		...section(2, [0x01, ...name(module), ...name(field), 0x02, ...limits]),
		...section(3, [0x01, 0x00]), // function: type 0
		...section(10, [0x01, 0x04, 0x00, 0x41, 0x00, 0x0b]) // code: i32.const 0; end
	]);
}

test('reads a shared memory import and its declared bounds', () => {
	const memory = readMemoryImport(moduleWithMemory({ shared: true }));
	assert.deepEqual(memory, PINNED);
	assert.equal(memoryMode(memory), 'shared');
});

test('reads an unshared memory import — the single-threaded case', () => {
	const memory = readMemoryImport(moduleWithMemory({ shared: false, initial: 256, maximum: 32768 }));
	assert.deepEqual(memory, { module: 'env', field: 'memory', shared: false, initial: 256, maximum: 32768 });
	assert.equal(memoryMode(memory), 'unshared');
});

test('no declared maximum is not read as one', () => {
	const memory = readMemoryImport(moduleWithMemory({ shared: true, initial: 512, maximum: null }));
	assert.equal(memory.shared, true);
	assert.equal(memory.initial, 512);
	assert.equal(memory.maximum, null);
});

test('walks past function, table, global and tag imports to reach the memory', () => {
	const bytes = Uint8Array.from([
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		...section(2, [
			0x05, // five imports, in the order the memory last
			...name('env'), ...name('__indirect_function_table'), 0x01, 0x70, 0x01, ...leb(1), ...leb(2),
			...name('env'), ...name('malloc'), 0x00, ...leb(3),
			...name('env'), ...name('__stack_pointer'), 0x03, 0x7f, 0x01,
			...name('env'), ...name('__cpp_exception'), 0x04, 0x00, ...leb(1),
			...name('env'), ...name('memory'), 0x02, 0x03, ...leb(1024), ...leb(65536)
		])
	]);
	assert.deepEqual(readMemoryImport(bytes), PINNED);
});

test('every prefix either reads the import or reads as unknown — never something else', () => {
	const whole = moduleWithMemory({ shared: true });
	let shortest = null;

	for (let cut = 1; cut <= whole.length; cut++) {
		const memory = readMemoryImport(whole.subarray(0, cut));
		if (memory === null) continue;
		if (shortest === null) shortest = cut;
		assert.deepEqual(memory, PINNED, `a ${cut}-byte prefix read to a different answer`);
	}

	assert.ok(shortest !== null, 'some prefix must contain the import');
	assert.ok(shortest > 8, 'the import cannot be inside the magic and version alone');
	assert.deepEqual(readMemoryImport(whole), PINNED);
});

test('bytes that are not a wasm module read as unknown', () => {
	assert.equal(readMemoryImport(new Uint8Array(0)), null);
	assert.equal(readMemoryImport(Uint8Array.from([0x3c, 0x21, 0x2d, 0x2d])), null); // an HTML 404 body
	assert.equal(readMemoryImport(new Uint8Array(64)), null);
	assert.equal(memoryMode(null), 'unknown');
});

test('an unknown import kind stops the read rather than skipping the wrong number of bytes', () => {
	// 0x7f is not an import kind. Skipping it as a function (one u32) would then read the *next*
	// entry's names as limits, and invent a memory out of nonsense.
	const bytes = Uint8Array.from([
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		...section(2, [0x01, ...name('env'), ...name('weird'), 0x7f, ...leb(3)])
	]);
	assert.equal(readMemoryImport(bytes), null);
});

test('the pinned artifact declares a shared memory, and its import fits in the probe budget', async (t) => {
	const gz = fileURLToPath(new URL('../../../public/lean-wasm/lean.wasm.gz', import.meta.url));
	if (!existsSync(gz)) {
		t.skip('no mirrored artifact — run `npm run assets` to check this against the real build');
		return;
	}

	// Stop as soon as the budget is filled, which is what the browser probe does to the response body.
	const stream = createReadStream(gz).pipe(createGunzip());
	stream.on('error', () => {});
	const chunks = [];
	let total = 0;
	for await (const chunk of stream) {
		chunks.push(chunk);
		total += chunk.length;
		if (total >= MEMORY_PROBE_BYTES) break;
	}
	stream.destroy();

	const prefix = new Uint8Array(Buffer.concat(chunks).subarray(0, MEMORY_PROBE_BYTES));
	assert.equal(prefix.length, MEMORY_PROBE_BYTES);
	assert.deepEqual(readMemoryImport(prefix), PINNED);
});

test('the whole artifact reads the same way as its prefix', async (t) => {
	const gz = fileURLToPath(new URL('../../../public/lean-wasm/lean.wasm.gz', import.meta.url));
	if (!existsSync(gz)) {
		t.skip('no mirrored artifact');
		return;
	}
	const whole = new Uint8Array(gunzipSync(readFileSync(gz)));
	assert.equal(whole.length, 100838905, 'the pinned build is 96.17 MiB');
	assert.deepEqual(readMemoryImport(whole), readMemoryImport(whole.subarray(0, MEMORY_PROBE_BYTES)));
});
