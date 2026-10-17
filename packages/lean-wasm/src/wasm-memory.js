// What the wasm artifact says about its own memory.
//
// `lean.wasm` does not define a memory; it **imports** one, and the flags on that import are the whole
// cross-origin-isolation question. Bit 1 of the limits flags is `shared`, and a shared memory can only be
// constructed with a `SharedArrayBuffer`, which browsers expose only to a cross-origin isolated document.
// So `flags: 3` in the artifact is why this project needs COOP/COEP at all (FINDINGS.md §2).
//
// The runtime reads that off the artifact instead of assuming it. Two reasons, and neither is
// hypothetical:
//
//   - A single-threaded build declares an unshared memory and needs no isolation anywhere. The same
//     runtime should serve both without being reconfigured, because the artifact already says which it
//     is (FINDINGS.md §9).
//   - A page about to run into the requirement can say *why* before it downloads 16.5 MiB of wasm and
//     discovers it at the link step.
//
// This module is pure on purpose: bytes in, a description out. Reading the bytes — a partial fetch and,
// for the compressed layout, a partial gunzip — is `artifact-probe.js`, which needs a browser.

const MAGIC = [0x00, 0x61, 0x73, 0x6d];

// Section ids we have to walk past to reach the import section, and the import kinds within it. Only the
// ones the Emscripten module actually emits are handled; anything else ends the read rather than being
// guessed at.
const IMPORT_SECTION = 2;
const KIND_FUNC = 0x00;
const KIND_TABLE = 0x01;
const KIND_MEMORY = 0x02;
const KIND_GLOBAL = 0x03;
const KIND_TAG = 0x04;

const FLAG_HAS_MAXIMUM = 0x01;
const FLAG_SHARED = 0x02;

/**
 * How much of the wasm to ask a host for before parsing. The import section sits near the start — in the
 * pinned build the memory import is at byte 0x1302 of a 96.17 MiB file — so this is generous by two
 * orders of magnitude, and the probe still cancels the rest of the response. It is a hint, not a
 * contract: if a future build puts the import section past it, the read fails soft to `null` and the
 * caller fetches the whole thing.
 */
export const MEMORY_PROBE_BYTES = 262144;

/** A bounds-checked reader over a byte prefix that may be — and for a probe, usually is — truncated. */
function cursor(bytes, start) {
  return {
    pos: start,
    byte() {
      if (this.pos >= bytes.length) return null;
      return bytes[this.pos++];
    },
    /** LEB128, at most 5 bytes for the u32s wasm uses here. */
    u32() {
      let result = 0;
      let shift = 0;
      for (;;) {
        if (this.pos >= bytes.length || shift > 28) return null;
        const value = bytes[this.pos++];
        result |= (value & 0x7f) << shift;
        shift += 7;
        if ((value & 0x80) === 0) return result >>> 0;
      }
    },
    /** A wasm name: a length-prefixed byte string, read as latin1 because it is only ever compared. */
    name() {
      const length = this.u32();
      if (length === null) return null;
      if (this.pos + length > bytes.length) return null;
      let text = '';
      for (let i = 0; i < length; i++) text += String.fromCharCode(bytes[this.pos + i]);
      this.pos += length;
      return text;
    },
    skip(count) {
      if (this.pos + count > bytes.length) return null;
      this.pos += count;
      return true;
    }
  };
}

/** Walk one import entry, returning the memory import the moment it is found. */
function readImportEntries(read, end) {
  const count = read.u32();
  if (count === null) return null;

  for (let index = 0; index < count; index++) {
    const module = read.name();
    const field = read.name();
    if (module === null || field === null) return null;

    const kind = read.byte();
    if (kind === null) return null;

    if (kind === KIND_MEMORY) {
      const flags = read.u32();
      if (flags === null) return null;
      const initial = read.u32();
      if (initial === null) return null;
      let maximum = null;
      if (flags & FLAG_HAS_MAXIMUM) {
        maximum = read.u32();
        if (maximum === null) return null;
      }
      return { module, field, shared: (flags & FLAG_SHARED) !== 0, initial, maximum };
    }

    if (kind === KIND_FUNC) {
      if (read.u32() === null) return null;
    } else if (kind === KIND_TABLE) {
      if (read.skip(1) === null) return null; // element type
      const flags = read.u32();
      if (flags === null) return null;
      if (read.u32() === null) return null; // minimum
      if (flags & FLAG_HAS_MAXIMUM && read.u32() === null) return null;
    } else if (kind === KIND_GLOBAL) {
      if (read.skip(2) === null) return null; // value type, mutability
    } else if (kind === KIND_TAG) {
      if (read.skip(1) === null) return null; // attribute
      if (read.u32() === null) return null; // type index
    } else {
      // An import kind this reader does not know cannot be skipped safely.
      return null;
    }

    if (read.pos > end) return null;
  }

  return null;
}

/**
 * Read the module's memory import, if this prefix contains it.
 *
 * @param {Uint8Array} bytes - the start of a wasm module. A truncated prefix is expected and is not an
 *   error: the answer is then `null`.
 * @returns {{module: string, field: string, shared: boolean, initial: number, maximum: number|null}|null}
 *   `shared` is the whole point; `initial` and `maximum` are in 64 KiB pages and are what the runtime
 *   needs to construct a matching memory (a `maximum` larger than the module declares fails to link,
 *   which is the `LinkError` FINDINGS.md §2 records).
 */
export function readMemoryImport(bytes) {
  if (!bytes || bytes.length < 8) return null;
  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) return null;
  }

  const read = cursor(bytes, 8);
  while (read.pos < bytes.length) {
    const id = read.byte();
    const size = read.u32();
    if (id === null || size === null) return null;

    const end = read.pos + size;
    if (end > bytes.length) return null; // the section is not fully inside this prefix

    if (id === IMPORT_SECTION) return readImportEntries(read, end);
    read.pos = end;
  }

  return null;
}

/**
 * The memory mode, as a word, for a decision or a message.
 *
 * @param {object|null} memory - the result of `readMemoryImport`.
 * @returns {'shared'|'unshared'|'unknown'}
 */
export function memoryMode(memory) {
  if (!memory) return 'unknown';
  return memory.shared ? 'shared' : 'unshared';
}
