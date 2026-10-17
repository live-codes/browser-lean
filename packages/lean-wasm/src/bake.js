// Bake an `Init` environment snapshot with the artifact's own binary.
//
// A snapshot carries the *imported* `Init` environment, so a first Run does not import it — and on the
// single-threaded build that import is the entire first-run cost, ~100 s against ~1.3 s for the pthread
// build (FINDINGS.md §9.7). Upstream's `Shell.lean` puts it plainly: a snapshot "skips the multi-minute
// `loadExts` import entirely".
//
// It has to be baked by the binary that will load it — a snapshot embeds closure relocations that are only
// valid against the saving binary's function table, so a native `lean` cannot produce one. That is why this
// runs the runtime **as the Lean CLI**, in a worker of its own: the CLI parses its own arguments, and
// `-sEXIT_RUNTIME=1` means it exits when it is done, so it cannot share a session with compiling.
//
// Run it once per artifact, serve the result at `<baseUrl>/snapshots/init.snap`, and the runtime picks it up
// by itself at boot (see `finishStartup` in `worker/lean-worker.js`).

import { resolveAssets } from './assets.js';
import { RUNTIME_WORKER_SOURCE } from './runtime-worker.js';

/**
 * @param {object} options
 * @param {string} options.baseUrl - where the artifact is served, as for `createCompiler`.
 * @param {string} [options.probe] - the file to elaborate. It must import nothing, so that the bake pays
 *   the default `Init` header import — exactly the cost the snapshot exists to skip. Default `#check 2+2`.
 * @param {(message: string) => void} [options.onProgress] - progress, for a spinner.
 * @param {number} [options.timeoutMs] - default 20 minutes, which is generous even for this build.
 * @returns {Promise<Uint8Array>} the snapshot's bytes, ready to write to disk.
 */
export async function bakeSnapshot({ baseUrl, probe = '#check 2+2', onProgress, timeoutMs = 1_200_000 } = {}) {
	const assets = resolveAssets(baseUrl);
	const config = {
		assetBase: assets.assetBase,
		libBase: assets.libBase,
		bake: { probe, snapshotPath: '/workspace/init.snap' }
	};

	const worker = new Worker(
		URL.createObjectURL(
			new Blob([`self.__LEAN_WASM_CONFIG__ = ${JSON.stringify(config)};\n${RUNTIME_WORKER_SOURCE}`], {
				type: 'text/javascript'
			})
		)
	);

	try {
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`the bake did not finish within ${Math.round(timeoutMs / 60000)} minutes`)),
				timeoutMs
			);

			worker.onmessage = (event) => {
				const message = event.data || {};

				if (message.type === 'snapshot') {
					clearTimeout(timer);
					// `bytes` was copied in the worker (`FS.readFile` answers a view into the wasm heap); this
					// is a second copy only because the message may be re-used by the caller.
					resolve(new Uint8Array(message.bytes));
					return;
				}
				if (message.type === 'error') {
					clearTimeout(timer);
					reject(new Error(message.data));
					return;
				}
				// Progress: the CLI's own output is voluminous, so only the coarse stages are forwarded.
				if (message.type === 'status' && message.data) onProgress?.(message.data);
				if (message.type === 'library' && message.stage === 'manifest') {
					onProgress?.(`core layer: ${message.modules} modules in ${message.packs} packs`);
				} else if (message.type === 'library' && message.stage === 'pack') {
					onProgress?.(`core pack ${message.loaded}/${message.total}`);
				}
			};
			worker.onerror = (event) => {
				clearTimeout(timer);
				reject(new Error(event.message || 'the bake worker failed'));
			};

			worker.postMessage({ type: 'start' });
		});
	} finally {
		worker.terminate();
	}
}
