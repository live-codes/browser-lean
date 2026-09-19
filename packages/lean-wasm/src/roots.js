// Which libraries a program needs, and what to say when one cannot be supplied.
//
// The runtime ships Mathlib only as a packed layer, and Std/Lean/Batteries as individual files, so
// there are two transports. Neither list is hardcoded to a specific host: both take the resolved
// asset directories.

/** Roots fetched one file at a time from `<libBase>`. */
export const OPTIONAL_LIBRARIES = ['Std', 'Lean', 'Batteries'];

/** Packed layers, each answering for a set of roots. */
export function optionalLayers(assets) {
	return [
		{
			label: 'Mathlib',
			manifestUrl: `${assets.layerBase}/real-analysis-layer.json`,
			packBase: assets.layerBase,
			roots: [
				'Mathlib',
				'Aesop',
				'Qq',
				'Plausible',
				'ProofWidgets',
				'ImportGraph',
				'LeanSearchClient',
				'Game'
			]
		}
	];
}

/** Roots that can never be supplied here, with the reason. */
export const UNAVAILABLE_LIBRARIES = {
	Lake: 'Lake is a build tool, and there is no build step here.'
};

/** Strip comments so a commented-out import does not count as one. */
export function stripComments(code) {
	return code.replace(/\/-[\s\S]*?-\//g, '').replace(/--[^\n]*/g, '');
}

/** The distinct top-level roots a program imports, in order. */
export function importedRoots(code) {
	const roots = [];
	for (const line of stripComments(code).split('\n')) {
		const match = /^\s*import\s+([A-Za-z0-9_'.]+)/.exec(line);
		if (!match) continue;
		const root = match[1].replace(/^'/, '').split('.')[0];
		if (root && !roots.includes(root)) roots.push(root);
	}
	return roots;
}

/** The program's `import` lines, verbatim — the syntax probe shares the program's environment. */
export function importLines(code) {
	return stripComments(code)
		.split('\n')
		.filter((line) => /^\s*import\s+\S/.test(line))
		.map((line) => line.trim())
		.join('\n');
}

/** Roots named by the compiler's "unknown module prefix 'X'" diagnostics. */
export function missingRoots(problems) {
	const roots = [];
	for (const problem of problems) {
		const match = /unknown module prefix '([^']+)'/.exec(problem.text);
		if (match && !roots.includes(match[1])) roots.push(match[1]);
	}
	return roots;
}

/** Which roots the package can fetch, for a caller that wants to check before running. */
export function fetchableRoots(assets) {
	return [...OPTIONAL_LIBRARIES, ...optionalLayers(assets).flatMap((layer) => layer.roots)];
}

function assetCommandFor(root, assets) {
	if (OPTIONAL_LIBRARIES.includes(root)) return 'lean-wasm-fetch-assets';
	if (optionalLayers(assets).some((layer) => layer.roots.includes(root))) {
		return 'lean-wasm-fetch-assets';
	}
	return null;
}

/**
 * Explain an unavailable import rather than leaving the compiler's bare "unknown module prefix",
 * which reads like a typo instead of a limit of this playground.
 */
export function unavailableImportNotes(code, notMirrored, assets) {
	const notes = [];
	const add = (note) => {
		if (!notes.includes(note)) notes.push(note);
	};
	for (const root of importedRoots(code)) {
		if (notMirrored.includes(root)) {
			const command = assetCommandFor(root, assets);
			add(
				command
					? `${root} is not on the asset host. Mirror it with \`${command}\`.`
					: `${root} is not available here.`
			);
		} else if (UNAVAILABLE_LIBRARIES[root]) {
			add(UNAVAILABLE_LIBRARIES[root]);
		}
	}
	return notes;
}

/**
 * A Mathlib module outside the published closure fails by path rather than by prefix, because
 * "Mathlib" itself resolves. Worth explaining: the layer is a 4,303-module closure, not Mathlib.
 */
export function outsideClosureNotes(problems) {
	const notes = [];
	for (const problem of problems) {
		const match = /object file '[^']*' of module (\S+)/.exec(problem.text);
		if (!match) continue;
		const note =
			`${match[1]} is not in the published Mathlib closure. Upstream ships only the 4,303 modules ` +
			'its Real Analysis course needs, so some of Mathlib is available here and some is not.';
		if (!notes.includes(note)) notes.push(note);
	}
	return notes;
}
