/*! @live-codes/lean-wasm - MIT. IIFE build, sets self.leanWasm.
 *  importScripts('lean-wasm.global.js') then self.leanWasm.createCompiler({ baseUrl }).
 *  Runs Lean 4 (Apache-2.0) compiled to WebAssembly by cauli/lean4-wasm-in-browser (Apache-2.0);
 *  no third-party JavaScript is bundled. */
var leanWasm=(()=>{var M=Object.defineProperty;var Q=Object.getOwnPropertyDescriptor;var J=Object.getOwnPropertyNames;var V=Object.prototype.hasOwnProperty;var Z=(t,e)=>{for(var s in e)M(t,s,{get:e[s],enumerable:!0})},ee=(t,e,s,a)=>{if(e&&typeof e=="object"||typeof e=="function")for(let n of J(e))!V.call(t,n)&&n!==s&&M(t,n,{get:()=>e[n],enumerable:!(a=Q(e,n))||a.enumerable});return t};var te=t=>ee(M({},"__esModule",{value:!0}),t);var he={};Z(he,{DEFAULT_BASE_URL:()=>O,LANGUAGES:()=>ue,SYNTAX_MODES:()=>pe,availableRoots:()=>fe,createCompiler:()=>K,layers:()=>me,requiredAssetPaths:()=>T,resolveAssets:()=>$});var O=void 0,k={wasm:"lean-wasm",lib:"lean-lib",mathlib:"lean-mathlib"};function ne(t,e){let s;try{s=new URL(t,globalThis.location?.href)}catch{throw new Error(`${e} must be an absolute http(s) URL, or relative to the page: ${t}`)}if(s.protocol!=="http:"&&s.protocol!=="https:")throw new Error(`${e} must be http or https, not ${s.protocol}//`);return s}function $(t){let e=t??void 0;if(e==null||e==="")throw new Error("baseUrl is required: this package ships no assets (Lean\u2019s wasm is 96.2 MiB, past the 20 MB per-file limit on jsDelivr), so the runtime is fetched from a host you control. Run `npx --package @live-codes/lean-wasm lean-wasm-fetch-assets <dir>` to materialise them, then pass that directory as baseUrl.");let s=ne(e,"baseUrl").href.replace(/\/+$/,""),a=n=>`${s}/${n}`;return{baseUrl:`${s}/`,assetBase:a(k.wasm),libBase:a(k.lib),layerBase:a(k.mathlib)}}function T(){return[`${k.wasm}/lean.js`,`${k.wasm}/lean.wasm`,`${k.wasm}/core-layer.json`,`${k.wasm}/core-lib/artifacts-*.pack`,`${k.lib}/lean-lib-files.json`,`${k.lib}/**`,`${k.mathlib}/real-analysis-layer.json`,`${k.mathlib}/artifacts-*.pack`]}function re(t){return t.startsWith("[DEBUG:")||t.startsWith("mainModule? =")||t.startsWith("- /lib/lean/")||t.startsWith("wasm streaming compile failed:")||t==="falling back to ArrayBuffer instantiation"}function se(t){let e=t.data;return typeof e=="string"?e:e&&typeof e=="object"?e.msg??e.message??JSON.stringify(e):String(e??"")}function B(t,e){let s=[],a=[],n=0;for(let[l,h]of[["stdout",t],["stderr",e]])for(let _ of(h??"").split(`
`)){let b=_.trim();if(!b)continue;if(re(b)){n+=1;continue}let u=null;if(b.startsWith("{"))try{u=JSON.parse(b)}catch{u=null}if(u&&typeof u=="object"&&u.severity){let g={severity:u.severity,text:se(u),pos:u.pos??null};(u.severity==="information"?s:a).push(g)}else{let g={severity:l==="stdout"?"output":"error",text:b,pos:null};(l==="stdout"?s:a).push(g)}}return{info:s,problems:a,noise:n}}function I(t){let e=/\(line \d+, col \d+\)|at line \d+, column \d+/;return t.map(({severity:s,text:a,pos:n})=>{let l=String(a).replace(/\u001b\[[0-9;]*m/g,""),h=n?.line!=null&&!e.test(l)?`  (line ${n.line}${n.column!=null?`, col ${n.column}`:""})`:"";return s==="output"?l:`${s}: ${l}${h}`})}var A=["Std","Lean","Batteries"];function E(t){return[{label:"Mathlib",manifestUrl:`${t.layerBase}/real-analysis-layer.json`,packBase:t.layerBase,roots:["Mathlib","Aesop","Qq","Plausible","ProofWidgets","ImportGraph","LeanSearchClient","Game"]}]}var C={Lake:"Lake is a build tool, and there is no build step here."};function j(t){return t.replace(/\/-[\s\S]*?-\//g,"").replace(/--[^\n]*/g,"")}function v(t){let e=[];for(let s of j(t).split(`
`)){let a=/^\s*import\s+([A-Za-z0-9_'.]+)/.exec(s);if(!a)continue;let n=a[1].replace(/^'/,"").split(".")[0];n&&!e.includes(n)&&e.push(n)}return e}function N(t){return j(t).split(`
`).filter(e=>/^\s*import\s+\S/.test(e)).map(e=>e.trim()).join(`
`)}function W(t){let e=[];for(let s of t){let a=/unknown module prefix '([^']+)'/.exec(s.text);a&&!e.includes(a[1])&&e.push(a[1])}return e}function F(t){return[...A,...E(t).flatMap(e=>e.roots)]}function ae(t,e){return A.includes(t)||E(e).some(s=>s.roots.includes(t))?"lean-wasm-fetch-assets":null}function z(t,e,s){let a=[],n=l=>{a.includes(l)||a.push(l)};for(let l of v(t))if(e.includes(l)){let h=ae(l,s);n(h?`${l} is not on the asset host. Mirror it with \`${h}\`.`:`${l} is not available here.`)}else C[l]&&n(C[l]);return a}function D(t){let e=[];for(let s of t){let a=/object file '[^']*' of module (\S+)/.exec(s.text);if(!a)continue;let n=`${a[1]} is not in the published Mathlib closure. Upstream ships only the 4,303 modules its Real Analysis course needs, so some of Mathlib is available here and some is not.`;e.includes(n)||e.push(n)}return e}var G=`/**
 * Persistent Lean 4 WASM host \u2014 Web Worker.
 *
 * Adapted from cauli/lean4-wasm-in-browser's \`lean-worker-persistent.worker.js\`
 * (Apache-2.0). The structure is theirs, because the details it encodes are not
 * guessable: the init sequence the fork needs, which exports exist, where the IO
 * result tags sit, and the fact that the runtime must be initialised **without**
 * running main() (which would tear it down via EXIT_RUNTIME).
 *
 * What is different here: the library is fetched and unpacked *in the worker*
 * from the packed core layer, rather than being handed over from the page. That
 * keeps ~76 MB of decompressed \`.olean\`/\`.ir\` from being copied across the
 * structured-clone boundary.
 *
 * Why a real Worker and not an iframe: the Init import is a long synchronous
 * stretch in wasm, and a same-origin iframe shares the page's main thread, so it
 * freezes the whole tab. In a Worker it cannot.
 *
 * Requires a cross-origin isolated document \u2014 \`pickMemory\` constructs a
 * \`shared: true\` memory, which needs \`SharedArrayBuffer\`.
 */

// The build emits verbose tracing and it must not reach the UI.
const DEBUG_LINE = /^\\s*\\[(WASM DEBUG|DEBUG|IFRAME|PROFILE|PWORKER|COMPILE|SNAPSHOT|MEM)/;

let libraryFiles = [];
let moduleReady = false;
let compileBusy = false;
// Blob URL the runtime was bootstrapped from; pthread sub-workers load it too, so
// it must outlive the boot.
let mainScriptBlob = null;

// Configuration arrives either as a global or as a query string. The packaged runtime
// (@live-codes/lean-wasm) hands this file over as a blob, and a blob URL carries no query string, so
// it prepends \`self.__LEAN_WASM_CONFIG__\`; the demo loads this file directly and uses the query.
const workerConfig = self.__LEAN_WASM_CONFIG__ ?? {};
const workerParams = new URLSearchParams(location.search);
const assetBase = (workerConfig.assetBase || workerParams.get('assetBase') || '/lean-wasm').replace(/\\/$/, '');
const assetQ = '';
// Where the optional per-file libraries (Std, Lean, Batteries) are mirrored.
const libBase = (workerConfig.libBase || workerParams.get('libBase') || '/lean-lib').replace(/\\/$/, '');

const post = (msg) => self.postMessage(msg);

function isDebugLine(text) {
  return DEBUG_LINE.test(text);
}

// The build's tracing is voluminous, so it never reaches the panes \u2014 but it is
// the only view into the boot sequence, so keep it on the console rather than
// discarding it.
function logDebug(text) {
  console.log('[lean]', text);
}

// Long stretches of the boot \u2014 the Init import especially \u2014 emit only filtered
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
 * refuses. A \`shared: true\` memory is the reason this whole page needs
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
 * Fetch the wasm module here rather than leaving it to Emscripten, so a host can store it
 * **compressed**. Cloudflare Pages refuses files over 25 MiB and this one is 96.2 MiB raw \u2014 16.5 MiB
 * gzipped, which is what makes a plain static host (Pages included) able to serve it at all.
 *
 * What comes back is a **blob URL**, not the bytes, and that is the point: this is a pthread build, so
 * Emscripten's sub-workers each load the module for themselves through \`locateFile\`. Handing them the
 * decompressed bytes as a same-origin blob means a compressed host stays a single download, without
 * needing \`wasmBinary\` (which the main thread honours but the workers ignore, so they fall back to
 * requesting \`lean.wasm\` \u2014 the one file a compressed host does not have).
 *
 * \`type: 'application/wasm'\` matters: it keeps \`WebAssembly.compileStreaming\` available, where a
 * typeless blob falls back to ArrayBuffer instantiation.
 *
 * Both layouts work: a host with no size limit keeps serving \`lean.wasm\`, and pays one 404 for the probe.
 */
let wasmBlobUrl = null;

async function loadWasmUrl() {
  if (wasmBlobUrl) return wasmBlobUrl;

  for (const candidate of [\`\${assetBase}/lean.wasm.gz\`, \`\${assetBase}/lean.wasm\`]) {
    const response = await fetch(candidate);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(\`\${candidate}: HTTP \${response.status}\`);

    const name = candidate.slice(candidate.lastIndexOf('/') + 1);
    const length = Number(response.headers.get('content-length')) || 0;
    post({ type: 'status', data: \`downloading the runtime (\${name}\${length ? \`, \${(length / 1048576).toFixed(1)} MB\` : ''})\u2026\` });

    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    wasmBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));
    return wasmBlobUrl;
  }

  throw new Error(\`No lean.wasm (or lean.wasm.gz) at \${assetBase}\`);
}

/**
 * Fetch the packed core layer and slice it into individual files.
 *
 * Each pack is a gzip'd concatenation; the manifest carries the offset and
 * length of every entry within the *uncompressed* container, so no per-file
 * requests are needed \u2014 one 6 MB pack replaces ~380 round trips.
 */
async function loadLibrary() {
  const manifest = await (await fetch(\`\${assetBase}/core-layer.json\`)).json();
  post({ type: 'library', stage: 'manifest', modules: manifest.modules, packs: manifest.packs.length });

  const files = [];
  let done = 0;
  for (const pack of manifest.packs) {
    const response = await fetch(\`\${assetBase}/core-lib/\${pack.file}\`);
    if (!response.ok) throw new Error(\`\${pack.file}: HTTP \${response.status}\`);
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    if (bytes.length !== pack.bytes) {
      throw new Error(\`\${pack.file}: got \${bytes.length} bytes, manifest says \${pack.bytes}\`);
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
// individual files (\`.olean\` + \`.ir\` + \`.ir.sig\`) in a per-file tree indexed by
// \`lean-lib-files.json\`, exactly as upstream ships them. They are fetched on
// demand and written into the filesystem mid-session, which is enough because
// module resolution happens at compile time.

let libraryIndex = null;
const loadedRoots = new Set();
// Whether the tree is stored as \`<path>.gz\`. The index decides for the whole directory, so this costs
// one probe per session rather than one per file \u2014 which matters when a root is 1,449 files.
let libCompressed = false;

async function getLibraryIndex() {
  if (libraryIndex) return libraryIndex;

  const candidates = [
    [\`\${libBase}/lean-lib-files.json.gz\`, true],
    [\`\${libBase}/lean-lib-files.json\`, false]
  ];
  for (const [url, compressed] of candidates) {
    const response = await fetch(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(\`library index: HTTP \${response.status}\`);

    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    libCompressed = compressed;
    libraryIndex = JSON.parse(new TextDecoder().decode(bytes));
    return libraryIndex;
  }
  throw new Error(\`No lean-lib-files.json (or .gz) at \${libBase}\`);
}

async function fetchIfPresent(url) {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(\`\${url}: HTTP \${response.status}\`);
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
  const modules = index.filter((p) => p === \`\${root}.olean\` || p.startsWith(\`\${root}/\`));
  if (modules.length === 0) return { root, files: 0, bytes: 0, unavailable: true };

  // A module's \`.ir\` is only used when its \`.ir.sig\` is present, so all three
  // travel together.
  const targets = [];
  for (const module of modules) {
    targets.push(module, module.replace(/\\.olean$/, '.ir'), module.replace(/\\.olean$/, '.ir.sig'));
  }

  let files = 0;
  let bytes = 0;
  let failed = 0;
  let next = 0;
  const CONCURRENCY = 8;
  const urlOf = (rel) => \`\${libBase}/\${rel}\${libCompressed ? '.gz' : ''}\`;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const rel = targets[i];

      // A transient failure used to be invisible \u2014 the file was skipped, and Lean only complained if
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

      // Every \`.olean\`, \`.ir\` and \`.ir.sig\` starts with the same header. Checking it here turns the
      // two most common hosting mistakes into something actionable: a host with an SPA fallback
      // answers \`200\` with HTML for a file that is not deployed, and Lean's own complaint about that
      // arrives much later, from inside the kernel, as \`failed to read file '\u2026, invalid header\`.
      if (!(data.length > 8 && data[0] === 0x6f && data[1] === 0x6c && data[2] === 0x65 && data[3] === 0x61 && data[4] === 0x6e)) {
        const looksLikeHtml = data.length > 2 && data[0] === 0x3c;
        throw new Error(
          \`\${rel} is not a Lean object file\${looksLikeHtml ? ' \u2014 the host returned HTML for it, so the library' : ''}\` +
            \`\${looksLikeHtml ? ' tree is missing from baseUrl (an SPA fallback hides the 404).' : \` (\${data.length} bytes).\`}\`
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
    throw new Error(\`\${label}: manifest has no packs\`);
  }

  let files = 0;
  let bytes = 0;
  for (const [index, pack] of manifest.packs.entries()) {
    const response = await fetch(\`\${packBase}/\${pack.file}\`);
    if (!response.ok) throw new Error(\`\${pack.file}: HTTP \${response.status}\`);

    let raw = new Uint8Array(await response.arrayBuffer());
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);
    if (raw.length !== pack.bytes) {
      throw new Error(\`\${pack.file}: got \${raw.length} bytes, manifest says \${pack.bytes}\`);
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
    locateFile: (path) =>
      path.endsWith('.wasm') && wasmBlobUrl ? wasmBlobUrl : \`\${assetBase}/\${path}\${assetQ}\`,
    // Tell Emscripten where the runtime script is, so the pthread sub-workers the
    // runtime spawns can load lean.js (this file is the worker's own script).
    mainScriptUrlOrBlob: \`\${assetBase}/lean.js\${assetQ}\`,
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
    // \`importScripts\` itself tolerates a cross-origin script, but this is a pthread
    // build: the runtime spawns its thread pool with \`new Worker(mainScriptUrlOrBlob)\`,
    // and a worker script must be same-origin. With a cross-origin asset base that
    // throws during evaluation, and \`importScripts\` reports it only as
    // "the script at \u2026 failed to load" \u2014 with every other asset fetching fine, which
    // points at the wrong thing entirely. A blob URL is same-origin, and is what
    // \`mainScriptUrlOrBlob\` exists for.
    const response = await fetch(\`\${assetBase}/lean.js\${assetQ}\`);
    if (!response.ok) throw new Error(\`HTTP \${response.status} fetching lean.js\`);
    const source = await response.text();
    // Kept for the lifetime of the runtime: pthread sub-workers load it lazily.
    mainScriptBlob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    Module.mainScriptUrlOrBlob = mainScriptBlob;
    // Emscripten and every pthread sub-worker instantiate from this same blob URL.
    await loadWasmUrl();
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
`;var oe="/workspace/input.lean";function ie(t){return`self.__LEAN_WASM_CONFIG__ = ${JSON.stringify(t)};
${G}`}function H({assetBase:t,libBase:e,onProgress:s,onStatus:a}){let n=null,l=null,h="",_="",b=1,u=[],g=o=>{o&&s?.(o)};function i(o){let r=o.data||{};switch(r.type){case"stdout":h+=r.data+`
`;return;case"stderr":_+=r.data+`
`;return;case"status":a?.(r.data);return;case"memory":return;case"library":r.stage==="manifest"?g(`core layer: ${r.modules} modules in ${r.packs} packs`):r.stage==="pack"?g(`core pack ${r.loaded}/${r.total}`):r.stage==="written"&&g(`${r.files} library files installed`);return;case"modules":r.stage==="progress"&&g(`loading ${r.root}: ${r.files}/${r.total} files`);return;case"layer":r.stage==="progress"&&g(`loading ${r.label}: pack ${r.pack}/${r.packs}`);return;default:break}for(let w of[...u])w.match(r)&&(u.splice(u.indexOf(w),1),clearTimeout(w.timer),w.resolve(r));r.type==="error"&&c(new Error(r.data))}function c(o){for(let r of u.splice(0))clearTimeout(r.timer),r.reject(o)}function f(o,r,w){return new Promise((p,U)=>{let R={match:o,resolve:p,reject:U,timer:null};R.timer=setTimeout(()=>{let P=u.indexOf(R);P>=0&&u.splice(P,1),U(new Error(`${r} timed out after ${Math.round(w/1e3)}s`))},w),u.push(R)})}function m(o){if(!n)throw new Error("The Lean runtime is not running.");n.postMessage(o)}async function y(){n=new Worker(URL.createObjectURL(new Blob([ie({assetBase:t,libBase:e})],{type:"text/javascript"}))),n.onmessage=i,n.onerror=o=>c(new Error(o.message||"Lean runtime error")),m({type:"start"}),await f(o=>o.type==="ready","Starting the Lean runtime",12e4)}async function d(o){let r=b++;return m({type:"load_modules",id:r,roots:o}),(await f(p=>p.type==="modules_loaded"&&p.id===r,`Loading ${o.join(", ")}`,3e5)).results??[]}async function x(o){let r=b++;return m({type:"load_layer",id:r,label:o.label,manifestUrl:o.manifestUrl,packBase:o.packBase}),await f(p=>p.type==="layer_loaded"&&p.label===o.label,`Loading ${o.label}`,6e5)}async function S(o){let r=b++;return h="",_="",m({type:"compile",id:r,code:o,path:oe}),{...await f(p=>p.type==="result"&&p.id===r,"Compiling",6e5),stdout:h,stderr:_}}function L(){c(new Error("The compiler was disposed.")),n?.terminate(),n=null,l&&(URL.revokeObjectURL(l),l=null)}return{start:y,loadModules:d,loadLayer:x,compile:S,dispose:L}}function le(t){return`"${String(t).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n").replace(/\r/g,"\\r").replace(/\t/g,"\\t").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"").replace(/\u2028|\u2029/g," ")}"`}var q=/syntax error at line \d+, column \d+/;function X(t){let e=N(t);return`${e?e+`
`:""}import Lean
open Lean

run_cmd do
  let src := ${le(t)}
  let ictx := Parser.mkInputContext src "<your code>"
  let (_, ps, msgs) \u2190 Parser.parseHeader ictx
  let pmctx : Parser.ParserModuleContext := { env := (\u2190 getEnv), options := (\u2190 getOptions) }
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
`}var ce=8,Y=["auto","full","off"];function de(){if(typeof Worker!="function"||typeof Blob!="function")throw new Error("@live-codes/lean-wasm runs in a browser: the Lean runtime is a Web Worker, and it is handed over as a blob so that it stays same-origin.");if(typeof SharedArrayBuffer>"u")throw new Error("Lean\u2019s runtime imports a WebAssembly memory with `shared: true`, so it needs SharedArrayBuffer \u2014 which a document only has when it is cross-origin isolated. Serve the page with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). This is a hard requirement, not a header this library can work around.")}async function K(t={}){de();let e=$(t.baseUrl),s=t.syntaxCheck??"auto";if(!Y.includes(s))throw new Error(`syntaxCheck must be one of ${Y.join(", ")}, not ${s}`);let a=E(e),n=H({assetBase:e.assetBase,libBase:e.libBase,onProgress:t.onProgress,onStatus:t.onStatus}),l=new Set,h=new Set;await n.start();function _(i,c){if(i.files>0){l.add(i.root),c.loaded.push(`${i.root} (${i.files} files${i.failed?`, ${i.failed} failed`:""})`);return}if(i.alreadyLoaded){l.add(i.root);return}c.notMirrored.includes(i.root)||c.notMirrored.push(i.root)}async function b(i,c){let f=i.filter(d=>!c.attempted.has(d));if(f.length===0)return!1;f.forEach(d=>c.attempted.add(d));let m=!1;for(let d of a){if(!f.some(S=>d.roots.includes(S))||c.layers.has(d.label))continue;c.layers.add(d.label);let x=await n.loadLayer(d);x.ok?(h.add(d.label),x.alreadyLoaded||(c.loaded.push(`${d.label} layer (${x.files} files)`),m=!0)):c.notMirrored.includes(d.label)||c.notMirrored.push(d.label)}let y=f.filter(d=>A.includes(d));if(y.length>0)for(let d of await n.loadModules(y))_(d,c),d.files>0&&(m=!0);return m}async function u(i,c){await b(v(i),c);let f=await n.compile(i);for(let m=0;m<ce;m++){let{problems:y}=B(f.stdout,f.stderr);if(!await b(W(y),c))break;f=await n.compile(i)}return f}async function g(i,c){let f=await u(X(i),c),{problems:m}=B(f.stdout,f.stderr);return m.filter(y=>q.test(y.text))}return{language:"lean",assets:e,async run(i,c,f={}){if(typeof i!="string")throw new Error("run() needs the program source as its first argument.");let m=f.syntaxCheck??s,y={attempted:new Set,layers:new Set,loaded:[],notMirrored:[]},d=performance.now(),x=await u(i,y),{info:S,problems:L,noise:o}=B(x.stdout,x.stderr);if(m!=="off"&&i.trim()!==""&&!L.some(p=>p.severity==="error")){let p=l.has("Lean")||h.size>0;(m==="full"||p)&&L.push(...await g(i,y))}let r=L.some(p=>p.severity==="error")||x.success===!1,w=r?[...z(i,y.notMirrored,e),...D(L)]:[];return{output:S.map(p=>p.text).join(`
`),errors:[...I(L),...w.map(p=>`note: ${p}`)],exitCode:r?1:0,noise:o,libraries:y.loaded,compileMs:Math.round(performance.now()-d)}},dispose(){n.dispose()}}}var ue=["lean"],pe=["auto","full","off"];function fe(t){return F(t??$())}function me(t){return E(t??$())}return te(he);})();
