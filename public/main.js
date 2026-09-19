/**
 * Driver for the Lean 4 playground.
 *
 * The runtime host is `public/lean-worker.js`, a persistent Worker that loads the
 * packed Lean core layer once, initialises the Lean runtime once, and then
 * compiles repeatedly through the fork's `lean_wasm_compile` export — which
 * caches the imported environment inside Lean, so the second compile for the same
 * import set is milliseconds rather than a fresh boot.
 *
 * This is the architecture of cauli/lean4-wasm-in-browser, whose artifact set we
 * mirror (see scripts/fetch-assets.mjs). It replaces an earlier version of this
 * page that drove `lean4.js` from the CDN: that wrapper built a fresh iframe per
 * run, so every Run rewrote the whole library and re-instantiated a 131 MB module
 * (~2 minutes per run), and its library was missing the `.ir` files needed to
 * `#eval` library functions.
 *
 * Everything here is presentation: lazy start, progress reporting, message
 * classification, and the `document.documentElement.dataset` state that scripted
 * checks read.
 */

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

// Element ids as globals, so headless probes can drive the page without string
// literals.
Object.assign(window, els);
window.params = params;

const CODE_PATH = '/workspace/input.lean';

/** Roots the worker can fetch per-file (mirrored by `npm run assets:libs`). */
const OPTIONAL_LIBRARIES = ['Std', 'Lean', 'Batteries'];

/**
 * Every asset lives under one base, in three sibling directories:
 *
 *   <base>/lean-wasm/     binaries (lean.js, lean.wasm) + the packed core layer
 *   <base>/lean-lib/      per-file libraries (Std, Lean, Batteries)
 *   <base>/lean-mathlib/  the packed Mathlib layer
 *
 * That is exactly the layout of `public/`, so `?baseUrl=` moves all three at once
 * and defaults to this origin's root, which is what `npm start` serves. Point it
 * at a CDN mirroring the same three directories and nothing else needs changing.
 * The host must send `Access-Control-Allow-Origin` — the binaries and layers are
 * fetched by `fetch()`, and a cross-origin `importScripts` under COEP needs it too.
 * See README §Packaging and hosting.
 */
const ASSET_ROOT = (params.get('baseUrl') || '').replace(/\/+$/, '');
const ASSET_BASE = `${ASSET_ROOT}/lean-wasm`;
const LIB_BASE = `${ASSET_ROOT}/lean-lib`;
const LAYER_BASE = `${ASSET_ROOT}/lean-mathlib`;

/**
 * Mathlib is not published per-file, so it arrives as a **packed layer**: the
 * 4,303-module closure upstream builds for its Real Analysis game, which brings
 * its tactic dependencies (Aesop, Qq, Plausible, ProofWidgets) with it. One layer
 * answers for all of those roots. Mirror it with `npm run assets:mathlib`.
 */
const OPTIONAL_LAYERS = [
  {
    label: 'Mathlib',
    manifestUrl: `${LAYER_BASE}/real-analysis-layer.json`,
    packBase: LAYER_BASE,
    roots: [
      'Mathlib',
      'Aesop',
      'Qq',
      'Plausible',
      'ProofWidgets',
      'ImportGraph',
      'LeanSearchClient',
      'Game',
    ],
  },
];

/** Which asset command supplies a root, for the "not mirrored" note. */
function assetCommandFor(root) {
  if (OPTIONAL_LIBRARIES.includes(root)) return 'npm run assets:libs';
  if (OPTIONAL_LAYERS.some((layer) => layer.roots.includes(root))) return 'npm run assets:mathlib';
  return null;
}

/**
 * Roots that cannot be supplied at all, with the reason. Importing one produces
 * Lean's own "unknown module prefix" error, which reads like a typo rather than a
 * documented limit of the playground — so say which it is. (Same idea as
 * browser-haskell's module rules.) See FINDINGS.md §5.
 */
const UNAVAILABLE_LIBRARIES = {
  Lake: 'Lake is a build tool, and there is no build step here.',
};

