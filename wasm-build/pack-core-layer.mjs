// Pack a freshly built library tree into the core layer the runtime boots from.
//
// The runtime fetches `core-layer.json` plus a handful of gzip packs at boot rather than ~1,900
// individual files (FINDINGS.md §5), and a fresh build has none: packing is upstream's job
// (`scripts/package-core-layer.mjs` in cauli/lean4-wasm-in-browser, which ships the deployed layer).
// This is the equivalent for a build out of `wasm-build/`, so a new artifact can actually be run.
//
//   node wasm-build/pack-core-layer.mjs <olean-tree> <output-dir> [module-prefix]
//
//   node wasm-build/pack-core-layer.mjs wasm-build/out/variant-2/olean <mirror>/lean-wasm Init
//
// The format is the one the worker reads: a manifest listing packs, where each pack is the **gzip of its
// entries concatenated** and each entry carries its offset and length within the uncompressed container.
// Entries are written as `.olean` + `.ir` + `.ir.sig` — the `.ir` carries the compiled bodies the
// interpreter needs for `#eval` of library code, which is why a trim to `.olean` alone loses that.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const [tree, outDir, prefix = 'Init', packMb = '16'] = process.argv.slice(2);
if (!tree || !outDir) {
	console.error('usage: node pack-core-layer.mjs <olean-tree> <output-dir> [module-prefix] [pack-MB]');
	process.exit(2);
}

const KEEP = ['.ir.sig', '.olean', '.ir'];
const PACK_BYTES = Number(packMb) * 1024 * 1024;

/** Every kept file under `tree`, relative to it, in a stable order. */
function collect(dir, rel = '') {
	const found = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		const path = rel ? `${rel}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			found.push(...collect(full, path));
			continue;
		}
		// Matched by whole suffix, longest first. Taking the last dot's suffix instead would read
		// `Foo.ir.sig` as `.sig` and silently drop it — and a module's `.ir` is only used when its
		// `.ir.sig` is present, so that loses `#eval` of library code while looking like a smaller layer.
		// `.olean.private` / `.olean.server` / `.ilean` / `.hash` / `.trace` are build side-products.
		if (!KEEP.some((suffix) => entry.name.endsWith(suffix))) continue;
		if (!path.startsWith(prefix)) continue;
		found.push({ path, full, bytes: statSync(full).size });
	}
	return found;
}

const files = collect(tree).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
if (files.length === 0) {
	console.error(`no .olean/.ir/.ir.sig files under ${tree} with prefix "${prefix}"`);
	process.exit(1);
}

const modules = new Set(files.map((file) => file.path.replace(/\.(olean|ir|ir\.sig)$/, '')));
console.log(`${files.length} files, ${modules.size} modules, ${(files.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1)} MB raw`);

const packs = [];
let current = { entries: [], chunks: [], bytes: 0 };

const flush = () => {
	if (current.entries.length === 0) return;
	const name = `artifacts-${String(packs.length).padStart(3, '0')}.pack`;
	const body = Buffer.concat(current.chunks);
	const gz = gzipSync(body, { level: 9 });
	mkdirSync(join(outDir, 'core-lib'), { recursive: true });
	writeFileSync(join(outDir, 'core-lib', name), gz);
	packs.push({ file: name, bytes: body.length, compressedBytes: gz.length, entries: current.entries });
	console.log(`  ${name}  ${(body.length / 1048576).toFixed(1)} MB raw -> ${(gz.length / 1048576).toFixed(2)} MB gzip, ${current.entries.length} entries`);
	current = { entries: [], chunks: [], bytes: 0 };
};

for (const file of files) {
	const body = readFileSync(file.full);
	current.entries.push({ path: file.path, offset: current.bytes, bytes: body.length });
	current.chunks.push(body);
	current.bytes += body.length;
	if (current.bytes >= PACK_BYTES) flush();
}
flush();

const manifest = {
	format: 'lean-core-layer',
	// The layer is only compatible with the binary built from the same tree (FINDINGS.md §5), so the
	// commit travels with it rather than being implied by a directory name.
	leanCommit: (() => {
		try {
			return readFileSync(join(tree, '..', 'LEAN_COMMIT'), 'utf8').trim();
		} catch {
			return null;
		}
	})(),
	prefix,
	modules: modules.size,
	files: files.length,
	packs: packs.map(({ file, bytes, compressedBytes, entries }) => ({ file, bytes, compressedBytes, entries }))
};

writeFileSync(join(outDir, 'core-layer.json'), JSON.stringify(manifest));
console.log(`core-layer.json written: ${modules.size} modules, ${packs.length} packs, ${(packs.reduce((n, p) => n + p.compressedBytes, 0) / 1048576).toFixed(1)} MB gzipped`);
