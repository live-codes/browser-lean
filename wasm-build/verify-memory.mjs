// Did the build produce what was asked for? Run this on a built artifact:
//
//   node wasm-build/verify-memory.mjs out/variant-2/lean.wasm
//
// It answers the two questions that decide whether the artifact can run without cross-origin isolation,
// and exits non-zero if either answer is wrong. It uses the runtime's own import-section reader rather
// than a copy, so there is one parser and the answer matches what the runtime will decide.
//
// Runs on the host, not in the builder image: it only reads a file, and the package's parser is here.
import { readFileSync, statSync } from 'node:fs';

import { memoryMode, readMemoryImport } from '../packages/lean-wasm/src/wasm-memory.js';

const file = process.argv[2];
if (!file) {
	console.error('usage: node wasm-build/verify-memory.mjs <lean.wasm>');
	process.exit(2);
}

const bytes = new Uint8Array(readFileSync(file));
const memory = readMemoryImport(bytes);
let failed = false;

console.log(`${file}`);
console.log(`  ${(statSync(file).size / 1048576).toFixed(2)} MiB`);

if (!memory) {
	console.error('  memory import: NOT FOUND — the import section is missing or unreadable');
	process.exit(1);
}

console.log(`  memory import: "${memory.module}"."${memory.field}"`);
console.log(`  shared:        ${memory.shared}`);
console.log(`  limits:        min ${memory.initial} pages, ${memory.maximum === null ? 'no maximum' : `max ${memory.maximum} pages`}`);
console.log(`  verdict:       ${memoryMode(memory)}`);

if (memory.shared) {
	console.error(
		'\nFAIL: the memory is still shared, so this artifact still needs SharedArrayBuffer and therefore\n' +
			'      still needs cross-origin isolation. -pthread is reaching the link line somewhere; see\n' +
			'      patches/0001-cmake-single-threaded.patch.'
	);
	failed = true;
}

// A first pass at the other half of the requirement: atomics are only valid against a *shared* memory,
// so a module that keeps both an unshared memory and atomic instructions is one V8 will run and a
// conformant engine may reject. Counting raw 0xFE bytes is indicative and not proof — 0xFE can appear
// inside an operand — so a non-zero count means "look closer with a real disassembler", and a zero count
// is strong evidence. The real check is Firefox and Safari: see wasm-build/README.md.
const sections = [];
for (let pos = 8; pos < bytes.length; ) {
	const id = bytes[pos++];
	let size = 0;
	let shift = 0;
	let byte;
	do {
		byte = bytes[pos++];
		size |= (byte & 0x7f) << shift;
		shift += 7;
	} while (byte & 0x80 && pos < bytes.length);
	sections.push({ id, start: pos, size });
	pos += size;
}

const code = sections.find((section) => section.id === 10);
if (code) {
	const slice = bytes.subarray(code.start, code.start + code.size);
	let atomicPrefix = 0;
	for (const byte of slice) if (byte === 0xfe) atomicPrefix++;
	console.log(`  code section:  ${slice.length} bytes, ${atomicPrefix} raw 0xFE bytes (atomic-prefix shaped)`);
	if (atomicPrefix > 0) {
		console.error(
			`\nWARN: ${atomicPrefix} bytes look like the atomic instruction prefix. That is not proof — operands can\n` +
				'      contain 0xFE — but an unshared memory with atomic instructions is a module that V8 will\n' +
				'      run and a conformant engine may reject. Disassemble before shipping, and test Firefox.'
		);
	}
} else {
	console.log('  code section:  not found');
}

process.exit(failed ? 1 : 0);
