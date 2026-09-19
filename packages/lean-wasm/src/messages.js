// Turning the runtime's two streams into the three things a caller wants: the program's output, the
// diagnostics, and an exit code.
//
// The runtime reports *every* message — `#eval` and `#check` results included — as one JSON object per
// line on **stdout**, and its own tracing on stderr. So neither stream is "the output" and the split
// has to be by severity. See FINDINGS.md §3.

/** Lines the wasm build emits about itself rather than about the program. Matched narrowly by hand. */
export function isToolchainNoise(line) {
	return (
		line.startsWith('[DEBUG:') ||
		line.startsWith('mainModule? =') ||
		line.startsWith('- /lib/lean/') ||
		line.startsWith('wasm streaming compile failed:') ||
		line === 'falling back to ArrayBuffer instantiation'
	);
}

export function messageText(msg) {
	const data = msg.data;
	if (typeof data === 'string') return data;
	if (data && typeof data === 'object') return data.msg ?? data.message ?? JSON.stringify(data);
	return String(data ?? '');
}

/**
 * Split both streams into the program's output and the compiler's diagnostics.
 *
 * JSON messages are classified by their own `severity`; anything else falls back to the stream it
 * arrived on, which is what a plain-text runtime would need.
 *
 * @returns {{info: {severity: string, text: string, pos: object|null}[],
 *   problems: {severity: string, text: string, pos: object|null}[], noise: number}}
 */
export function collect(stdout, stderr) {
	const info = [];
	const problems = [];
	let noise = 0;

	for (const [stream, text] of [
		['stdout', stdout],
		['stderr', stderr]
	]) {
		for (const raw of (text ?? '').split('\n')) {
			const line = raw.trim();
			if (!line) continue;
			if (isToolchainNoise(line)) {
				noise += 1;
				continue;
			}

			let msg = null;
			if (line.startsWith('{')) {
				try {
					msg = JSON.parse(line);
				} catch {
					msg = null;
				}
			}

			if (msg && typeof msg === 'object' && msg.severity) {
				const entry = { severity: msg.severity, text: messageText(msg), pos: msg.pos ?? null };
				(msg.severity === 'information' ? info : problems).push(entry);
			} else {
				const entry = {
					severity: stream === 'stdout' ? 'output' : 'error',
					text: line,
					pos: null
				};
				(stream === 'stdout' ? info : problems).push(entry);
			}
		}
	}

	return { info, problems, noise };
}

/**
 * One line per diagnostic, stripping the ANSI escapes the build colours its messages with.
 * A message that already carries a position keeps its own.
 */
export function problemsToLines(problems) {
	const ownsPosition = /\(line \d+, col \d+\)|at line \d+, column \d+/;
	return problems.map(({ severity, text, pos }) => {
		const body = String(text).replace(/\u001b\[[0-9;]*m/g, '');
		const where =
			pos?.line != null && !ownsPosition.test(body)
				? `  (line ${pos.line}${pos.column != null ? `, col ${pos.column}` : ''})`
				: '';
		return severity === 'output' ? body : `${severity}: ${body}${where}`;
	});
}

/** The same, joined for a single pane. */
export function formatProblems(problems) {
	return problemsToLines(problems).join('\n');
}
