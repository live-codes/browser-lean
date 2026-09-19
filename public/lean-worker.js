/**
 * Persistent Lean 4 WASM host — Web Worker.
 *
 * Adapted from cauli/lean4-wasm-in-browser's `lean-worker-persistent.worker.js`
 * (Apache-2.0). The structure is theirs, because the details it encodes are not
 * guessable: the init sequence the fork needs, which exports exist, where the IO
 * result tags sit, and the fact that the runtime must be initialised **without**
 * running main() (which would tear it down via EXIT_RUNTIME).
 *
 * What is different here: the library is fetched and unpacked *in the worker*
 * from the packed core layer, rather than being handed over from the page. That
 * keeps ~76 MB of decompressed `.olean`/`.ir` from being copied across the
 * structured-clone boundary.
 *
 * Why a real Worker and not an iframe: the Init import is a long synchronous
 * stretch in wasm, and a same-origin iframe shares the page's main thread, so it
 * freezes the whole tab. In a Worker it cannot.
 *
 * Requires a cross-origin isolated document — `pickMemory` constructs a
 * `shared: true` memory, which needs `SharedArrayBuffer`.
 */

// The build emits verbose tracing and it must not reach the UI.
const DEBUG_LINE = /^\s*\[(WASM DEBUG|DEBUG|IFRAME|PROFILE|PWORKER|COMPILE|SNAPSHOT|MEM)/;

let libraryFiles = [];
let moduleReady = false;
let compileBusy = false;
// Blob URL the runtime was bootstrapped from; pthread sub-workers load it too, so
// it must outlive the boot.
let mainScriptBlob = null;

// Configuration arrives either as a global or as a query string. The packaged runtime
// (@live-codes/lean-wasm) hands this file over as a blob, and a blob URL carries no query string, so
// it prepends `self.__LEAN_WASM_CONFIG__`; the demo loads this file directly and uses the query.
const workerConfig = self.__LEAN_WASM_CONFIG__ ?? {};
const workerParams = new URLSearchParams(location.search);
const assetBase = (workerConfig.assetBase || workerParams.get('assetBase') || '/lean-wasm').replace(/\/$/, '');
const assetQ = '';
// Where the optional per-file libraries (Std, Lean, Batteries) are mirrored.
const libBase = (workerConfig.libBase || workerParams.get('libBase') || '/lean-lib').replace(/\/$/, '');

const post = (msg) => self.postMessage(msg);

function isDebugLine(text) {
  return DEBUG_LINE.test(text);
}

// The build's tracing is voluminous, so it never reaches the panes — but it is
// the only view into the boot sequence, so keep it on the console rather than
// discarding it.
function logDebug(text) {
  console.log('[lean]', text);
}

// Long stretches of the boot — the Init import especially — emit only filtered
// debug lines, so the page would otherwise see total silence and could not tell
// "still computing" from "wedged". A throttled heartbeat gives the page something
// to reset its watchdog on.
let lastActivityPost = 0;
function noteActivity() {
  const now = Date.now();
  if (now - lastActivityPost < 1000) return;
  lastActivityPost = now;
  post({ type: 'activity' });
}

function mkdirp(FS, path) {
  let current = '';
  for (const part of path.split('/').filter((p) => p)) {
    current += '/' + part;
    try {
      FS.mkdir(current);
    } catch {
      /* exists */
    }
  }
}

function writeLibEntry(FS, name, data) {
  const fullPath = '/lib/lean/' + name;
  mkdirp(FS, fullPath.substring(0, fullPath.lastIndexOf('/')));
  FS.writeFile(fullPath, new Uint8Array(data));
}

/**
 * Start with as much shared memory as we can get, and step down if the device
 * refuses. A `shared: true` memory is the reason this whole page needs
 * cross-origin isolation.
 *
 * MAX_PAGES must not exceed the maximum the module declares for the memory it
 * imports, or instantiation fails with
 *   LinkError: Import #461 "env" "memory": memory import has a larger maximum
 *   size 65536 than the module's declared maximum 32768
 * The pinned build declares min 1024 / max 65536 pages (4 GiB); that is readable
 * straight off the module's import section, and it is worth re-reading whenever
 * the pinned version moves, because the previous build declared max 32768 and
 * linking it against 65536 is exactly the failure above.
 */
const MAX_PAGES = 65536;

function pickMemory() {
  const PAGE = 65536;
  for (const mb of [2048, 1536, 1024, 768]) {
    try {
      const memory = new WebAssembly.Memory({
        initial: (mb * 1024 * 1024) / PAGE,
        maximum: MAX_PAGES,
        shared: true,
      });
      post({ type: 'memory', mb, maximumPages: MAX_PAGES });
      return { memory, bytes: mb * 1024 * 1024 };
    } catch {
      post({ type: 'memory', mb, failed: true });
    }
  }
  return null;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Fetch the packed core layer and slice it into individual files.
 *
 * Each pack is a gzip'd concatenation; the manifest carries the offset and
 * length of every entry within the *uncompressed* container, so no per-file
 * requests are needed — one 6 MB pack replaces ~380 round trips.
 */
async function loadLibrary() {
  const manifest = await (await fetch(`${assetBase}/core-layer.json`)).json();
  post({ type: 'library', stage: 'manifest', modules: manifest.modules, packs: manifest.packs.length });

  const files = [];
  let done = 0;
  for (const pack of manifest.packs) {
    const response = await fetch(`${assetBase}/core-lib/${pack.file}`);
    if (!response.ok) throw new Error(`${pack.file}: HTTP ${response.status}`);
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    if (bytes.length !== pack.bytes) {
      throw new Error(`${pack.file}: got ${bytes.length} bytes, manifest says ${pack.bytes}`);
    }
    for (const entry of pack.entries) {
      files.push({ name: entry.path, data: bytes.subarray(entry.offset, entry.offset + entry.bytes) });
    }
    done += 1;
    post({ type: 'library', stage: 'pack', loaded: done, total: manifest.packs.length, file: pack.file });
  }

  post({ type: 'library', stage: 'done', files: files.length });
  return files;
}

// ---- Optional libraries -------------------------------------------------
//
// The core layer only carries the Init closure. Std / Lean / Batteries live as
// individual files (`.olean` + `.ir` + `.ir.sig`) in a per-file tree indexed by
// `lean-lib-files.json`, exactly as upstream ships them. They are fetched on
// demand and written into the filesystem mid-session, which is enough because
// module resolution happens at compile time.

let libraryIndex = null;
const loadedRoots = new Set();

async function getLibraryIndex() {
  if (libraryIndex) return libraryIndex;
  const response = await fetch(`${libBase}/lean-lib-files.json`);
  if (!response.ok) throw new Error(`library index: HTTP ${response.status}`);
  libraryIndex = await response.json();
  return libraryIndex;
}

async function fetchIfPresent(url) {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Fetch every published file for one library root.
 *
 * No dependency graph is computed here: the page retries the compile after each
 * load, and Lean's own "unknown module prefix" error names the next root that is
 * missing, so the closure is discovered by asking the compiler.
 */
async function loadRoot(root) {
  if (loadedRoots.has(root)) return { root, files: 0, bytes: 0, alreadyLoaded: true };

  const index = await getLibraryIndex();
  const modules = index.filter((p) => p === `${root}.olean` || p.startsWith(`${root}/`));
  if (modules.length === 0) return { root, files: 0, bytes: 0, unavailable: true };

  // A module's `.ir` is only used when its `.ir.sig` is present, so all three
  // travel together.
  const targets = [];
  for (const module of modules) {
    targets.push(module, module.replace(/\.olean$/, '.ir'), module.replace(/\.olean$/, '.ir.sig'));
  }

  let files = 0;
  let bytes = 0;
  let next = 0;
  const CONCURRENCY = 8;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const rel = targets[i];
      let data;
      try {
        data = await fetchIfPresent(`${libBase}/${rel}`);
      } catch {
        continue; // one missing sibling is not fatal
      }
      if (!data) continue;
      try {
        writeLibEntry(Module.FS, rel, data);
        files += 1;
        bytes += data.length;
      } catch {
        /* ignore an individual write failure */
      }
      if (files % 400 === 0) post({ type: 'modules', stage: 'progress', root, files, total: targets.length });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  loadedRoots.add(root);
  post({ type: 'modules', stage: 'loaded', root, files, bytes });
  return { root, files, bytes };
}

// ---- Packed layers -----------------------------------------------------
//
// Mathlib is not published per-file: upstream ships it as a packed layer (a
// manifest plus gzip'd containers carrying offset/length for every entry), the
// same scheme the core Init layer uses. Packs are installed one at a time and
// released, so peak memory stays around a single pack rather than the whole
// 800 MiB layer.

const loadedLayers = new Set();

async function loadPackedLayer({ manifestUrl, packBase, label }) {
  if (loadedLayers.has(label)) return { files: 0, bytes: 0, alreadyLoaded: true };

  const manifest = await (await fetch(manifestUrl)).json();
  if (!manifest.packs || !Array.isArray(manifest.packs)) {
    throw new Error(`${label}: manifest has no packs`);
  }

  let files = 0;
  let bytes = 0;
  for (const [index, pack] of manifest.packs.entries()) {
    const response = await fetch(`${packBase}/${pack.file}`);
    if (!response.ok) throw new Error(`${pack.file}: HTTP ${response.status}`);

    let raw = new Uint8Array(await response.arrayBuffer());
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
    if (raw.length !== pack.bytes) {
      throw new Error(`${pack.file}: got ${raw.length} bytes, manifest says ${pack.bytes}`);
    }

    for (const entry of pack.entries) {
      writeLibEntry(Module.FS, entry.path, raw.subarray(entry.offset, entry.offset + entry.bytes));
    }
    files += pack.entries.length;
    bytes += raw.length;
    raw = null; // release this pack before the next one

    post({ type: 'layer', stage: 'progress', label, pack: index + 1, packs: manifest.packs.length, files, bytes });
  }

  loadedLayers.add(label);
  post({ type: 'layer', stage: 'loaded', label, files, bytes });
  return { files, bytes };
}

function mkLeanString(str) {
  const ptr = Module.stringToNewUTF8(str);
  const obj = Module._lean_mk_string(ptr);
  Module._free(ptr);
  return obj;
}

function compileCode(code, fileName) {
  if (!moduleReady) return { success: false, error: 'Module not ready' };
  if (compileBusy) return { success: false, error: 'Compile already in progress' };
  compileBusy = true;
  const t0 = performance.now();
  try {
    const codeObj = mkLeanString(code);
    const fnameObj = mkLeanString(fileName || '/workspace/input.lean');
    const resObj = Module._lean_wasm_compile(codeObj, fnameObj);
    const elapsed = performance.now() - t0;
    // IO result: ctor tag byte at offset 7 (0 = ok, anything else = error).
    const tag = Module.getValue(resObj + 7, 'i8') & 0xff;
    if (tag !== 0) {
      try {
        Module._lean_io_result_show_error(resObj);
      } catch {
        /* the error text has already gone to stderr */
      }
      return { success: false, error: 'lean_wasm_compile returned an IO error', elapsed };
    }
    return { success: true, elapsed };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  } finally {
    compileBusy = false;
  }
}

async function startLeanModule() {
  const picked = pickMemory();
  if (!picked) {
    post({ type: 'error', data: 'Could not allocate a shared WebAssembly memory (is the document cross-origin isolated?)' });
    return;
  }
  self.Module = {
    wasmMemory: picked.memory,
    INITIAL_MEMORY: picked.bytes,
    locateFile: (path) => `${assetBase}/${path}${assetQ}`,
    // Tell Emscripten where the runtime script is, so the pthread sub-workers the
    // runtime spawns can load lean.js (this file is the worker's own script).
    mainScriptUrlOrBlob: `${assetBase}/lean.js${assetQ}`,
    print: (text) => {
      noteActivity();
      if (isDebugLine(text)) return logDebug(text);
      post({ type: 'stdout', data: text });
    },
    printErr: (text) => {
      noteActivity();
      if (isDebugLine(text)) return logDebug(text);
      post({ type: 'stderr', data: text });
    },
    setStatus: (text) => {
      if (text) post({ type: 'status', data: text });
    },
    noInitialRun: true,
    preRun: [
      function () {
        const FS = Module.FS;
        Module.ENV['LEAN_PATH'] = '/lib/lean';
        for (const dir of ['/lib', '/lib/lean', '/workspace', '/bin']) {
          try {
            FS.mkdir(dir);
          } catch {
            /* exists */
          }
        }
        let errors = 0;
        for (const file of libraryFiles) {
          try {
            writeLibEntry(FS, file.name, file.data);
          } catch {
            errors += 1;
          }
        }
        post({ type: 'library', stage: 'written', files: libraryFiles.length, errors });
        libraryFiles = [];
        try {
          FS.chdir('/workspace');
        } catch {
          /* ignore */
        }
      },
    ],
    onRuntimeInitialized: function () {
      try {
        Module._lean_initialize_runtime_module();
        Module._lean_initialize();
        Module._lean_io_mark_end_initialization();
        if (Module._lean_init_task_manager) Module._lean_init_task_manager();
        if (Module._lean_enable_initializer_execution) Module._lean_enable_initializer_execution();
        const spRes = Module._lean_init_search_path();
        if ((Module.getValue(spRes + 7, 'i8') & 0xff) !== 0) {
          try {
            Module._lean_io_result_show_error(spRes);
          } catch {
            /* ignore */
          }
          throw new Error('lean_init_search_path failed (see stderr)');
        }
        moduleReady = true;
        post({ type: 'ready' });
      } catch (err) {
        post({ type: 'error', data: 'Lean init failed: ' + ((err && err.message) || err) });
      }
    },
    onAbort: function (what) {
      moduleReady = false;
      post({ type: 'error', data: 'Aborted: ' + (what || 'unknown') });
    },
  };

  try {
    // Fetch lean.js ourselves and hand it to the runtime as a **same-origin blob**.
    //
    // `importScripts` itself tolerates a cross-origin script, but this is a pthread
    // build: the runtime spawns its thread pool with `new Worker(mainScriptUrlOrBlob)`,
    // and a worker script must be same-origin. With a cross-origin asset base that
    // throws during evaluation, and `importScripts` reports it only as
    // "the script at … failed to load" — with every other asset fetching fine, which
    // points at the wrong thing entirely. A blob URL is same-origin, and is what
    // `mainScriptUrlOrBlob` exists for.
    const response = await fetch(`${assetBase}/lean.js${assetQ}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching lean.js`);
    const source = await response.text();
    // Kept for the lifetime of the runtime: pthread sub-workers load it lazily.
    mainScriptBlob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    Module.mainScriptUrlOrBlob = mainScriptBlob;
    importScripts(mainScriptBlob);
  } catch (err) {
    post({ type: 'error', data: 'Failed to load lean.js: ' + ((err && err.message) || err) });
  }
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'start') {
    try {
      libraryFiles = await loadLibrary();
      await startLeanModule();
    } catch (err) {
      post({ type: 'error', data: 'Loading the Lean library failed: ' + ((err && err.message) || err) });
    }
  } else if (msg.type === 'compile') {
    post({ type: 'result', id: msg.id, ...compileCode(msg.code, msg.path) });
  } else if (msg.type === 'load_modules') {
    const results = [];
    for (const root of msg.roots || []) {
      try {
        results.push(await loadRoot(root));
      } catch (err) {
        results.push({ root, files: 0, bytes: 0, error: (err && err.message) || String(err) });
      }
    }
    post({ type: 'modules_loaded', id: msg.id, roots: msg.roots || [], results });
  } else if (msg.type === 'load_layer') {
    try {
      const result = await loadPackedLayer(msg);
      post({ type: 'layer_loaded', id: msg.id, label: msg.label, ok: true, ...result });
    } catch (err) {
      post({ type: 'layer_loaded', id: msg.id, label: msg.label, ok: false, error: (err && err.message) || String(err) });
    }
  }
};
