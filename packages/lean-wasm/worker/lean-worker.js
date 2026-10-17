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
 * Whether it needs a cross-origin isolated document is the artifact's decision, not this file's. The
 * probe in @live-codes/lean-wasm reads the memory import off the module before the download, and a
 * single-threaded build — one that declares an unshared memory — runs here with no isolation at all
 * (FINDINGS.md §9). The pthread build the project ships today does need it.
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

// What the artifact declares about its memory, read by `probeArtifactMemory` in @live-codes/lean-wasm and
// handed in as configuration — the worker cannot ask, because it holds the whole module and the answer
// has to arrive before the download (FINDINGS.md §2).
//
//   {mode: 'shared',   initial, maximum}  a pthread build: it needs SharedArrayBuffer, and the memory
//                                         this worker constructs must match the declared limits
//   {mode: 'unshared', initial, maximum}  a single-threaded build: no SharedArrayBuffer, no isolation,
//                                         and no memory for this worker to construct at all
//   null                                  the probe could not read the artifact, so the runtime does
//                                         what it did before it could ask and assumes `shared`
const declaredMemory = workerConfig.memory ?? null;
const artifactIsThreaded = declaredMemory?.mode !== 'unshared';

// Bake mode: run the runtime **as the Lean CLI** to produce an `--incr-header-save` environment snapshot,
// rather than booting the playground. The snapshot takes the `Init` import out of the first Run, which on
// the single-threaded build is ~100 s against ~1.3 s for the pthread build (FINDINGS.md §9.7), and it has
// to be produced by the binary that will load it — a snapshot embeds closure relocations valid only
// against the saving binary's function table.
//
// It cannot share a session with compiling: the CLI parses its own arguments and the runtime exits when it
// is done (`-sEXIT_RUNTIME=1`). See `packages/lean-wasm/src/bake.js`.
const bake = workerConfig.bake ?? null;
// Where the bake writes its probe, and where a snapshot is written when one is loaded at boot. Both live
// inside the virtual filesystem; `/workspace` is created in `preRun` either way.
const PROBE_PATH = '/workspace/probe.lean';
const SNAPSHOT_PATH = '/workspace/init.snap';

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
 * cross-origin isolation — and it is only needed when the artifact declares one.
 *
 * The limits are the artifact's, not ours. Two failures come from ignoring that,
 * and both are real: a memory whose maximum exceeds the module's declared maximum
 * fails at instantiation with
 *   LinkError: Import #461 "env" "memory": memory import has a larger maximum
 *   size 65536 than the module's declared maximum 32768
 * and a memory smaller than the module's declared minimum fails the other way.
 * The pinned build declares min 1024 / max 65536 pages (4 GiB); the previous one
 * declared max 32768 and linking it against 65536 is exactly the failure above.
 * Now that the probe reads those numbers off the import section, the runtime
 * cannot produce that mismatch — it only has to stay under the ceiling.
 */
const MAX_PAGES = 65536;

