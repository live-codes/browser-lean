// @live-codes/lean-wasm — run Lean 4 in the browser, on the real kernel.
//
//   import { createCompiler } from '@live-codes/lean-wasm';
//
//   const lean = await createCompiler({ baseUrl: 'https://cdn.example.com/lean/' });
//   const { output, errors, exitCode } = await lean.run('#eval 2 + 2');
//
// A classic worker cannot load an ES module, so there is also an IIFE build that sets
// `self.leanWasm` with the same API:
//
//   importScripts('https://cdn.example.com/lean-wasm.global.js');
//   const lean = await self.leanWasm.createCompiler({ baseUrl });

import { DEFAULT_BASE_URL, requiredAssetPaths, resolveAssets } from './assets.js';
import { createCompiler } from './compiler.js';
import { fetchableRoots, optionalLayers } from './roots.js';

/** Lean is one language here; the variable shape matches the other @live-codes language packages. */
export const LANGUAGES = ['lean'];

/** The accepted values of `syntaxCheck`. */
export const SYNTAX_MODES = ['auto', 'full', 'off'];

export { createCompiler, DEFAULT_BASE_URL, requiredAssetPaths, resolveAssets };

/** Every library root the package can fetch, which depends on the resolved asset directories. */
export function availableRoots(assets) {
	return fetchableRoots(assets ?? resolveAssets());
}

/** The packed layers (currently Mathlib) with their manifest URLs resolved. */
export function layers(assets) {
	return optionalLayers(assets ?? resolveAssets());
}
