// The syntax probe: the one thing this package works around at runtime.
//
// `lean_wasm_compile` reports elaboration errors but **not parse errors** — its collection loop reads
// the command state's message log after `elabCommandAtFrontend`, which resets that log, so the
// parser's messages are wiped before it looks. That is a bug in the fork's Lean source
// (cauli/lean4, `src/Lean/Shell.lean`), and fixing it means rebuilding the wasm.
//
// So instead of trusting a silent run, this asks Lean's own parser — in a separate compile, because a
// file that fails to parse cannot be relied on to run anything appended to it. `Parser.parseCommand`
// is a pure function, so the probe needs no elaborator state beyond the environment.
//
// The probe needs `import Lean`, which the caller must have loaded; see SYNTAX_CHECK in compiler.js.

import { importLines } from './roots.js';

/** A Lean string literal for arbitrary source. JSON's own escaping is not Lean's, so do it by hand. */
export function leanStringLiteral(source) {
	const escaped = String(source)
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
		.replace(/\u2028|\u2029/g, ' ');
	return `"${escaped}"`;
}

/** The marker a probe uses to report a parse error, so a caller can tell its findings from noise. */
export const SYNTAX_ERROR_MARKER = /syntax error at line \d+, column \d+/;

/**
 * Build the probe: a Lean file that parses `code` and throws with the positions of any parse errors.
 *
 * The program's own `import` lines are carried over, because the parser needs the same environment —
 * parsing `ℝ` without Mathlib's notation would report a syntax error on a file the kernel accepts,
 * and a false positive is worse than the silence being fixed.
 */
export function syntaxProbeSource(code) {
	const imports = importLines(code);
	return `${imports ? imports + '\n' : ''}import Lean
open Lean

run_cmd do
  let src := ${leanStringLiteral(code)}
  let ictx := Parser.mkInputContext src "<your code>"
  let (_, ps, msgs) ← Parser.parseHeader ictx
  let pmctx : Parser.ParserModuleContext := { env := (← getEnv), options := (← getOptions) }
  let mut pstate := ps
  let mut log : MessageLog := msgs
  let mut done := false
  while !done do
    let (cmd, ps', log') := Parser.parseCommand ictx pmctx pstate log
    pstate := ps'
    log := log'
    done := Parser.isTerminalCommand cmd
  let errs := log.toList.filter (fun m => m.severity == MessageSeverity.error)
  if !errs.isEmpty then
    let mut out := ""
    for m in errs do
      out := out ++ s!"syntax error at line {m.pos.line}, column {m.pos.column}\\n"
    throwError "{out}"
`;
}
