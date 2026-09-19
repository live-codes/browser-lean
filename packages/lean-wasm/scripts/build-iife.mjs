// Builds the IIFE bundle: one classic script, for workers and pages that cannot use ES modules.
//
//   npm run build:iife
//
// The output is committed, because a classic worker can only `importScripts()` a URL and consumers
// should not need a bundler to get one. Unlike @live-codes/clang-wasm this package has no Node entry
// and ships no assets, so there is a single bundle rather than two.
import { build } from 'esbuild';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const outfile = fileURLToPath(new URL('../dist/lean-wasm.global.js', import.meta.url));

await build({
	entryPoints: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
	outfile,
	bundle: true,
	format: 'iife',
	globalName: 'leanWasm',
	minify: true,
	platform: 'browser',
	target: 'es2022',
	legalComments: 'external',
	banner: {
		js: `/*! @live-codes/lean-wasm - MIT. IIFE build, sets self.leanWasm.
 *  importScripts('lean-wasm.global.js') then self.leanWasm.createCompiler({ baseUrl }).
 *  Runs Lean 4 (Apache-2.0) compiled to WebAssembly by cauli/lean4-wasm-in-browser (Apache-2.0);
 *  no third-party JavaScript is bundled. */`
	}
});

console.log(`dist/lean-wasm.global.js  ${(statSync(outfile).size / 1024).toFixed(1)} KB (minified)`);
