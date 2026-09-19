/**
 * Driver for the demo page.
 *
 * The compiler is not implemented here: it is `@live-codes/lean-wasm`, the package in
 * `packages/lean-wasm`. `index.html` loads its IIFE build from `./vendor/`, vendored by
 * `npm run sync:vendor`, which is the artifact a host and a worker both have to consume — files, not
 * routes, since a static host cannot reach `packages/`. So this file is only the page — examples,
 * panes, keyboard, and the state a headless probe reads — and the demo exercises exactly the artifact
 * a consumer installs rather than a copy of it.
 *
 * `?baseUrl=` points at the directory holding `lean-wasm/`, `lean-lib/` and `lean-mathlib/`; the
 * default is this origin's root, which is what `npm start` serves.
 */

const { createCompiler } = globalThis.leanWasm;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const els = {
  banner: $('banner'),
  isolation: $('isolation'),
  payload: $('payload'),
  examples: $('examples'),
  run: $('run'),
  clear: $('clear'),
  editor: $('editor'),
  status: $('status'),
  output: $('output'),
  diagnostics: $('diagnostics'),
  log: $('log'),
};

// Element ids as globals, so headless probes can drive the page without string literals.
Object.assign(window, els);
window.params = params;

const EXAMPLES = [
  {
    name: 'Hello — eval, arithmetic, #check',
    code: `#eval "Hello from Lean!"
#eval 2 + 2
#eval 2 ^ 10
#check Nat.add_comm
`,
  },
  {
    name: 'A proof the kernel accepts',
    code: `theorem add_comm (a b : Nat) : a + b = b + a := by
  induction b with
  | zero => simp
  | succ d hd => rw [Nat.add_succ, Nat.succ_add, hd]

#check add_comm
`,
  },
  {
    name: 'A proof the kernel rejects',
    code: `theorem wrong : (1 : Nat) = 2 := by
  rfl

#check this_does_not_exist
`,
  },
  {
    name: 'Recursive definitions',
    code: `def fib : Nat -> Nat
  | 0 => 0
  | 1 => 1
  | n + 2 => fib (n + 1) + fib n

#eval fib 10
#eval fib 20
`,
  },
  {
    name: 'Library functions with #eval',
    code: `#eval (List.range 5).map (fun n => n * n)
#eval [1, 2, 3].foldl (· + ·) 0
#eval (String.join ["a", "b", "c"])
`,
  },
  {
    name: 'Std (loaded on demand)',
    code: `import Std.Data.HashMap

def counts (xs : List Nat) : Std.HashMap Nat Nat :=
  xs.foldl (fun m x => m.insert x ((m.getD x 0) + 1)) {}

#eval (counts [1, 2, 2, 3, 3, 3]).toList
`,
  },
  {
    name: 'Lean metaprogramming (loaded on demand)',
    code: `import Lean

open Lean

#eval (Name.mkSimple "hello").toString
#check Expr
`,
  },
  {
    name: 'Mathlib (loaded on demand)',
    code: `import Mathlib.Data.Real.Basic
import Mathlib.Tactic.Ring

theorem mine (x : ℝ) : x + 0 = x := by ring

#check mine
`,
  },
];

let compiler = null;
let starting = null;
let busy = false;

function setState(update) {
  const ds = document.documentElement.dataset;
  for (const [key, value] of Object.entries(update)) ds[key] = String(value);
}

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = kind;
}

function appendLog(line) {
  if (els.log.classList.contains('empty')) {
    els.log.textContent = '';
    els.log.classList.remove('empty');
  }
  els.log.textContent += (els.log.textContent ? '\n' : '') + line;
  // The scrolling element is the panes container; the <pre> itself never overflows.
  const panes = els.log.parentElement?.parentElement;
  if (panes) panes.scrollTop = panes.scrollHeight;
}

function setPane(el, text, emptyText) {
  const value = (text ?? '').trimEnd();
  if (!value) {
    el.textContent = emptyText;
    el.classList.add('empty');
    return;
  }
  el.textContent = value;
  el.classList.remove('empty');
}

// While a run is in flight the log is what is moving, so follow it; once the run settles, jump back to
// the top so the verdict and diagnostics are on screen.
function scrollToResults() {
  const panes = els.log.parentElement?.parentElement;
  if (panes) panes.scrollTop = 0;
}

function setBusy(value) {
  busy = value;
  els.run.disabled = value;
  els.run.textContent = value ? 'Running…' : 'Run';
}

/**
 * Boot the runtime once. The package owns the worker, the library loading and the message
 * classification; all this does is report progress and remember the compiler.
 */
