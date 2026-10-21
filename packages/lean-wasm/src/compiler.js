// The package's API: one compiler for Lean, driving the runtime worker.
//
// The library resolution here is the interesting part. Lean names only the **first** missing module
// prefix per compile (its frontend aborts with an uncaught exception), so a program needing several
// libraries takes one round each. Rounds are bounded by progress rather than by a count — a program
// with ten imports costs one load phase, not ten — and `auto` syntax checking means nothing pays for
// the Lean library just to be told about a typo.

import { probeArtifactMemory } from './artifact-probe.js';
import { resolveAssets } from './assets.js';
import { collect, problemsToLines } from './messages.js';
import {
	OPTIONAL_LIBRARIES,
	importedRoots,
	missingRoots,
	optionalLayers,
	outsideClosureNotes,
	unavailableImportNotes
} from './roots.js';
import { createRuntime } from './runtime.js';
import { SYNTAX_ERROR_MARKER, syntaxProbeSource } from './syntax-probe.js';

/** Backstop against an asset host that never satisfies an import. */
const MAX_LOAD_ROUNDS = 8;

const SYNTAX_MODES = ['auto', 'full', 'off'];

function assertEnvironment() {
	if (typeof Worker !== 'function' || typeof Blob !== 'function') {
		throw new Error(
			'@live-codes/lean-wasm runs in a browser: the Lean runtime is a Web Worker, and it is handed ' +
				'over as a blob so that it stays same-origin.'
		);
	}
}

/**
 * Whether this document can have the shared memory the runtime needs.
 *
 * This asks the engine to *do* the thing rather than inspecting `SharedArrayBuffer`, and that is a
 * correction: FINDINGS.md §2 concluded that a shared memory implies cross-origin isolation because the
 * `SharedArrayBuffer` constructor is only exposed to an isolated document. Measured in Chrome 155, that
 * implication no longer holds for **wasm** memories — in a document with `crossOriginIsolated: false` and
 * `typeof SharedArrayBuffer === 'undefined'`, `new SharedArrayBuffer(8)` throws a `ReferenceError` while
 * `new WebAssembly.Memory({initial: 1, maximum: 2, shared: true})` succeeds and returns a 65536-byte
 * buffer. The runtime constructs a shared memory, so that is the operation to probe, and on this engine
 * the pthread build boots without any isolation at all.
 *
 * @returns {boolean}
 */