function pickMemory() {
  const PAGE = 65536;
  // The declared maximum is a ceiling and the declared minimum is a floor. Falling back to our own
  // ceiling when the artifact could not be read keeps the pre-probe behaviour unchanged.
  const maximum = declaredMemory?.maximum ?? MAX_PAGES;
  const floor = declaredMemory?.initial ?? 0;

  for (const mb of [2048, 1536, 1024, 768]) {
    const initial = Math.max(floor, (mb * 1024 * 1024) / PAGE);
    if (initial > maximum) continue;
    try {
      const memory = new WebAssembly.Memory({ initial, maximum, shared: true });
      post({ type: 'memory', mb, initialPages: initial, maximumPages: maximum, declared: declaredMemory !== null });
      return { memory, bytes: initial * PAGE };
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
 * `fetch` reports a network failure as a bare `TypeError: Failed to fetch`, which says nothing about which
 * of several URLs it was — and this worker fetches several. Naming the URL here is the difference between
 * a five-second diagnosis and an afternoon.
 */
async function fetchOrThrow(url) {
  try {
    return await fetch(url);
  } catch (error) {
    throw new Error(`${url}: ${error && error.name ? error.name + ' — ' : ''}${(error && error.message) || error}`);
  }
}

/**
 * Fetch the wasm module here rather than leaving it to Emscripten, so a host can store it
 * **compressed**. Cloudflare Pages refuses files over 25 MiB and this one is 96.2 MiB raw — 16.5 MiB
 * gzipped, which is what makes a plain static host (Pages included) able to serve it at all.
 *
 * What comes back is a **blob URL**, not the bytes, and that is the point: this is a pthread build, so
 * Emscripten's sub-workers each load the module for themselves through `locateFile`. Handing them the
 * decompressed bytes as a same-origin blob means a compressed host stays a single download, without
 * needing `wasmBinary` (which the main thread honours but the workers ignore, so they fall back to
 * requesting `lean.wasm` — the one file a compressed host does not have).
 *
 * `type: 'application/wasm'` matters: it keeps `WebAssembly.compileStreaming` available, where a
 * typeless blob falls back to ArrayBuffer instantiation.
 *
 * Both layouts work: a host with no size limit keeps serving `lean.wasm`, and pays one 404 for the probe.
 */
let wasmBlobUrl = null;

async function loadWasmUrl() {
  if (wasmBlobUrl) return wasmBlobUrl;

  for (const candidate of [`${assetBase}/lean.wasm.gz`, `${assetBase}/lean.wasm`]) {
    const response = await fetchOrThrow(candidate);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`${candidate}: HTTP ${response.status}`);

    const name = candidate.slice(candidate.lastIndexOf('/') + 1);
    const length = Number(response.headers.get('content-length')) || 0;
    post({ type: 'status', data: `downloading the runtime (${name}${length ? `, ${(length / 1048576).toFixed(1)} MB` : ''})…` });

    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    wasmBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
    return wasmBlobUrl;
  }

  throw new Error(`No lean.wasm (or lean.wasm.gz) at ${assetBase}`);
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
// Whether the tree is stored as `<path>.gz`. The index decides for the whole directory, so this costs
// one probe per session rather than one per file — which matters when a root is 1,449 files.
let libCompressed = false;

async function getLibraryIndex() {
  if (libraryIndex) return libraryIndex;

  const candidates = [
    [`${libBase}/lean-lib-files.json.gz`, true],
    [`${libBase}/lean-lib-files.json`, false]
  ];
  for (const [url, compressed] of candidates) {
    const response = await fetch(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`library index: HTTP ${response.status}`);

    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    libCompressed = compressed;
    libraryIndex = JSON.parse(new TextDecoder().decode(bytes));
    return libraryIndex;
  }
  throw new Error(`No lean-lib-files.json (or .gz) at ${libBase}`);
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
  let failed = 0;
  let next = 0;
  const CONCURRENCY = 8;
  const urlOf = (rel) => `${libBase}/${rel}${libCompressed ? '.gz' : ''}`;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const rel = targets[i];

      // A transient failure used to be invisible — the file was skipped, and Lean only complained if
      // something happened to import it. Retry once, then count it so the caller can say so.
      let data = null;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const fetched = await fetchIfPresent(urlOf(rel));
          if (!fetched) break; // a module simply has no such sibling
          data = libCompressed ? await gunzip(fetched) : fetched;
          break;
        } catch (error) {
          if (attempt >= 1) {
            failed += 1;
            break;
          }
        }
      }
      if (!data) continue;

      // Every `.olean`, `.ir` and `.ir.sig` starts with the same header. Checking it here turns the
      // two most common hosting mistakes into something actionable: a host with an SPA fallback
      // answers `200` with HTML for a file that is not deployed, and Lean's own complaint about that
      // arrives much later, from inside the kernel, as `failed to read file '…, invalid header`.
      if (!(data.length > 8 && data[0] === 0x6f && data[1] === 0x6c && data[2] === 0x65 && data[3] === 0x61 && data[4] === 0x6e)) {
        const looksLikeHtml = data.length > 2 && data[0] === 0x3c;
        throw new Error(
          `${rel} is not a Lean object file${looksLikeHtml ? ' — the host returned HTML for it, so the library' : ''}` +
            `${looksLikeHtml ? ' tree is missing from baseUrl (an SPA fallback hides the 404).' : ` (${data.length} bytes).`}`
        );
      }

      try {
        writeLibEntry(Module.FS, rel, data);
        files += 1;
        bytes += data.length;
      } catch {
        failed += 1; // an individual write failure
      }
      if (files % 400 === 0) post({ type: 'modules', stage: 'progress', root, files, total: targets.length });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  loadedRoots.add(root);
  post({ type: 'modules', stage: 'loaded', root, files, bytes, failed, total: targets.length });
  return { root, files, bytes, failed };
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

/**
 * Finish the boot once the runtime is initialised: load a baked environment snapshot if this host serves
 * one, then declare the runtime ready.
 *
 * The snapshot is why a first Run can be fast at all: it carries the imported `Init` environment, so the
 * ~100 s import the single-threaded build otherwise pays (FINDINGS.md §9.7) never happens — upstream's
 * `Shell.lean` says a snapshot "skips the multi-minute `loadExts` import entirely". It is optional: a host
 * without one still works and simply pays the import.
 */
async function finishStartup() {
  if (typeof Module._lean_wasm_load_snapshot === 'function') {
    try {
      const response = await fetchOrThrow(`${assetBase}/snapshots/init.snap`);
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        Module.FS.writeFile(SNAPSHOT_PATH, bytes);
        // The loader reads a dependency sidecar beside the snapshot. A self-contained snapshot's list is
        // empty, which is why upstream ships only the snapshot itself and writes the sidecar in the worker —
        // and why the load is refused without it.
        Module.FS.writeFile(`${SNAPSHOT_PATH}.deps`, new Uint8Array([0x5b, 0x5d]));
        const code = Module._lean_wasm_load_snapshot(SNAPSHOT_PATH);
        post({
          type: 'status',
          data:
            code === 0
              ? `loaded the Init snapshot (${(bytes.length / 1048576).toFixed(1)} MB) — the first run will not import`
              : `the Init snapshot was refused (code ${code}); the first run will import instead`,
        });
      }
    } catch {
      // Absent is the normal case for a host that never baked one, and a host that answers 200 with an
      // HTML shell for a missing file is caught by the loader, which returns a failure code.
      post({ type: 'status', data: 'no Init snapshot at this host; the first run will import' });
    }
  }
  moduleReady = true;
  post({ type: 'ready' });
}

async function startLeanModule() {
  // A shared memory is only this worker's job when the artifact declares one. A single-threaded build
  // declares an unshared memory, which needs no SharedArrayBuffer and therefore no cross-origin
  // isolation — and there is nothing to construct here either, because that memory can grow and
  // Emscripten already knows the limits it was built with.
  let picked = null;
  if (artifactIsThreaded) {
    picked = pickMemory();
    if (!picked) {
      post({
        type: 'error',
        data:
          'The Lean artifact declares a shared WebAssembly memory, and this document has no ' +
          'SharedArrayBuffer — which it would only have if it were cross-origin isolated. Serve the page ' +
          'with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` ' +
          '(or `credentialless`), or, for an embed that cannot set headers, `Document-Isolation-Policy: ' +
          'isolate-and-require-corp` on the frame itself. A single-threaded Lean build would need none of ' +
          'this. See FINDINGS.md §2 and §9.',
      });
      return;
    }
  }

  self.Module = {
    // Omitted entirely for an unshared artifact, so Emscripten allocates the memory it was built for
    // rather than being handed limits guessed from outside.
    ...(picked ? { wasmMemory: picked.memory, INITIAL_MEMORY: picked.bytes } : {}),
    locateFile: (path) =>
      path.endsWith('.wasm') && wasmBlobUrl ? wasmBlobUrl : `${assetBase}/${path}${assetQ}`,
    // Only a pthread build needs to say where its script is: it spawns sub-workers that have to load it
    // same-origin. A single-threaded build has no sub-workers, and a build that does not list
    // `mainScriptUrlOrBlob` in INCOMING_MODULE_JS_API would rather not be handed an unknown key.
    ...(artifactIsThreaded ? { mainScriptUrlOrBlob: `${assetBase}/lean.js${assetQ}` } : {}),
    // In bake mode the CLI owns startup — Emscripten runs `main` as soon as `onRuntimeInitialized`
    // returns, so this worker must not also initialise the runtime itself, and must not wait for a `ready`.
    ...(bake
      ? { arguments: [`--incr-header-save=${bake.snapshotPath}`, PROBE_PATH], noInitialRun: false }
      : { noInitialRun: true }),
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
        // The bake needs a file to elaborate, and one that imports nothing: that is what makes it pay the
        // default `Init` header import, which is exactly the cost the snapshot exists to skip.
        if (bake) {
          try {
            FS.writeFile(PROBE_PATH, bake.probe ?? '#check 2+2');
          } catch (error) {
            post({ type: 'error', data: 'could not write the bake probe: ' + ((error && error.message) || error) });
          }
        }
      },
    ],
    onRuntimeInitialized: function () {
      // The CLI owns startup in bake mode. Returning from here is what lets Emscripten run `main`; doing
      // this worker's own init first would initialise the runtime twice.
      if (bake) return;
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
        void finishStartup();
      } catch (err) {
        post({ type: 'error', data: 'Lean init failed: ' + ((err && err.message) || err) });
      }
    },
    onExit: function (code) {
      if (!bake) {
        moduleReady = false;
        post({ type: 'status', data: `Lean exited (${code})` });
        return;
      }
      // The CLI has run, so the snapshot is on the filesystem — or it is not, which is worth saying
      // precisely rather than leaving the caller to time out.
      try {
        // Copied, not handed over: `FS.readFile` answers a view into the wasm heap, and posting that would
        // either clone the whole heap or fail, since this artifact defines its memory.
        const bytes = new Uint8Array(Module.FS.readFile(bake.snapshotPath));
        post({ type: 'snapshot', bytes, code });
      } catch (error) {
        post({
          type: 'error',
          data: `the bake exited (${code}) without writing ${bake.snapshotPath}: ` + ((error && error.message) || error),
        });
      }
    },
    onAbort: function (what) {
      moduleReady = false;
      post({ type: 'error', data: 'Aborted: ' + (what || 'unknown') });
    },
  };

  // Three separate steps, reported separately. Wrapping all of them in one `catch` that said "Failed to
  // load lean.js" made a failure to fetch the 97 MB wasm look like a failure to fetch the 48 MB script —
  // both fetched from the same base, and the message named only one of them.
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
    const response = await fetchOrThrow(`${assetBase}/lean.js${assetQ}`);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching lean.js`);
    const source = await response.text();
    // Kept for the lifetime of the runtime: pthread sub-workers load it lazily.
    mainScriptBlob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    if (artifactIsThreaded) Module.mainScriptUrlOrBlob = mainScriptBlob;
  } catch (err) {
    post({ type: 'error', data: 'Failed to load lean.js: ' + ((err && err.message) || err) });
    return;
  }

  try {
    // Emscripten and every pthread sub-worker instantiate from this same blob URL.
    await loadWasmUrl();
  } catch (err) {
    post({ type: 'error', data: 'Failed to fetch the Lean runtime: ' + ((err && err.message) || err) });
    return;
  }

  try {
    // The blob is how lean.js is evaluated here at all — a threaded build additionally needs it to be
    // same-origin for its sub-workers, which a bare `importScripts` of a CDN URL would not be.
    importScripts(mainScriptBlob);
  } catch (err) {
    post({ type: 'error', data: 'Failed to evaluate lean.js: ' + ((err && err.message) || err) });
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