async function ensureCompiler() {
  if (compiler) return compiler;
  if (starting) return starting;

  starting = (async () => {
    const baseUrl = params.get('baseUrl') || new URL('/', location.href).href;
    appendLog(`Starting the Lean runtime from ${baseUrl}`);

    const t0 = performance.now();
    const created = await createCompiler({
      baseUrl,
      syntaxCheck: params.get('syntaxCheck') ?? 'auto',
      onProgress: (message) => {
        setState({ stage: 'loading' });
        setStatus(message, 'busy');
        appendLog(message);
      },
      onStatus: (message) => setStatus(message, 'busy'),
    });

    const initMs = Math.round(performance.now() - t0);
    setState({ initMs });
    appendLog(`Lean ready in ${(initMs / 1000).toFixed(1)}s`);
    setStatus('Lean loaded. Ready.', 'ok');
    compiler = created;
    return created;
  })();

  try {
    return await starting;
  } catch (err) {
    starting = null;
    throw err;
  }
}

async function run() {
  if (busy) return;
  setBusy(true);
  setPane(els.output, '', 'Run something.');
  setPane(els.diagnostics, '', 'Nothing yet.');

  const code = els.editor.value;
  const runs = Number(document.documentElement.dataset.runs || 0) + 1;
  setState({ status: 'running', runs, exitCode: '' });

  try {
    const lean = await ensureCompiler();

    setStatus('Elaborating and kernel-checking…', 'busy');
    appendLog(`Run #${runs}: ${code.split('\n').length} line(s)`);

    const result = await lean.run(code);
    const seconds = (result.compileMs / 1000).toFixed(2);

    setPane(els.output, result.output, 'No output.');
    setPane(
      els.diagnostics,
      result.errors.join('\n'),
      'No diagnostics — the kernel accepted everything in this file.',
    );

    setState({ status: 'done', exitCode: result.exitCode, runMs: result.compileMs });
    appendLog(
      `Done in ${seconds}s (exit code ${result.exitCode})` +
        (result.libraries.length > 0 ? ` — loaded ${result.libraries.join(', ')}` : '') +
        (result.noise > 0 ? ` — filtered ${result.noise} trace line(s)` : ''),
    );
    scrollToResults();
    setStatus(
      result.exitCode === 0
        ? `Accepted by the kernel in ${seconds}s.`
        : `Rejected in ${seconds}s.`,
      result.exitCode === 0 ? 'ok' : 'err',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setPane(els.diagnostics, message, '');
    setState({ status: 'error' });
    appendLog(`Error: ${message}`);
    scrollToResults();
    setStatus(message, 'err');
  } finally {
    setBusy(false);
  }
}

function init() {
  EXAMPLES.forEach((example, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = example.name;
    els.examples.appendChild(option);
  });
  els.editor.value = EXAMPLES[1].code;

  els.examples.addEventListener('change', () => {
    els.editor.value = EXAMPLES[Number(els.examples.value)].code;
  });
  els.run.addEventListener('click', run);
  els.clear.addEventListener('click', () => {
    setPane(els.output, '', 'Run something.');
    setPane(els.diagnostics, '', 'Nothing yet.');
    setStatus('Cleared.');
  });
  els.editor.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      run();
      return;
    }
    // Keep Tab in the editor.
    if (event.key === 'Tab') {
      event.preventDefault();
      const { selectionStart: start, selectionEnd: end, value } = els.editor;
      els.editor.value = value.slice(0, start) + '  ' + value.slice(end);
      els.editor.selectionStart = els.editor.selectionEnd = start + 2;
    }
  });

  // The runtime needs a SharedArrayBuffer, which is what "cross-origin isolated" buys. The package
  // throws with the same explanation; showing it up front saves a confusing first run.
  const hasSAB = typeof SharedArrayBuffer !== 'undefined';
  const isolated = self.crossOriginIsolated === true;

  els.isolation.textContent = isolated
    ? 'cross-origin isolated'
    : hasSAB
      ? 'SharedArrayBuffer, not isolated'
      : 'no SharedArrayBuffer';
  els.isolation.className = `pill ${hasSAB ? 'good' : 'bad'}`;
  els.payload.textContent = '~127 MB of assets';

  if (!hasSAB) {
    els.banner.className = 'show';
    els.banner.textContent =
      'SharedArrayBuffer is unavailable, so the Lean runtime cannot boot. Serve the page with ' +
      "COOP/COEP (npm start) — Lean needs a shared WebAssembly memory. An embedded page that cannot " +
      "set those headers has only Chrome's reverse origin trial for SharedArrayBuffer, and that does " +
      'not exist in Firefox or Safari.';
    setStatus('SharedArrayBuffer required.', 'err');
  }

  setState({
    status: 'idle',
    stage: 'idle',
    runs: 0,
    isolated,
    sharedArrayBuffer: hasSAB,
    leanVersion: 'cauli/lean4 wasm build (reinstate-wasm fork)',
  });
}

init();
