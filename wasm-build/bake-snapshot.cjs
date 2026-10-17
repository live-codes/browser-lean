#!/usr/bin/env node
// Bake an `--incr-header-save` environment snapshot with the built artifact itself.
//
// This is the lever for the first-run cost: FINDINGS.md §9.7 eliminates five flag-level explanations and
// lands on the realization itself, and a snapshot takes that realization out of the first Run rather than
// making it cheaper. Upstream ships `snapshots/init.snap` and bakes it with
// `scripts/bake-snapshots.sh` + `scripts/lean-wasm-node.cjs` (Apache-2.0); this is that driver, adapted to
// this harness's layout and to a **single-threaded** artifact.
//
// The snapshot embeds closure relocations that are only valid against the saving binary's function table,
// which is why it must be baked by the same `lean.js`/`lean.wasm` that will load it — running the wasm
// build under Node rather than any native Lean.
//
//   node wasm-build/bake-snapshot.cjs <out-dir> <work-dir> [name] [probe]
//
//   <out-dir>   e.g. `wasm-build/out/variant-2`: `lean.js`, `lean.wasm` and `olean/` (this build's tree)
//   <work-dir>  real directory mounted at `/work`, where `<name>.snap` is written
//   [name]      snapshot name, default `init`
//   [probe]     the file to elaborate, default `#check 2+2` — no imports, so it pays the default `Init`
//               header import, which is exactly the cost the snapshot exists to skip
//
// Expect ~2 minutes: the bake performs the import once. The process may exit itself (`-sEXIT_RUNTIME=1`),
// so the caller checks for the file rather than relying on anything after the run.
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const [outDir, workDir, name = 'init', probe = '#check 2+2'] = process.argv.slice(2);
if (!outDir || !workDir) {
	console.error('usage: bake-snapshot.cjs <out-dir> <work-dir> [name] [probe]');
	process.exit(2);
}

const leanJs = path.resolve(outDir, 'lean.js');
// The library tree defaults to `<out-dir>/olean`, but `BAKE_LIB_ROOT` overrides it — which is how a
// *pthread* artifact is tested against the single-threaded build's oleans without copying 2.2 GB. (NODEFS
// will not mount a Windows **junction** as its root: it answers ENOENT for everything, which is why the
// override exists rather than a symlink.)
const libLean = path.resolve(process.env.BAKE_LIB_ROOT ?? path.join(outDir, 'olean'));
const realWork = path.resolve(workDir);
if (!fs.existsSync(leanJs)) throw new Error(`${leanJs} not found`);
if (!fs.existsSync(libLean)) throw new Error(`${libLean} not found — the library tree was not copied out (drop SKIP_OLEAN_COPY)`);
fs.mkdirSync(realWork, { recursive: true });
fs.writeFileSync(path.join(realWork, 'probe.lean'), `${probe}\n`);
console.log(`baking ${name}.snap from "${probe}" into ${realWork} …`);

// The glue chdirs the virtual FS to process.cwd() during startup and only `/` is guaranteed to exist
// there, so step off the real cwd before it does.
process.chdir('/');
// Emscripten forwards process.argv[1] as argv[0]; present the virtual install layout so Lean derives
// `/lib/lean` as its sysroot instead of stat-ing a host path inside MEMFS.
process.argv[1] = '/bin/lean';

const memoryMb = process.env.BAKE_MEMORY_MB ? Number(process.env.BAKE_MEMORY_MB) : null;

