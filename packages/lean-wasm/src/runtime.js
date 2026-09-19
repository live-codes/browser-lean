// The runtime worker: one long-lived Worker that boots the Lean runtime once and then compiles
// repeatedly, reusing the environment it has already imported.
//
// It has to be a Worker rather than the calling thread for two reasons: the Init import is a long
// synchronous stretch inside wasm, and a pthread build parks its thread pool on the thread that
// created it. LiveCodes runs language drivers inside its own sandbox worker, and a worker may create
// a nested one — but the script URL must be same-origin, so the runtime is handed over as a **blob**
// that is generated here.
//
// The worker's own source arrives as a string (see scripts/sync-worker.mjs, which generates it from
// `worker/lean-worker.js`), so there is one implementation and the demo in this repo consumes it too.

import { RUNTIME_WORKER_SOURCE } from './runtime-worker.js';

const COMPILE_PATH = '/workspace/input.lean';

function createWorkerSource(config) {
	// A blob URL carries no query string, so the config travels as a global the worker reads first.
	// The worker still accepts `?assetBase=`/`?libBase=`, which is what the demo uses.
	return `self.__LEAN_WASM_CONFIG__ = ${JSON.stringify(config)};\n${RUNTIME_WORKER_SOURCE}`;
}

export function createRuntime({ assetBase, libBase, onProgress, onStatus }) {
	let worker = null;
	let objectUrl = null;
	let stdout = '';
	let stderr = '';
	let nextId = 1;
	const waiters = [];

	const emit = (message) => {
		if (message) onProgress?.(message);
	};

	function dispatch(event) {
		const msg = event.data || {};

		switch (msg.type) {
			case 'stdout':
				stdout += msg.data + '\n';
				return;
			case 'stderr':
				stderr += msg.data + '\n';
				return;
			case 'status':
				onStatus?.(msg.data);
				return;
			case 'memory':
				return;
			case 'library':
				if (msg.stage === 'manifest') {
					emit(`core layer: ${msg.modules} modules in ${msg.packs} packs`);
				} else if (msg.stage === 'pack') {
					emit(`core pack ${msg.loaded}/${msg.total}`);
				} else if (msg.stage === 'written') {
					emit(`${msg.files} library files installed`);
				}
				return;
			case 'modules':
				if (msg.stage === 'progress') emit(`loading ${msg.root}: ${msg.files}/${msg.total} files`);
				return;
			case 'layer':
				if (msg.stage === 'progress') emit(`loading ${msg.label}: pack ${msg.pack}/${msg.packs}`);
				return;
			default:
				break;
		}

		for (const waiter of [...waiters]) {
			if (!waiter.match(msg)) continue;
			waiters.splice(waiters.indexOf(waiter), 1);
			clearTimeout(waiter.timer);
			waiter.resolve(msg);
		}

		if (msg.type === 'error') {
			failAll(new Error(msg.data));
		}
	}

	function failAll(error) {
		for (const waiter of waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
	}

	function waitFor(match, label, timeoutMs) {
		return new Promise((resolve, reject) => {
			const waiter = { match, resolve, reject, timer: null };
			waiter.timer = setTimeout(() => {
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
				reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`));
			}, timeoutMs);
			waiters.push(waiter);
		});
	}

	function post(message) {
		if (!worker) throw new Error('The Lean runtime is not running.');
		worker.postMessage(message);
	}

	async function start() {
		worker = new Worker(URL.createObjectURL(new Blob([createWorkerSource({ assetBase, libBase })], { type: 'text/javascript' })));
		worker.onmessage = dispatch;
		worker.onerror = (event) => failAll(new Error(event.message || 'Lean runtime error'));

		post({ type: 'start' });
		// The Init import is the long part, and it reports progress through the heartbeats the worker
		// forwards, so the timeout only has to be generous enough to notice a wedged boot.
		await waitFor((msg) => msg.type === 'ready', 'Starting the Lean runtime', 120_000);
	}

	async function loadModules(roots) {
		const id = nextId++;
		post({ type: 'load_modules', id, roots });
		const reply = await waitFor((msg) => msg.type === 'modules_loaded' && msg.id === id, `Loading ${roots.join(', ')}`, 300_000);
		return reply.results ?? [];
	}

	async function loadLayer(layer) {
		const id = nextId++;
		post({ type: 'load_layer', id, label: layer.label, manifestUrl: layer.manifestUrl, packBase: layer.packBase });
		const reply = await waitFor((msg) => msg.type === 'layer_loaded' && msg.label === layer.label, `Loading ${layer.label}`, 600_000);
		return reply;
	}

	async function compile(code) {
		const id = nextId++;
		stdout = '';
		stderr = '';
		post({ type: 'compile', id, code, path: COMPILE_PATH });
		const reply = await waitFor((msg) => msg.type === 'result' && msg.id === id, 'Compiling', 600_000);
		return { ...reply, stdout, stderr };
	}

	function dispose() {
		failAll(new Error('The compiler was disposed.'));
		worker?.terminate();
		worker = null;
		if (objectUrl) {
			URL.revokeObjectURL(objectUrl);
			objectUrl = null;
		}
	}

	return { start, loadModules, loadLayer, compile, dispose };
}
