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

const { createCompiler, bakeSnapshot } = globalThis.leanWasm;

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
      // Reported as soon as it is known, so the pill says what the artifact needs even when that is what
      // stops the boot.
      onArtifact: showArtifact,
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

/**
 * What this document can do. Only half the question: whether isolation is *required* is the artifact's
 * declaration, which the runtime reads off the wasm before the boot, so this reports capability and the
 * run reports the verdict (FINDINGS.md §9).
 */
function showCapability() {
  const hasSAB = typeof SharedArrayBuffer !== 'undefined';
  const isolated = self.crossOriginIsolated === true;
  els.isolation.textContent = isolated
    ? 'cross-origin isolated'
    : hasSAB
      ? 'SharedArrayBuffer, not isolated'
      : 'no SharedArrayBuffer';
  els.isolation.className = `pill ${hasSAB ? 'good' : 'bad'}`;
  return { hasSAB, isolated };
}

/** Add the artifact's own answer to the pill, once the runtime has read it. */
function showArtifact(artifact) {
  const mode = artifact?.memory;
  if (!mode || mode === 'unknown') return;
  els.isolation.textContent += ` · ${mode} memory`;
  els.isolation.className = `pill ${mode === 'shared' && !self.crossOriginIsolated ? 'bad' : 'good'}`;
  setState({ artifact: mode });
}

/**
 * Bake an `Init` snapshot with this artifact's own CLI, and offer it for download.
 *
 * The bake runs the runtime *as the Lean CLI* in a worker of its own, so the page stays responsive and the
 * runtime exits when it is done. It takes as long as the import takes — which is the point: you pay that
 * once here, and every first Run that loads the snapshot afterwards does not.
 */
async function runBake() {
  const baseUrl = params.get('baseUrl') || new URL('/', location.href).href;
  setState({ status: 'baking' });
  setStatus('Baking an Init snapshot — this pays the import once…', 'busy');
  appendLog(`Baking a snapshot from ${baseUrl}`);

  try {
    const started = performance.now();
    const bytes = await bakeSnapshot({
      baseUrl,
      probe: params.get('probe') ?? '#check 2+2',
      onProgress: (message) => setStatus(message, 'busy'),
    });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    appendLog(`Baked ${(bytes.length / 1048576).toFixed(1)} MB in ${seconds}s`);

    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'init.snap';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    // A headless probe cannot click a download, so it reads this instead.
    window.__snapshotBytes = bytes.length;
    setState({ status: 'baked', snapshotBytes: bytes.length });
    setStatus(`Baked ${(bytes.length / 1048576).toFixed(1)} MB — serve it at snapshots/init.snap.`, 'ok');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPane(els.diagnostics, message, '');
    appendLog(`Bake failed: ${message}`);
    setStatus(message, 'err');
    setState({ status: 'error' });
  }
}

function init() {
  // `?bake=1` — a one-off tool rather than a demo: the snapshot is what removes the `Init` import from a
  // first Run (FINDINGS.md §9.7), and only this artifact's own binary can produce one for it.
  if (params.get('bake') === '1') {
    void runBake();
    return;
  }

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

  // Reporting the document's capability is not the same as reporting a failure: whether isolation is
  // required is the artifact's declaration, and the runtime checks that before it downloads anything, so
  // a run names the artifact and the remedy far better than a guess here could (FINDINGS.md §9).
  const { hasSAB, isolated } = showCapability();
  els.payload.textContent = '~127 MB of assets';

  if (!hasSAB) {
    els.banner.className = 'show';
    els.banner.textContent =
      'No SharedArrayBuffer in this document, so only a single-threaded Lean build can run here. The ' +
      'artifact this repo mirrors is a pthread build and needs cross-origin isolation — serve the page ' +
      'with `npm start`. A run will name the artifact and say so rather than failing obscurely.';
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