function canHaveSharedMemory() {
	try {
		new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether this document can boot this artifact.
 *
 * The requirement belongs to the artifact rather than to the package. A `shared` memory import needs a
 * shared WebAssembly memory; an unshared one needs nothing at all (FINDINGS.md §9). Checking the
 * declaration is what lets one build of this package serve both, and checking the *capability* rather
 * than the constructor is what keeps the pthread build working on an engine that has relaxed the rule.
 *
 * An unreadable artifact is deliberately *not* treated as a shared one. A failed probe means the host
 * does not answer the way the boot expects, and the boot will fail with its own explanation a moment
 * later; refusing to start on that basis would block a single-threaded build for a reason that has
 * nothing to do with it.
 *
 * @param {null|{mode: string, url: string}} artifact - the probe's result.
 */
function assertArtifactCanRun(artifact) {
	if (artifact?.mode !== 'shared') return;
	if (canHaveSharedMemory()) return;

	throw new Error(
		`The Lean artifact at ${artifact.url} declares a shared WebAssembly memory, and this browser will ` +
			'not construct one here. Serve the page with `Cross-Origin-Opener-Policy: same-origin` and ' +
			'`Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`); an embed that cannot set ' +
			'those headers can isolate its own frame with `Document-Isolation-Policy: isolate-and-require-corp` ' +
			'instead. A single-threaded Lean build would need none of this — see FINDINGS.md §2 and §9.'
	);
}

/** The artifact's memory, in words, for a progress log. */
function describeMemory(artifact) {
	if (!artifact) {
		return 'artifact: the memory import could not be read, so a shared memory is assumed';
	}
	const { initial, maximum } = artifact.memory;
	const limits = `min ${initial} pages, ${maximum === null ? 'no maximum' : `max ${maximum} pages`}`;
	return artifact.mode === 'unshared'
		? `artifact: unshared memory (${limits}) — no cross-origin isolation needed`
		: `artifact: shared memory (${limits}) — this needs SharedArrayBuffer`;
}

/**
 * Create a Lean compiler.
 *
 * @param {object} options
 * @param {string} options.baseUrl - where the mirrored `lean-wasm/`, `lean-lib/` and `lean-mathlib/`
 *   directories are served from. Required unless this build sets `DEFAULT_BASE_URL`.
 * @param {'auto'|'full'|'off'} [options.syntaxCheck] - how hard to look for syntax errors the runtime
 *   swallows (it reports elaboration errors but not parse errors; see FINDINGS.md §6.1).
 *   `auto` (default) parses the source only once the Lean library is loaded, so the check is free;
 *   `full` always parses, loading Lean and Std if needed (~350 MiB); `off` never parses.
 * @param {(message: string) => void} [options.onProgress] - human-readable progress, for a spinner.
 * @param {(message: string) => void} [options.onStatus] - the wasm build's own status lines.
 * @param {(artifact: object) => void} [options.onArtifact] - called once the artifact's memory mode is
 *   known, before the boot and before the cross-origin-isolation gate — so a caller can report what the
 *   artifact needs even when it is what stops the boot. Same shape as the returned `artifact`.
 * @returns {Promise<{language: string, assets: object, artifact: object, run: Function, dispose: Function}>}
 */
export async function createCompiler(options = {}) {
	assertEnvironment();

	const assets = resolveAssets(options.baseUrl);
	const syntaxCheck = options.syntaxCheck ?? 'auto';
	if (!SYNTAX_MODES.includes(syntaxCheck)) {
		throw new Error(`syntaxCheck must be one of ${SYNTAX_MODES.join(', ')}, not ${syntaxCheck}`);
	}

	const layers = optionalLayers(assets);

	// What the artifact declares, read from the first ~64 KiB of it rather than the whole 96.17 MiB, so a
	// document that cannot run the runtime finds that out before paying for the runtime (FINDINGS.md §2).
	const artifact = await probeArtifactMemory(assets.assetBase);
	const description = {
		memory: artifact?.mode ?? 'unknown',
		limits: artifact?.memory ?? null,
		url: artifact?.url ?? null
	};
	// Reported before the gate rather than with the result, because it is known before the gate and it is
	// the thing the gate is about — a caller showing it should not have to wait for a successful boot to
	// learn what an unsuccessful one was missing.
	options.onArtifact?.(description);
	assertArtifactCanRun(artifact);
	options.onProgress?.(describeMemory(artifact));

	// The worker needs the decision, not just the limits: `mode` is what tells it whether it has to
	// construct the memory at all. Passing the raw descriptor instead leaves `mode` undefined, which reads
	// as "threaded" and had the worker build a 2 GB *shared* memory — and point `mainScriptUrlOrBlob` at a
	// cross-origin script — for an artifact that defines its own unshared memory.
	const declared = artifact ? { mode: artifact.mode, ...artifact.memory } : null;

	const runtime = createRuntime({
		assetBase: assets.assetBase,
		libBase: assets.libBase,
		memory: declared,
		onProgress: options.onProgress,
		onStatus: options.onStatus
	});

	// What the worker has installed. These outlive a run, because the worker's filesystem does — which
	// is what makes `auto` syntax checking free after the first `import Lean`.
	const loadedRoots = new Set();
	const loadedLayers = new Set();

	await runtime.start();

	/** Record one library fetch, and remember what could not be supplied. */
	function noteLoadResult(entry, state) {
		if (entry.files > 0) {
			loadedRoots.add(entry.root);
			state.loaded.push(`${entry.root} (${entry.files} files${entry.failed ? `, ${entry.failed} failed` : ''})`);
			return;
		}
		if (entry.alreadyLoaded) {
			loadedRoots.add(entry.root);
			return;
		}
		if (!state.notMirrored.includes(entry.root)) state.notMirrored.push(entry.root);
	}

	/**
	 * Make `roots` resolvable, by whichever transport each one needs: a packed layer (Mathlib) or the
	 * per-file library tree (Std, Lean, Batteries). Resolves to whether anything was installed, which
	 * is what decides whether a recompile is worth doing.
	 */
	async function ensureRoots(roots, state) {
		const wanted = roots.filter((root) => !state.attempted.has(root));
		if (wanted.length === 0) return false;
		wanted.forEach((root) => state.attempted.add(root));

		let progress = false;

		for (const layer of layers) {
			if (!wanted.some((root) => layer.roots.includes(root))) continue;
			if (state.layers.has(layer.label)) continue;
			state.layers.add(layer.label);

			const result = await runtime.loadLayer(layer);
			if (result.ok) {
				loadedLayers.add(layer.label);
				if (!result.alreadyLoaded) {
					state.loaded.push(`${layer.label} layer (${result.files} files)`);
					progress = true;
				}
			} else {
				if (!state.notMirrored.includes(layer.label)) state.notMirrored.push(layer.label);
			}
		}

		const perFile = wanted.filter((root) => OPTIONAL_LIBRARIES.includes(root));
		if (perFile.length > 0) {
			for (const entry of await runtime.loadModules(perFile)) {
				noteLoadResult(entry, state);
				if (entry.files > 0) progress = true;
			}
		}

		return progress;
	}

	/** Compile, loading whatever the compiler says is missing, until it settles. */
	async function compileWithLibraries(code, state) {
		await ensureRoots(importedRoots(code), state);

		let result = await runtime.compile(code);
		for (let round = 0; round < MAX_LOAD_ROUNDS; round++) {
			const { problems } = collect(result.stdout, result.stderr);
			if (!(await ensureRoots(missingRoots(problems), state))) break;
			result = await runtime.compile(code);
		}
		return result;
	}

	/** Ask Lean's own parser about the source, for the parse errors the runtime drops. */
	async function findSyntaxErrors(code, state) {
		const probe = await compileWithLibraries(syntaxProbeSource(code), state);
		const { problems } = collect(probe.stdout, probe.stderr);
		return problems.filter((problem) => SYNTAX_ERROR_MARKER.test(problem.text));
	}

	return {
		language: 'lean',

		/** The resolved asset directories, for a caller that wants to log or pin them. */
		assets,

		/**
		 * What the artifact declares about its memory, which is the thing that decides whether this page
		 * needs cross-origin isolation: `memory` is `'shared'`, `'unshared'`, or `'unknown'` when the probe
		 * could not read it, and `limits` is the import's page bounds (FINDINGS.md §2 and §9).
		 */
		artifact: description,

		/**
		 * Compile and check a program.
		 *
		 * @param {string} code - the Lean source.
		 * @param {string} [input] - accepted for API symmetry with other language packages and
		 *   **ignored**: this runtime has no stdin (`Stdout`/`Stdin` are not wired into the wasm build).
		 * @param {object} [runOptions] - per-run overrides: `syntaxCheck`.
		 * @returns {Promise<{output: string, errors: string[], exitCode: number, noise: number,
		 *   libraries: string[], compileMs: number}>}
		 *   `output` is the program's own messages (`#eval` and `#check` results). `errors` holds the
		 *   diagnostics, one per line, and is empty when the kernel accepted everything.
		 */
		async run(code, input, runOptions = {}) {
			if (typeof code !== 'string') {
				throw new Error('run() needs the program source as its first argument.');
			}

			const mode = runOptions.syntaxCheck ?? syntaxCheck;
			const state = { attempted: new Set(), layers: new Set(), loaded: [], notMirrored: [] };
			const started = performance.now();

			const result = await compileWithLibraries(code, state);
			const { info, problems, noise } = collect(result.stdout, result.stderr);

			// A clean run is the one that cannot be trusted — the runtime says nothing whether the file
			// elaborated or merely failed to parse — so that is when the parser is asked.
			if (mode !== 'off' && code.trim() !== '' && !problems.some((p) => p.severity === 'error')) {
				const leanReady = loadedRoots.has('Lean') || loadedLayers.size > 0;
				if (mode === 'full' || leanReady) {
					problems.push(...(await findSyntaxErrors(code, state)));
				}
			}

			const hasErrors = problems.some((p) => p.severity === 'error') || result.success === false;

			const notes = hasErrors
				? [
						...unavailableImportNotes(code, state.notMirrored, assets, runtime.build),
						...outsideClosureNotes(problems)
					]
				: [];

			return {
				output: info.map((entry) => entry.text).join('\n'),
				errors: [...problemsToLines(problems), ...notes.map((note) => `note: ${note}`)],
				exitCode: hasErrors ? 1 : 0,
				noise,
				libraries: state.loaded,
				compileMs: Math.round(performance.now() - started)
			};
		},

		/** Terminate the runtime worker. Further runs throw. */
		dispose() {
			runtime.dispose();
		}
	};
}
