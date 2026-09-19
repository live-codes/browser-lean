// Where the runtime's assets come from.
//
// Unlike @live-codes/clang-wasm this package ships **no assets**, and that is a constraint rather than
// a choice: Lean's WebAssembly module is 96.2 MiB in a single file, and jsDelivr refuses files over
// 20 MB, so it can never travel inside an npm tarball. The library data is worse — 377 MiB of
// per-file `.olean`/`.ir` plus a 316 MiB Mathlib layer.
//
// So everything is addressed by `baseUrl`, which must point at a directory holding the three
// sibling directories this project mirrors:
//
//   <baseUrl>/lean-wasm/     lean.js, lean.wasm, core-layer.json and the 5 core packs
//   <baseUrl>/lean-lib/      lean-lib-files.json and the per-file libraries (Std, Lean, Batteries)
//   <baseUrl>/lean-mathlib/  real-analysis-layer.json and the Mathlib layer packs
//
// `npx --package @live-codes/lean-wasm lean-wasm-fetch-assets <dir>` materialises all three.
//
// The host must send `Access-Control-Allow-Origin` **and**
// `Cross-Origin-Resource-Policy: cross-origin`: the wasm and the packs are fetched, while `lean.js`
// is pulled in by `importScripts`, which COEP checks against CORP rather than CORS.

/**
 * Fill this in to give the package a default host. Left undefined, `baseUrl` is required.
 * @type {string|undefined}
 */
export const DEFAULT_BASE_URL = undefined;

const DIRECTORY = {
	wasm: 'lean-wasm',
	lib: 'lean-lib',
	mathlib: 'lean-mathlib'
};

function toAbsolute(value, label) {
	let url;
	try {
		url = new URL(value, globalThis.location?.href);
	} catch {
		throw new Error(`${label} must be an absolute http(s) URL, or relative to the page: ${value}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`${label} must be http or https, not ${url.protocol}//`);
	}
	return url;
}

/**
 * Work out the three asset directories from one base URL.
 *
 * @param {string} [baseUrl] - where the mirrored directories are served from. May be relative to the
 *   page. Required unless this module has a `DEFAULT_BASE_URL`.
 * @returns {{baseUrl: string, assetBase: string, libBase: string, layerBase: string}}
 */
export function resolveAssets(baseUrl) {
	const value = baseUrl ?? DEFAULT_BASE_URL;
	if (value == null || value === '') {
		throw new Error(
			'baseUrl is required: this package ships no assets (Lean’s wasm is 96.2 MiB, past the 20 MB ' +
				'per-file limit on jsDelivr), so the runtime is fetched from a host you control. Run ' +
				'`npx --package @live-codes/lean-wasm lean-wasm-fetch-assets <dir>` to materialise them, ' +
				'then pass that directory as baseUrl.'
		);
	}

	const root = toAbsolute(value, 'baseUrl').href.replace(/\/+$/, '');
	const join = (name) => `${root}/${name}`;

	return {
		baseUrl: `${root}/`,
		assetBase: join(DIRECTORY.wasm),
		libBase: join(DIRECTORY.lib),
		layerBase: join(DIRECTORY.mathlib)
	};
}

/** The paths an asset host must serve, for a listing or a copy script. */
export function requiredAssetPaths() {
	return [
		`${DIRECTORY.wasm}/lean.js`,
		`${DIRECTORY.wasm}/lean.wasm`,
		`${DIRECTORY.wasm}/core-layer.json`,
		`${DIRECTORY.wasm}/core-lib/artifacts-*.pack`,
		`${DIRECTORY.lib}/lean-lib-files.json`,
		`${DIRECTORY.lib}/**`,
		`${DIRECTORY.mathlib}/real-analysis-layer.json`,
		`${DIRECTORY.mathlib}/artifacts-*.pack`
	];
}
