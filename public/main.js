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

    const assetBase = params.get('baseUrl') || '/lean-wasm';
    const t0 = performance.now();
    appendLog(`Starting the Lean runtime from ${assetBase}`);
    appendLog('Loading the packed core layer (Init: 629 modules, ~31 MB in 5 packs)');

    worker = new Worker(`./lean-worker.js?assetBase=${encodeURIComponent(assetBase)}`);
    setState({ stage: 'loading' });

    worker.onerror = (event) => {
      reject(new Error(event.message || 'Lean worker error'));
    };

    worker.onmessage = (event) => {
      const msg = event.data || {};

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
        resolve();
        return;
      }

      if (msg.type === 'error') {
        reject(new Error(msg.data));
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
    stdout = '';
    stderr = '';
    pending = (msg) => resolve({ ...msg, stdout, stderr });
    worker.postMessage({ type: 'compile', id, code, path: CODE_PATH });
  });
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
    const result = await compile(code);
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

    setPane(els.output, info.map((m) => m.text).join('\n'), 'No output.');
    setPane(
      els.diagnostics,
      formatProblems(problems),
      'No diagnostics — the kernel accepted everything in this file.',
    );

    setState({ status: 'done', exitCode, runMs });
    appendLog(
      `Done in ${(runMs / 1000).toFixed(2)}s (exit code ${exitCode})` +
        (noise ? ` — filtered ${noise} toolchain trace line(s)` : ''),
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

  // Report the two things that decide whether this page can work at all.
  const isolated = self.crossOriginIsolated === true;
  els.isolation.textContent = isolated ? 'cross-origin isolated' : 'NOT isolated';
  els.isolation.className = `pill ${isolated ? 'good' : 'bad'}`;
  els.payload.textContent = '~127 MB of assets';

  if (!isolated) {
    els.banner.className = 'show';
    els.banner.textContent =
      'This document is not cross-origin isolated, so SharedArrayBuffer is unavailable and the ' +
      'Lean runtime cannot boot. Serve the page with COOP/COEP (npm start) — Lean is a pthread ' +
      'build, so this is a hard requirement, not a header we can work around.';
    setStatus('Cross-origin isolation required.', 'err');
  }

  setState({
    status: 'idle',
    stage: 'idle',
    runs: 0,
    isolated,
    leanVersion: 'cauli/lean4 wasm build (reinstate-wasm fork)',
  });
}

init();