globalThis.Module = {
	arguments: [`--incr-header-save=/work/${name}.snap`, '/work/probe.lean'],
	// No `wasmMemory`/`INITIAL_MEMORY` for this artifact: it **defines** its memory (a `-sMAIN_MODULE=2`
	// module with no pthreads), so there is nothing for the embedder to construct — unlike upstream's
	// pthread build, whose driver hands over a shared buffer. `BAKE_MEMORY_MB` supplies one for testing a
	// pthread artifact through this same driver, which is how we tell "CLI under Node does not work" apart
	// from "this build's CLI does not work".
	...(memoryMb === null ? {} : {
		wasmMemory: new WebAssembly.Memory({ initial: (memoryMb * 1024 * 1024) / 65536, maximum: 65536, shared: true }),
		INITIAL_MEMORY: memoryMb * 1024 * 1024
	}),
	// Only a pthread build needs this — its thread pool loads the script in sub-workers, and a worker
	// script must be a URL or a path the runtime can load. A single-threaded artifact ignores the key.
	mainScriptUrlOrBlob: leanJs,
	locateFile: (file) => path.join(path.dirname(leanJs), file),
	preRun: [function () {
		const FS = Module.FS;
		const NODEFS = FS.filesystems.NODEFS;
		const mkdirTree = (p) => {
			let current = '';
			for (const part of p.split('/').filter(Boolean)) {
				current += '/' + part;
				try { FS.mkdir(current); } catch { /* exists */ }
			}
		};
		for (const dir of ['/lib/lean', '/work', '/bin']) mkdirTree(dir);
		// `/bin/lean` is a *virtual* path — the argv[0] trick above makes Lean derive `/lib/lean` as its
		// sysroot — but the file itself does not exist unless we put it there, and the CLI stats its own
		// executable. A placeholder is enough for the stat; nothing reads it.
		try { FS.writeFile('/bin/lean', 'wasm-build: virtual argv[0]; see bake-snapshot.cjs\n'); } catch { /* exists */ }
		FS.mount(NODEFS, { root: libLean }, '/lib/lean');
		FS.mount(NODEFS, { root: realWork }, '/work');
		Module.ENV.LEAN_PATH = '/lib/lean';
		FS.chdir('/work');
		// Name the failing FS operation. An `ErrnoError` here carries no path, so this is the only way to
		// learn *what* was not found — and with NODEFS against a 32k-file tree, guessing is hopeless.
		for (const op of ['open', 'stat', 'lstat', 'readdir', 'readFile', 'writeFile', 'mkdir', 'unlink', 'rename', 'chmod', 'chown', 'access', 'truncate', 'readlink', 'symlink']) {
			const original = FS[op];
			if (typeof original !== 'function') continue;
			FS[op] = function (...args) {
				try {
					return original.apply(FS, args);
				} catch (error) {
					console.error(`bake: FS.${op}(${JSON.stringify(args[0])}${args.length > 1 ? ', …' : ''}) failed, errno=${error && error.errno}`);
					throw error;
				}
			};
		}

		// Report the mounts: an Emscripten FS failure surfaces as `errno=44` (ENOENT) with no path at all,
		// so the first thing worth knowing when this bake breaks is what Lean can actually see.
		{
			const list = (p) => { try { return FS.readdir(p).slice(0, 6).join(', '); } catch (e) { return 'ERR errno=' + e.errno; } };
			const size = (p) => { try { return FS.stat(p).size; } catch (e) { return 'ERR errno=' + e.errno; } };
			console.error('bake: /lib/lean ->', list('/lib/lean'));
			console.error('bake: /lib/lean/Init.olean size =', size('/lib/lean/Init.olean'));
			console.error('bake: /work ->', list('/work'), '| probe size =', size('/work/probe.lean'));
		}
	}],
	onExit: (code) => { process.exitCode = code; },
	onAbort: (what) => { console.error('ABORT:', what); process.exit(3); },
};

// Script-scope shims for the CJS facilities the glue expects.
globalThis.require = require;
globalThis.__filename = '/bin/lean.js';
globalThis.__dirname = '/bin';

// Node prints an Emscripten `ErrnoError` as a bare `#<ErrnoError>`, which says nothing about which path
// failed. Surface the errno and the path, since an FS problem is the likeliest way this bake breaks.
process.on('unhandledRejection', (reason) => {
	const detail = reason && typeof reason === 'object'
		? `errno=${reason.errno} code=${reason.code ?? ''} path=${reason.path ?? reason.filename ?? ''} message=${reason.message ?? ''}`
		: String(reason);
	console.error('unhandled rejection:', detail);
	if (reason && reason.stack) console.error(reason.stack.split('\n').slice(0, 6).join('\n'));
	process.exit(4);
});

// `vm.runInThisContext`, not `require`: the glue's top-level `var Module` would otherwise be scoped to the
// CommonJS wrapper and shadow the config object above. `importScripts` in a worker evaluates at global
// scope, which is why the same pattern works there.
vm.runInThisContext(fs.readFileSync(leanJs, 'utf8'), { filename: leanJs });