/** Strip comments so a commented-out import does not trigger a note. */
function stripComments(code) {
  return code.replace(/\/-[\s\S]*?-\//g, '').replace(/--[^\n]*/g, '');
}

function importedRoots(code) {
  const roots = [];
  for (const line of stripComments(code).split('\n')) {
    const match = /^\s*import\s+([A-Za-z0-9_'.]+)/.exec(line);
    if (!match) continue;
    const root = match[1].replace(/^'/, '').split('.')[0];
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

function unavailableImportNotes(code, notMirrored = []) {
  const notes = [];
  const add = (note) => {
    if (!notes.includes(note)) notes.push(note);
  };
  for (const root of importedRoots(code)) {
    if (notMirrored.includes(root)) {
      const command = assetCommandFor(root);
      add(
        command
          ? `${root} is not mirrored. Run \`${command}\` to fetch it.`
          : `${root} is not available in this playground.`,
      );
    } else if (UNAVAILABLE_LIBRARIES[root]) {
      add(UNAVAILABLE_LIBRARIES[root]);
    }
  }
  return notes;
}

/** Roots named by Lean's "unknown module prefix 'X'" diagnostics. */
function missingRoots(problems) {
  const roots = [];
  for (const problem of problems) {
    const match = /unknown module prefix '([^']+)'/.exec(problem.text);
    if (match && !roots.includes(match[1])) roots.push(match[1]);
  }
  return roots;
}

/**
 * Mathlib modules outside the published closure fail a different way: the prefix
 * resolves, but the object file is absent, so the compiler says so by path rather
 * than by prefix. Worth explaining, because "Mathlib" being available here does not
 * mean all of Mathlib is.
 */
function outsideClosureNotes(problems) {
  const notes = [];
  for (const problem of problems) {
    const match = /object file '[^']*' of module (\S+)/.exec(problem.text);
    if (!match) continue;
    const note = `${match[1]} is not in the published Mathlib closure. Upstream ships only the 4,303 modules its Real Analysis course needs, so some of Mathlib is available here and some is not.`;
    if (!notes.includes(note)) notes.push(note);
  }
  return notes;
}

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

let worker = null;
let starting = null;
let ready = false;
let busy = false;
let nextRunId = 1;
let pending = null;
let stdout = '';
let stderr = '';

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
  const panes = els.log.parentElement?.parentElement;
  if (panes) panes.scrollTop = panes.scrollHeight;
}

function setPane(el, text, emptyText) {
  const value = (text ?? '').replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
  if (!value) {
    el.textContent = emptyText;
    el.classList.add('empty');
    return;
  }
  el.textContent = value;
  el.classList.remove('empty');
}

// While a run is in flight the log is what is moving, so follow it; once the run
// settles, jump back to the top so the verdict and diagnostics are on screen.
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
 * Lines the wasm build emits about itself rather than about the user's program.
 * Match narrowly by hand, so a real diagnostic can never be swallowed: an
 * unrecognised line is always shown.
 */
function isToolchainNoise(line) {
  return (
    line.startsWith('[DEBUG:') ||
    line.startsWith('mainModule? =') ||
    line.startsWith('- /lib/lean/') ||
    line.startsWith('wasm streaming compile failed:') ||
    line === 'falling back to ArrayBuffer instantiation'
  );
}

function messageText(msg) {
  const data = msg.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') return data.msg ?? data.message ?? JSON.stringify(data);
  return String(data ?? '');
}

/**
 * Split both streams into the user's program output and real diagnostics.
 *
 * Two shapes arrive here. If the build emits JSON messages (one per line, as
 * `lean --json` does) the `severity` field is authoritative and explains why
 * errors can appear on stdout. Otherwise the text is plain, and the stream it
 * arrived on is the best signal available: stdout is `#eval`/`#check` results,
 * stderr is diagnostics.
 */
function collect(out, err) {
  const info = [];
  const problems = [];
  let noise = 0;

  for (const [stream, text] of [
    ['stdout', out],
    ['stderr', err],
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
        const entry = { severity: msg.severity, text: messageText(msg), pos: msg.pos };
        (msg.severity === 'information' ? info : problems).push(entry);
      } else {
        const entry = { severity: stream === 'stdout' ? 'output' : 'error', text: line, pos: null };
        (stream === 'stdout' ? info : problems).push(entry);
      }
    }
  }

  return { info, problems, noise };
}

function formatProblems(problems) {
  return problems
    .map(({ severity, text, pos }) => {
      const where =
        pos?.line != null
          ? `  (line ${pos.line}${pos.column != null ? `, col ${pos.column}` : ''})`
          : '';
      return severity === 'output' ? text : `${severity}: ${text}${where}`;
    })
    .join('\n');
}

/**
 * Boot the worker: it fetches and unpacks the core layer itself, then brings up
 * the Lean runtime and imports Init, which is the expensive part and happens
 * exactly once per page.
 */
function ensureLean() {
  if (ready) return Promise.resolve();
  if (starting) return starting;

  starting = new Promise((resolve, reject) => {
    if (typeof SharedArrayBuffer === 'undefined') {
      reject(
        new Error(
          'SharedArrayBuffer is unavailable, so the Lean runtime cannot start. This page must be ' +
            'served with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: ' +
            'require-corp (npm start does this; npm run start:no-isolation does not).',
        ),
      );
      return;
    }

    const t0 = performance.now();
    appendLog(`Starting the Lean runtime from ${ASSET_BASE}`);
    appendLog('Loading the packed core layer (Init: 629 modules, ~31 MB in 5 packs)');

    worker = new Worker(
      `./lean-worker.js?assetBase=${encodeURIComponent(ASSET_BASE)}&libBase=${encodeURIComponent(LIB_BASE)}`,
    );
    setState({ stage: 'loading' });

    // The boot can wedge — most obviously when a shared memory is granted but the
    // pthread workers cannot start — and without this the page would sit at
    // "loading" forever with no explanation. Every message resets the clock,
    // including the worker's throttled heartbeat, so a slow but live import is
    // never mistaken for a dead one.
    let lastActivity = Date.now();
    const IDLE_LIMIT_MS = 60000;
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_LIMIT_MS) {
        clearInterval(watchdog);
        reject(
          new Error(
            `The Lean runtime stopped responding while loading (no progress for ${IDLE_LIMIT_MS / 1000}s). ` +
              'Shared memory was granted but the runtime did not finish starting — the pthread workers ' +
              'may have been blocked.',
          ),
        );
      }
    }, 5000);

    const finish = (fn) => (value) => {
      clearInterval(watchdog);
      fn(value);
    };
    const resolveOnce = finish(resolve);
    const rejectOnce = finish(reject);

    worker.onerror = (event) => {
      rejectOnce(new Error(event.message || 'Lean worker error'));
    };

    worker.onmessage = (event) => {
      const msg = event.data || {};
      lastActivity = Date.now();

      if (msg.type === 'library') {
        if (msg.stage === 'manifest') {
          setStatus(`Core layer: ${msg.modules} modules in ${msg.packs} packs…`, 'busy');
        } else if (msg.stage === 'pack') {
          setStatus(`Loading core pack ${msg.loaded}/${msg.total} (${msg.file})…`, 'busy');
        } else if (msg.stage === 'written') {
          appendLog(`Wrote ${msg.files} library files into the virtual FS`);
        }
        return;
      }

      if (msg.type === 'memory') {
        if (msg.failed) appendLog(`Shared memory of ${msg.mb} MB refused; stepping down`);
        else appendLog(`Shared WebAssembly memory: ${msg.mb} MB (max ${msg.maximumPages} pages)`);
        return;
      }

      if (msg.type === 'status') {
        setStatus(msg.data, 'busy');
        return;
      }

      if (msg.type === 'ready') {
        ready = true;
        setState({ initMs: Math.round(performance.now() - t0) });
        appendLog(`Lean ready in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
        setStatus('Lean loaded. Ready.', 'ok');
        resolveOnce();
        return;
      }

      if (msg.type === 'error') {
        rejectOnce(new Error(msg.data));
        return;
      }

      // Compile-time output. `stdout`/`stderr` belong to whichever run is pending.
      if (msg.type === 'stdout') {
        stdout += msg.data + '\n';
        return;
      }
      if (msg.type === 'stderr') {
        stderr += msg.data + '\n';
        return;
      }
      if (msg.type === 'result') {
        const settle = pending;
        pending = null;
        if (settle) settle(msg);
        return;
      }
    };

    worker.postMessage({ type: 'start' });
  }).catch((err) => {
    starting = null;
    throw err;
  });

  return starting;
}

function compile(code) {
  return new Promise((resolve) => {
    const id = nextRunId++;
    window.__compiles = (window.__compiles || 0) + 1;
    stdout = '';
    stderr = '';
    pending = (msg) => resolve({ ...msg, stdout, stderr });
    worker.postMessage({ type: 'compile', id, code, path: CODE_PATH });
  });
}

/** Record the outcome of one library fetch, and remember what we could not get. */
function logLoadResult(entry, notMirrored) {
  if (entry.files > 0) {
    appendLog(`Loaded ${entry.root}: ${entry.files} files (${(entry.bytes / 1048576).toFixed(1)} MiB)`);
    return;
  }
  // Already installed by an earlier run in this page — not a missing library.
  if (entry.alreadyLoaded) return;
  if (!notMirrored.includes(entry.root)) notMirrored.push(entry.root);
  appendLog(`No files for ${entry.root}${entry.error ? `: ${entry.error}` : ' (not mirrored)'}`);
}

/** Ask the worker to fetch and install a library root, resolving when it is done. */
function loadModules(roots) {
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'modules' && msg.stage === 'progress') {
        setStatus(`Loading ${msg.root}: ${msg.files}/${msg.total} files…`, 'busy');
        return;
      }
      if (msg.type === 'modules_loaded') {
        worker.removeEventListener('message', onMessage);
        resolve(msg.results || []);
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'load_modules', roots });
  });
}

/** Ask the worker to install a packed layer, resolving when it finishes. */
function loadLayer(layer) {
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'layer' && msg.stage === 'progress') {
        setStatus(
          `Loading ${msg.label}: pack ${msg.pack}/${msg.packs} (${(msg.bytes / 1048576).toFixed(0)} MiB)…`,
          'busy',
        );
        return;
      }
      if (msg.type === 'layer_loaded' && msg.label === layer.label) {
        worker.removeEventListener('message', onMessage);
        resolve(msg);
      }
    };
    worker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'load_layer', ...layer });
  });
}

/**
 * Make `roots` resolvable, by whatever transport each one needs: a packed layer or
 * the per-file library tree, or both. Returns whether anything was actually
 * installed — which is what decides whether a recompile is worth doing.
 */
async function ensureRoots(roots, state) {
  const wanted = roots.filter((root) => !state.attempted.has(root));
  if (wanted.length === 0) return false;
  wanted.forEach((root) => state.attempted.add(root));

  let progress = false;

  for (const layer of OPTIONAL_LAYERS) {
    if (!wanted.some((root) => layer.roots.includes(root))) continue;
    if (state.layers.has(layer.label)) continue;
    state.layers.add(layer.label);

    setStatus(`Loading ${layer.label}…`, 'busy');
    const result = await loadLayer(layer);
    if (result.ok) {
      if (result.alreadyLoaded) {
        appendLog(`${layer.label} layer already loaded`);
      } else {
        appendLog(
          `Loaded the ${layer.label} layer: ${result.files} files (${(result.bytes / 1048576).toFixed(1)} MiB)`,
        );
        progress = true;
      }
    } else {
      appendLog(`Could not load the ${layer.label} layer: ${result.error}`);
      if (!state.notMirrored.includes(layer.label)) state.notMirrored.push(layer.label);
    }
  }

  const perFile = wanted.filter((root) => OPTIONAL_LIBRARIES.includes(root));
  if (perFile.length > 0) {
    setStatus(`Loading ${perFile.join(', ')}…`, 'busy');
    for (const entry of await loadModules(perFile)) {
      logLoadResult(entry, state.notMirrored);
      if (entry.files > 0) progress = true;
    }
  }

  return progress;
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
    await ensureLean();

    setStatus('Elaborating and kernel-checking…', 'busy');
    appendLog(`Run #${runs}: ${code.split('\n').length} line(s)`);

    const t0 = performance.now();
    const compilesBefore = window.__compiles || 0;
    const state = { attempted: new Set(), layers: new Set(), notMirrored: [] };

    // Read the program's imports first. Lean reports only the first missing prefix
    // per compile (the frontend aborts with an uncaught exception), so discovering
    // roots one compile at a time would make the number of compile rounds depend on
    // how many libraries a program imports. Reading the imports removes that: eight
    // imports from three libraries cost one load phase, not eight.
    await ensureRoots(importedRoots(code), state);

    let result = await compile(code);

    // Anything still missing is a transitive dependency, so keep asking the
    // compiler and loading what it names. Bounded by progress, not by a count: the
    // cap is only a backstop against a mirror that never satisfies an import.
    const MAX_ROUNDS = 8;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const { problems } = collect(result.stdout, result.stderr);
      const progressed = await ensureRoots(missingRoots(problems), state);
      // Only a round that actually installed something earns a recompile; a root
      // that was already present changes nothing, so stop rather than spin.
      if (!progressed) break;
      setStatus('Recompiling with the newly loaded library…', 'busy');
      result = await compile(code);
    }

    // If a root is still absent after everything we tried, say so rather than
    // leaving a bare "unknown module prefix" to be puzzled over.
    const unresolved = missingRoots(collect(result.stdout, result.stderr).problems).filter((root) =>
      state.attempted.has(root),
    );

    const runMs = Math.round(performance.now() - t0);

    const { info, problems, noise } = collect(result.stdout, result.stderr);

    // `success` from the runtime only means the compile call did not fail at the
    // IO level — it is true for a file that elaborates with errors. Whether the
    // kernel accepted the program is decided by the diagnostics.
    const hasErrors = problems.some((p) => p.severity === 'error') || !result.success;
    const exitCode = hasErrors ? 1 : 0;

    // The unclassified streams, for scripted probes and for anyone debugging why
    // something was filtered.
    window.__raw = { stdout: result.stdout, stderr: result.stderr, success: result.success, elapsed: result.elapsed };

    // Lean's own "unknown module prefix" is accurate but reads like a typo; add
    // the reason when the failure involves a library we cannot supply.
    const notes = hasErrors
      ? [
          ...unavailableImportNotes(code, state.notMirrored),
          ...outsideClosureNotes(problems),
          ...unresolved.map(
            (root) => `Loaded ${root}, but the compiler still cannot find it — the mirror looks incomplete.`,
          ),
        ]
      : [];
    const diagnostics = [formatProblems(problems), ...notes.map((n) => `note: ${n}`)]
      .filter(Boolean)
      .join('\n');

    setPane(els.output, info.map((m) => m.text).join('\n'), 'No output.');
    setPane(
      els.diagnostics,
      diagnostics,
      'No diagnostics — the kernel accepted everything in this file.',
    );

    setState({ status: 'done', exitCode, runMs });
    appendLog(
      `Done in ${(runMs / 1000).toFixed(2)}s (exit code ${exitCode}) — ` +
        `${(window.__compiles || 0) - compilesBefore} compile(s)` +
        (noise ? `, filtered ${noise} trace line(s)` : ''),
    );
    scrollToResults();
    setStatus(
      exitCode === 0
        ? `Accepted by the kernel in ${(runMs / 1000).toFixed(2)}s.`
        : `Rejected in ${(runMs / 1000).toFixed(2)}s.`,
      exitCode === 0 ? 'ok' : 'err',
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

  // The runtime needs SharedArrayBuffer, which normally means cross-origin
  // isolation — but not necessarily: Chrome's reverse origin trial grants SAB to a
  // page that is *not* isolated. So test the capability the runtime actually
  // needs, not the header, or the page would refuse to start in exactly the
  // configuration LiveCodes would have to use.
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
      'COOP/COEP (npm start) — Lean needs a shared WebAssembly memory. An embedded page that cannot ' +
      'set those headers has only Chrome\'s reverse origin trial for SharedArrayBuffer, and that ' +
      'does not exist in Firefox or Safari.';
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
