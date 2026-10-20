/*! @live-codes/lean-wasm - MIT. IIFE build, sets self.leanWasm.
 *  importScripts('lean-wasm.global.js') then self.leanWasm.createCompiler({ baseUrl }).
 *  Runs Lean 4 (Apache-2.0) compiled to WebAssembly by cauli/lean4-wasm-in-browser (Apache-2.0);
 *  no third-party JavaScript is bundled. */
var leanWasm=(()=>{var O=Object.defineProperty;var le=Object.getOwnPropertyDescriptor;var ce=Object.getOwnPropertyNames;var de=Object.prototype.hasOwnProperty;var ue=(e,r)=>{for(var t in r)O(e,t,{get:r[t],enumerable:!0})},he=(e,r,t,s)=>{if(r&&typeof r=="object"||typeof r=="function")for(let n of ce(r))!de.call(e,n)&&n!==t&&O(e,n,{get:()=>r[n],enumerable:!(s=le(r,n))||s.enumerable});return e};var fe=e=>he(O({},"__esModule",{value:!0}),e);var De={};ue(De,{DEFAULT_BASE_URL:()=>C,LANGUAGES:()=>Fe,SYNTAX_MODES:()=>Ce,availableRoots:()=>je,bakeSnapshot:()=>W,createCompiler:()=>ie,layers:()=>We,requiredAssetPaths:()=>j,resolveAssets:()=>E});var C=void 0,S={wasm:"lean-wasm",lib:"lean-lib",mathlib:"lean-mathlib"};function me(e,r){let t;try{t=new URL(e,globalThis.location?.href)}catch{throw new Error(`${r} must be an absolute http(s) URL, or relative to the page: ${e}`)}if(t.protocol!=="http:"&&t.protocol!=="https:")throw new Error(`${r} must be http or https, not ${t.protocol}//`);return t}function E(e){let r=e??void 0;if(r==null||r==="")throw new Error("baseUrl is required: this package ships no assets (Lean\u2019s wasm is 96.2 MiB, past the 20 MB per-file limit on jsDelivr), so the runtime is fetched from a host you control. Run `npx --package @live-codes/lean-wasm lean-wasm-fetch-assets <dir>` to materialise them, then pass that directory as baseUrl.");let t=me(r,"baseUrl").href.replace(/\/+$/,""),s=n=>`${t}/${n}`;return{baseUrl:`${t}/`,assetBase:s(S.wasm),libBase:s(S.lib),layerBase:s(S.mathlib)}}function j(){return[`${S.wasm}/lean.js`,`${S.wasm}/lean.wasm`,`${S.wasm}/core-layer.json`,`${S.wasm}/core-lib/artifacts-*.pack`,`${S.lib}/lean-lib-files.json`,`${S.lib}/**`,`${S.mathlib}/real-analysis-layer.json`,`${S.mathlib}/artifacts-*.pack`]}var R=`/**\r
 * Persistent Lean 4 WASM host \u2014 Web Worker.\r
 *\r
 * Adapted from cauli/lean4-wasm-in-browser's \`lean-worker-persistent.worker.js\`\r
 * (Apache-2.0). The structure is theirs, because the details it encodes are not\r
 * guessable: the init sequence the fork needs, which exports exist, where the IO\r
 * result tags sit, and the fact that the runtime must be initialised **without**\r
 * running main() (which would tear it down via EXIT_RUNTIME).\r
 *\r
 * What is different here: the library is fetched and unpacked *in the worker*\r
 * from the packed core layer, rather than being handed over from the page. That\r
 * keeps ~76 MB of decompressed \`.olean\`/\`.ir\` from being copied across the\r
 * structured-clone boundary.\r
 *\r
 * Why a real Worker and not an iframe: the Init import is a long synchronous\r
 * stretch in wasm, and a same-origin iframe shares the page's main thread, so it\r
 * freezes the whole tab. In a Worker it cannot.\r
 *\r
 * Whether it needs a cross-origin isolated document is the artifact's decision, not this file's. The\r
 * probe in @live-codes/lean-wasm reads the memory import off the module before the download, and a\r
 * single-threaded build \u2014 one that declares an unshared memory \u2014 runs here with no isolation at all\r
 * (FINDINGS.md \xA79). The pthread build the project ships today does need it.\r
 */\r
\r
// The build emits verbose tracing and it must not reach the UI.\r
const DEBUG_LINE = /^\\s*\\[(WASM DEBUG|DEBUG|IFRAME|PROFILE|PWORKER|COMPILE|SNAPSHOT|MEM)/;\r
\r
let libraryFiles = [];\r
let moduleReady = false;\r
let compileBusy = false;\r
// Blob URL the runtime was bootstrapped from; pthread sub-workers load it too, so\r
// it must outlive the boot.\r
let mainScriptBlob = null;\r
\r
// Configuration arrives either as a global or as a query string. The packaged runtime\r
// (@live-codes/lean-wasm) hands this file over as a blob, and a blob URL carries no query string, so\r
// it prepends \`self.__LEAN_WASM_CONFIG__\`; the demo loads this file directly and uses the query.\r
const workerConfig = self.__LEAN_WASM_CONFIG__ ?? {};\r
const workerParams = new URLSearchParams(location.search);\r
const assetBase = (workerConfig.assetBase || workerParams.get('assetBase') || '/lean-wasm').replace(/\\/$/, '');\r
const assetQ = '';\r
// Where the optional per-file libraries (Std, Lean, Batteries) are mirrored.\r
const libBase = (workerConfig.libBase || workerParams.get('libBase') || '/lean-lib').replace(/\\/$/, '');\r
\r
// What the artifact declares about its memory, read by \`probeArtifactMemory\` in @live-codes/lean-wasm and\r
// handed in as configuration \u2014 the worker cannot ask, because it holds the whole module and the answer\r
// has to arrive before the download (FINDINGS.md \xA72).\r
//\r
//   {mode: 'shared',   initial, maximum}  a pthread build: it needs SharedArrayBuffer, and the memory\r
//                                         this worker constructs must match the declared limits\r
//   {mode: 'unshared', initial, maximum}  a single-threaded build: no SharedArrayBuffer, no isolation,\r
//                                         and no memory for this worker to construct at all\r
//   null                                  the probe could not read the artifact, so the runtime does\r
//                                         what it did before it could ask and assumes \`shared\`\r
const declaredMemory = workerConfig.memory ?? null;\r
const artifactIsThreaded = declaredMemory?.mode !== 'unshared';\r
\r
// Bake mode: run the runtime **as the Lean CLI** to produce an \`--incr-header-save\` environment snapshot,\r
// rather than booting the playground. The snapshot takes the \`Init\` import out of the first Run, which on\r
// the single-threaded build is ~100 s against ~1.3 s for the pthread build (FINDINGS.md \xA79.7), and it has\r
// to be produced by the binary that will load it \u2014 a snapshot embeds closure relocations valid only\r
// against the saving binary's function table.\r
//\r
// It cannot share a session with compiling: the CLI parses its own arguments and the runtime exits when it\r
// is done (\`-sEXIT_RUNTIME=1\`). See \`packages/lean-wasm/src/bake.js\`.\r
const bake = workerConfig.bake ?? null;\r
// Where the bake writes its probe, and where a snapshot is written when one is loaded at boot. Both live\r
// inside the virtual filesystem; \`/workspace\` is created in \`preRun\` either way.\r
const PROBE_PATH = '/workspace/probe.lean';\r
const SNAPSHOT_PATH = '/workspace/init.snap';\r
\r
const post = (msg) => self.postMessage(msg);\r
\r
function isDebugLine(text) {\r
  return DEBUG_LINE.test(text);\r
}\r
\r
// The build's tracing is voluminous, so it never reaches the panes \u2014 but it is\r
// the only view into the boot sequence, so keep it on the console rather than\r
// discarding it.\r
function logDebug(text) {\r
  console.log('[lean]', text);\r
}\r
\r
// Long stretches of the boot \u2014 the Init import especially \u2014 emit only filtered\r
// debug lines, so the page would otherwise see total silence and could not tell\r
// "still computing" from "wedged". A throttled heartbeat gives the page something\r
// to reset its watchdog on.\r
let lastActivityPost = 0;\r
function noteActivity() {\r
  const now = Date.now();\r
  if (now - lastActivityPost < 1000) return;\r
  lastActivityPost = now;\r
  post({ type: 'activity' });\r
}\r
\r
function mkdirp(FS, path) {\r
  let current = '';\r
  for (const part of path.split('/').filter((p) => p)) {\r
    current += '/' + part;\r
    try {\r
      FS.mkdir(current);\r
    } catch {\r
      /* exists */\r
    }\r
  }\r
}\r
\r
function writeLibEntry(FS, name, data) {\r
  const fullPath = '/lib/lean/' + name;\r
  mkdirp(FS, fullPath.substring(0, fullPath.lastIndexOf('/')));\r
  FS.writeFile(fullPath, new Uint8Array(data));\r
}\r
\r
/**\r
 * Start with as much shared memory as we can get, and step down if the device\r
 * refuses. A \`shared: true\` memory is the reason this whole page needs\r
 * cross-origin isolation \u2014 and it is only needed when the artifact declares one.\r
 *\r
 * The limits are the artifact's, not ours. Two failures come from ignoring that,\r
 * and both are real: a memory whose maximum exceeds the module's declared maximum\r
 * fails at instantiation with\r
 *   LinkError: Import #461 "env" "memory": memory import has a larger maximum\r
 *   size 65536 than the module's declared maximum 32768\r
 * and a memory smaller than the module's declared minimum fails the other way.\r
 * The pinned build declares min 1024 / max 65536 pages (4 GiB); the previous one\r
 * declared max 32768 and linking it against 65536 is exactly the failure above.\r
 * Now that the probe reads those numbers off the import section, the runtime\r
 * cannot produce that mismatch \u2014 it only has to stay under the ceiling.\r
 */\r
const MAX_PAGES = 65536;\r
\r
function pickMemory() {\r
  const PAGE = 65536;\r
  // The declared maximum is a ceiling and the declared minimum is a floor. Falling back to our own\r
  // ceiling when the artifact could not be read keeps the pre-probe behaviour unchanged.\r
  const maximum = declaredMemory?.maximum ?? MAX_PAGES;\r
  const floor = declaredMemory?.initial ?? 0;\r
\r
  for (const mb of [2048, 1536, 1024, 768]) {\r
    const initial = Math.max(floor, (mb * 1024 * 1024) / PAGE);\r
    if (initial > maximum) continue;\r
    try {\r
      const memory = new WebAssembly.Memory({ initial, maximum, shared: true });\r
      post({ type: 'memory', mb, initialPages: initial, maximumPages: maximum, declared: declaredMemory !== null });\r
      return { memory, bytes: initial * PAGE };\r
    } catch {\r
      post({ type: 'memory', mb, failed: true });\r
    }\r
  }\r
  return null;\r
}\r
\r
async function gunzip(bytes) {\r
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));\r
  return new Uint8Array(await new Response(stream).arrayBuffer());\r
}\r
\r
/**\r
 * \`fetch\` reports a network failure as a bare \`TypeError: Failed to fetch\`, which says nothing about which\r
 * of several URLs it was \u2014 and this worker fetches several. Naming the URL here is the difference between\r
 * a five-second diagnosis and an afternoon.\r
 */\r
async function fetchOrThrow(url) {\r
  try {\r
    return await fetch(url);\r
  } catch (error) {\r
    throw new Error(\`\${url}: \${error && error.name ? error.name + ' \u2014 ' : ''}\${(error && error.message) || error}\`);\r
  }\r
}\r
\r
/**\r
 * Fetch the wasm module here rather than leaving it to Emscripten, so a host can store it\r
 * **compressed**. Cloudflare Pages refuses files over 25 MiB and this one is 96.2 MiB raw \u2014 16.5 MiB\r
 * gzipped, which is what makes a plain static host (Pages included) able to serve it at all.\r
 *\r
 * What comes back is a **blob URL**, not the bytes, and that is the point: this is a pthread build, so\r
 * Emscripten's sub-workers each load the module for themselves through \`locateFile\`. Handing them the\r
 * decompressed bytes as a same-origin blob means a compressed host stays a single download, without\r
 * needing \`wasmBinary\` (which the main thread honours but the workers ignore, so they fall back to\r
 * requesting \`lean.wasm\` \u2014 the one file a compressed host does not have).\r
 *\r
 * \`type: 'application/wasm'\` matters: it keeps \`WebAssembly.compileStreaming\` available, where a\r
 * typeless blob falls back to ArrayBuffer instantiation.\r
 *\r
 * Both layouts work: a host with no size limit keeps serving \`lean.wasm\`, and pays one 404 for the probe.\r
 */\r
let wasmBlobUrl = null;\r
\r
async function loadWasmUrl() {\r
  if (wasmBlobUrl) return wasmBlobUrl;\r
\r
  for (const candidate of [\`\${assetBase}/lean.wasm.gz\`, \`\${assetBase}/lean.wasm\`]) {\r
    // A timeout for the same reason the snapshots have one: a host that accepts the connection and then says\r
    // nothing hangs the boot with no message at all, which reads exactly like a very slow start.\r
    const response = await fetch(candidate, { signal: AbortSignal.timeout(60000) });\r
    if (response.status === 404) continue;\r
    if (!response.ok) throw new Error(\`\${candidate}: HTTP \${response.status}\`);\r
\r
    const name = candidate.slice(candidate.lastIndexOf('/') + 1);\r
    const length = Number(response.headers.get('content-length')) || 0;\r
    post({ type: 'status', data: \`downloading the runtime (\${name}\${length ? \`, \${(length / 1048576).toFixed(1)} MB\` : ''})\u2026\` });\r
\r
    let bytes = new Uint8Array(await response.arrayBuffer());\r
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);\r
    wasmBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/wasm' }));\r
    return wasmBlobUrl;\r
  }\r
\r
  throw new Error(\`No lean.wasm (or lean.wasm.gz) at \${assetBase}\`);\r
}\r
\r
/**\r
 * Fetch the packed core layer and slice it into individual files.\r
 *\r
 * Each pack is a gzip'd concatenation; the manifest carries the offset and\r
 * length of every entry within the *uncompressed* container, so no per-file\r
 * requests are needed \u2014 one 6 MB pack replaces ~380 round trips.\r
 */\r
async function loadLibrary() {\r
  const manifest = await (await fetch(\`\${assetBase}/core-layer.json\`)).json();\r
  post({ type: 'library', stage: 'manifest', modules: manifest.modules, packs: manifest.packs.length });\r
\r
  const files = [];\r
  let done = 0;\r
  for (const pack of manifest.packs) {\r
    const response = await fetch(\`\${assetBase}/core-lib/\${pack.file}\`);\r
    if (!response.ok) throw new Error(\`\${pack.file}: HTTP \${response.status}\`);\r
    let bytes = new Uint8Array(await response.arrayBuffer());\r
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);\r
    if (bytes.length !== pack.bytes) {\r
      throw new Error(\`\${pack.file}: got \${bytes.length} bytes, manifest says \${pack.bytes}\`);\r
    }\r
    for (const entry of pack.entries) {\r
      files.push({ name: entry.path, data: bytes.subarray(entry.offset, entry.offset + entry.bytes) });\r
    }\r
    done += 1;\r
    post({ type: 'library', stage: 'pack', loaded: done, total: manifest.packs.length, file: pack.file });\r
  }\r
\r
  post({ type: 'library', stage: 'done', files: files.length });\r
  return files;\r
}\r
\r
// ---- Optional libraries -------------------------------------------------\r
//\r
// The core layer only carries the Init closure. Std / Lean / Batteries live as\r
// individual files (\`.olean\` + \`.ir\` + \`.ir.sig\`) in a per-file tree indexed by\r
// \`lean-lib-files.json\`, exactly as upstream ships them. They are fetched on\r
// demand and written into the filesystem mid-session, which is enough because\r
// module resolution happens at compile time.\r
\r
let libraryIndex = null;\r
const loadedRoots = new Set();\r
// Whether the tree is stored as \`<path>.gz\`. The index decides for the whole directory, so this costs\r
// one probe per session rather than one per file \u2014 which matters when a root is 1,449 files.\r
let libCompressed = false;\r
\r
async function getLibraryIndex() {\r
  if (libraryIndex) return libraryIndex;\r
\r
  const candidates = [\r
    [\`\${libBase}/lean-lib-files.json.gz\`, true],\r
    [\`\${libBase}/lean-lib-files.json\`, false]\r
  ];\r
  for (const [url, compressed] of candidates) {\r
    const response = await fetch(url);\r
    if (response.status === 404) continue;\r
    if (!response.ok) throw new Error(\`library index: HTTP \${response.status}\`);\r
\r
    let bytes = new Uint8Array(await response.arrayBuffer());\r
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);\r
    libCompressed = compressed;\r
    libraryIndex = JSON.parse(new TextDecoder().decode(bytes));\r
    return libraryIndex;\r
  }\r
  throw new Error(\`No lean-lib-files.json (or .gz) at \${libBase}\`);\r
}\r
\r
async function fetchIfPresent(url) {\r
  const response = await fetch(url);\r
  if (response.status === 404) return null;\r
  if (!response.ok) throw new Error(\`\${url}: HTTP \${response.status}\`);\r
  return new Uint8Array(await response.arrayBuffer());\r
}\r
\r
/**\r
 * Supplying one library root: a baked snapshot when there is one for it, otherwise every published file of\r
 * it, one file at a time.\r
 *\r
 * No dependency graph is computed either way: the page retries the compile after each load, and Lean's own\r
 * "unknown module prefix" error names the next root that is missing, so the closure is discovered by asking\r
 * the compiler.\r
 */\r
/**\r
 * Try a baked snapshot for this root before its per-file tree.\r
 *\r
 * On a single-threaded build the *import* dominates, not the bytes: measured on the Std demo, fetching its\r
 * 483 modules' 1,449 files takes 5 s and loading them takes 104 s. A snapshot turns that import into a\r
 * deserialization. The loader reports its verdict on stderr \u2014 \`cached env for [...]\`, or \`failed: ...\` \u2014 and\r
 * that is the only signal worth trusting; its return value is an IO result whose layout is not ours to guess.\r
 *\r
 * Returns null when there is no snapshot for this root or it was refused, and the caller falls through to\r
 * the tree \u2014 which stays the general path, because a snapshot only matches the header it was baked for.\r
 */\r
async function tryRootSnapshot(root) {\r
  const name = root.toLowerCase();\r
  const url = \`\${assetBase}/snapshots/\${name}.snap\`;\r
  let bytes = null;\r
  try {\r
    const response = await fetch(url);\r
    if (response.ok) {\r
      post({ type: 'status', data: \`fetching the \${root} snapshot\u2026\` });\r
      bytes = new Uint8Array(await response.arrayBuffer());\r
    }\r
  } catch {\r
    return null;\r
  }\r
  if (!bytes) return null;\r
\r
  const path = \`/workspace/\${name}.snap\`;\r
  const trace = [];\r
  const outerPrintErr = Module.printErr;\r
  Module.printErr = (line) => {\r
    if (typeof line === 'string' && line.includes('wasmLoadSnapshot')) trace.push(line);\r
    if (typeof outerPrintErr === 'function') outerPrintErr(line);\r
  };\r
  // Three steps, reported separately. A single \`catch { return null }\` made a failed install indistinguishable\r
  // from no snapshot at all: the page silently took the file tree, and a run that had measured 13 s came back\r
  // at 61 s with nothing to explain the difference. If a step fails, say which and why.\r
  let failure = null;\r
  try {\r
    Module.FS.writeFile(path, bytes);\r
    Module.FS.writeFile(\`\${path}.deps\`, new Uint8Array([0x5b, 0x5d]));\r
    try {\r
      // The file tree is still fetched afterwards, and that is not a fallback: the program's header has to\r
      // *resolve* the module it imports, and a snapshot only supplies the elaborated environment for that\r
      // header. What the snapshot removes is the realization \u2014 the 104 s, not the 5 s.\r
      Module._lean_wasm_load_snapshot(mkLeanString(path));\r
    } catch (error) {\r
      failure = \`the loader threw: \${(error && error.message) || error}\`;\r
    }\r
  } catch (error) {\r
    failure = \`writing it into the file system failed: \${(error && error.message) || error}\`;\r
  } finally {\r
    Module.printErr = outerPrintErr;\r
  }\r
\r
  const megabytes = (bytes.length / 1048576).toFixed(1);\r
  const refused = trace.find((line) => line.includes('failed'));\r
  post({\r
    type: 'status',\r
    data: failure\r
      ? \`could not install the \${root} snapshot (\${megabytes} MB): \${failure} \u2014 the file tree follows\`\r
      : refused\r
        ? \`the \${root} snapshot was refused (\${refused}) \u2014 the file tree follows\`\r
        : \`handed the \${root} snapshot to the loader (\${megabytes} MB) \u2014 the file tree follows either way\`\r
  });\r
  return null;\r
}\r
\r
async function loadRoot(root) {\r
  if (loadedRoots.has(root)) return { root, files: 0, bytes: 0, alreadyLoaded: true };\r
\r
  const fromSnapshot = await tryRootSnapshot(root);\r
  if (fromSnapshot) {\r
    loadedRoots.add(root);\r
    return fromSnapshot;\r
  }\r
\r
  const index = await getLibraryIndex();\r
  const modules = index.filter((p) => p === \`\${root}.olean\` || p.startsWith(\`\${root}/\`));\r
  if (modules.length === 0) return { root, files: 0, bytes: 0, unavailable: true };\r
\r
  // A module's \`.ir\` is only used when its \`.ir.sig\` is present, so all three\r
  // travel together.\r
  const targets = [];\r
  for (const module of modules) {\r
    targets.push(module, module.replace(/\\.olean$/, '.ir'), module.replace(/\\.olean$/, '.ir.sig'));\r
  }\r
\r
  let files = 0;\r
  let bytes = 0;\r
  let failed = 0;\r
  let next = 0;\r
  const CONCURRENCY = 8;\r
  const urlOf = (rel) => \`\${libBase}/\${rel}\${libCompressed ? '.gz' : ''}\`;\r
\r
  async function worker() {\r
    for (;;) {\r
      const i = next++;\r
      if (i >= targets.length) return;\r
      const rel = targets[i];\r
\r
      // A transient failure used to be invisible \u2014 the file was skipped, and Lean only complained if\r
      // something happened to import it. Retry once, then count it so the caller can say so.\r
      let data = null;\r
      for (let attempt = 0; ; attempt += 1) {\r
        try {\r
          const fetched = await fetchIfPresent(urlOf(rel));\r
          if (!fetched) break; // a module simply has no such sibling\r
          data = libCompressed ? await gunzip(fetched) : fetched;\r
          break;\r
        } catch (error) {\r
          if (attempt >= 1) {\r
            failed += 1;\r
            break;\r
          }\r
        }\r
      }\r
      if (!data) continue;\r
\r
      // Every \`.olean\`, \`.ir\` and \`.ir.sig\` starts with the same header. Checking it here turns the\r
      // two most common hosting mistakes into something actionable: a host with an SPA fallback\r
      // answers \`200\` with HTML for a file that is not deployed, and Lean's own complaint about that\r
      // arrives much later, from inside the kernel, as \`failed to read file '\u2026, invalid header\`.\r
      if (!(data.length > 8 && data[0] === 0x6f && data[1] === 0x6c && data[2] === 0x65 && data[3] === 0x61 && data[4] === 0x6e)) {\r
        const looksLikeHtml = data.length > 2 && data[0] === 0x3c;\r
        throw new Error(\r
          \`\${rel} is not a Lean object file\${looksLikeHtml ? ' \u2014 the host returned HTML for it, so the library' : ''}\` +\r
            \`\${looksLikeHtml ? ' tree is missing from baseUrl (an SPA fallback hides the 404).' : \` (\${data.length} bytes).\`}\`\r
        );\r
      }\r
\r
      try {\r
        writeLibEntry(Module.FS, rel, data);\r
        files += 1;\r
        bytes += data.length;\r
      } catch {\r
        failed += 1; // an individual write failure\r
      }\r
      if (files % 400 === 0) post({ type: 'modules', stage: 'progress', root, files, total: targets.length });\r
    }\r
  }\r
\r
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));\r
  loadedRoots.add(root);\r
  post({ type: 'modules', stage: 'loaded', root, files, bytes, failed, total: targets.length });\r
  return { root, files, bytes, failed };\r
}\r
\r
// ---- Packed layers -----------------------------------------------------\r
//\r
// Mathlib is not published per-file: upstream ships it as a packed layer (a\r
// manifest plus gzip'd containers carrying offset/length for every entry), the\r
// same scheme the core Init layer uses. Packs are installed one at a time and\r
// released, so peak memory stays around a single pack rather than the whole\r
// 800 MiB layer.\r
\r
const loadedLayers = new Set();\r
\r
async function loadPackedLayer({ manifestUrl, packBase, label }) {\r
  if (loadedLayers.has(label)) return { files: 0, bytes: 0, alreadyLoaded: true };\r
\r
  const manifest = await (await fetch(manifestUrl)).json();\r
  if (!manifest.packs || !Array.isArray(manifest.packs)) {\r
    throw new Error(\`\${label}: manifest has no packs\`);\r
  }\r
\r
  let files = 0;\r
  let bytes = 0;\r
  for (const [index, pack] of manifest.packs.entries()) {\r
    const response = await fetch(\`\${packBase}/\${pack.file}\`);\r
    if (!response.ok) throw new Error(\`\${pack.file}: HTTP \${response.status}\`);\r
\r
    let raw = new Uint8Array(await response.arrayBuffer());\r
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = await gunzip(raw);\r
    if (raw.length !== pack.bytes) {\r
      throw new Error(\`\${pack.file}: got \${raw.length} bytes, manifest says \${pack.bytes}\`);\r
    }\r
\r
    for (const entry of pack.entries) {\r
      writeLibEntry(Module.FS, entry.path, raw.subarray(entry.offset, entry.offset + entry.bytes));\r
    }\r
    files += pack.entries.length;\r
    bytes += raw.length;\r
    raw = null; // release this pack before the next one\r
\r
    post({ type: 'layer', stage: 'progress', label, pack: index + 1, packs: manifest.packs.length, files, bytes });\r
  }\r
\r
  loadedLayers.add(label);\r
  post({ type: 'layer', stage: 'loaded', label, files, bytes });\r
  return { files, bytes };\r
}\r
\r
function mkLeanString(str) {\r
  const ptr = Module.stringToNewUTF8(str);\r
  const obj = Module._lean_mk_string(ptr);\r
  Module._free(ptr);\r
  return obj;\r
}\r
\r
function compileCode(code, fileName) {\r
  if (!moduleReady) return { success: false, error: 'Module not ready' };\r
  if (compileBusy) return { success: false, error: 'Compile already in progress' };\r
  compileBusy = true;\r
  const t0 = performance.now();\r
  try {\r
    const codeObj = mkLeanString(code);\r
    const fnameObj = mkLeanString(fileName || '/workspace/input.lean');\r
    const resObj = Module._lean_wasm_compile(codeObj, fnameObj);\r
    const elapsed = performance.now() - t0;\r
    // IO result: ctor tag byte at offset 7 (0 = ok, anything else = error).\r
    const tag = Module.getValue(resObj + 7, 'i8') & 0xff;\r
    if (tag !== 0) {\r
      try {\r
        Module._lean_io_result_show_error(resObj);\r
      } catch {\r
        /* the error text has already gone to stderr */\r
      }\r
      return { success: false, error: 'lean_wasm_compile returned an IO error', elapsed };\r
    }\r
    return { success: true, elapsed };\r
  } catch (err) {\r
    return { success: false, error: (err && err.message) || String(err) };\r
  } finally {\r
    compileBusy = false;\r
  }\r
}\r
\r
/**\r
 * Finish the boot once the runtime is initialised: load a baked environment snapshot if this host serves\r
 * one, then declare the runtime ready.\r
 *\r
 * The snapshot is why a first Run can be fast at all: it carries the imported \`Init\` environment, so the\r
 * ~100 s import the single-threaded build otherwise pays (FINDINGS.md \xA79.7) never happens \u2014 upstream's\r
 * \`Shell.lean\` says a snapshot "skips the multi-minute \`loadExts\` import entirely". It is optional: a host\r
 * without one still works and simply pays the import.\r
 */\r
async function finishStartup() {\r
  if (typeof Module._lean_wasm_load_snapshot === 'function') {\r
    let bytes = null;\r
    try {\r
      // A dead asset host must not hang the boot. Without a timeout this fetch waits indefinitely, \`ready\` is\r
      // never posted, and the page dies at its own 120 s limit instead of falling back to a first run that\r
      // imports \u2014 which is exactly what a stopped mirror looked like while I was chasing something else.\r
      const response = await fetch(\`\${assetBase}/snapshots/init.snap\`, { signal: AbortSignal.timeout(60000) });\r
      if (response.ok) bytes = new Uint8Array(await response.arrayBuffer());\r
    } catch (error) {\r
      post({ type: 'status', data: \`no Init snapshot fetchable here (\${(error && error.message) || error}); the first run will import\` });\r
      bytes = null;\r
    }\r
    if (bytes) {\r
      try {\r
        Module.FS.writeFile(SNAPSHOT_PATH, bytes);\r
        // The loader reads a dependency sidecar beside the snapshot. A self-contained snapshot's list is\r
        // empty, which is why upstream ships only the snapshot itself and writes the sidecar in the worker.\r
        Module.FS.writeFile(\`\${SNAPSHOT_PATH}.deps\`, new Uint8Array([0x5b, 0x5d]));\r
        // The path must be a \`lean_object*\`, not a JavaScript string. The export's parameter is a Lean\r
        // \`String\`, and a JS string coerces to 0 as an i32 \u2014 so the loader dereferences a bogus pointer and\r
        // traps with "memory access out of bounds" *before* its first line runs. That is a wrong call\r
        // dressed up as a wrong amount of memory, and it cost a 2 GiB rebuild to rule the memory out.\r
        // \`mkLeanString\` is the same marshalling the compile path above uses.\r
        const trace = [];\r
        const outerPrintErr = Module.printErr;\r
        Module.printErr = (line) => {\r
          if (typeof line === 'string' && line.includes('wasmLoadSnapshot')) trace.push(line);\r
          if (typeof outerPrintErr === 'function') outerPrintErr(line);\r
        };\r
        try {\r
          Module._lean_wasm_load_snapshot(mkLeanString(SNAPSHOT_PATH));\r
        } finally {\r
          Module.printErr = outerPrintErr;\r
        }\r
        // The loader prints \`cached env for [\u2026]\` on success and \`failed: \u2026\` on refusal, but that trace does\r
        // not reach \`printErr\` on every path \u2014 so report what is known rather than assert a verdict. A missing\r
        // trace is not a failure: the first run's time is what settles it, and on this build it is ~0.3 s when\r
        // the cache is seeded against ~75 s when it is not.\r
        const megabytes = (bytes.length / 1048576).toFixed(1);\r
        const refused = trace.find((line) => line.includes('failed'));\r
        post({\r
          type: 'status',\r
          data: trace.some((line) => line.includes('cached env for'))\r
            ? \`the loader seeded the environment cache from the Init snapshot (\${megabytes} MB) \u2014 the first run skips the import\`\r
            : refused\r
              ? \`the Init snapshot was refused (\${refused}) \u2014 the first run imports instead\`\r
              : \`Init snapshot handed to the loader (\${megabytes} MB); the first run's time shows whether the cache was seeded\`,\r
        });\r
      } catch (error) {\r
        post({\r
          type: 'status',\r
          data: \`could not install the Init snapshot (\${(error && error.message) || error}); the first run will import\`,\r
        });\r
      }\r
    }\r
  }\r
  moduleReady = true;\r
  post({ type: 'ready' });\r
}\r
\r
async function startLeanModule() {\r
  // A shared memory is only this worker's job when the artifact declares one. A single-threaded build\r
  // declares an unshared memory, which needs no SharedArrayBuffer and therefore no cross-origin\r
  // isolation \u2014 and there is nothing to construct here either, because that memory can grow and\r
  // Emscripten already knows the limits it was built with.\r
  let picked = null;\r
  if (artifactIsThreaded) {\r
    picked = pickMemory();\r
    if (!picked) {\r
      post({\r
        type: 'error',\r
        data:\r
          'The Lean artifact declares a shared WebAssembly memory, and this document has no ' +\r
          'SharedArrayBuffer \u2014 which it would only have if it were cross-origin isolated. Serve the page ' +\r
          'with \`Cross-Origin-Opener-Policy: same-origin\` and \`Cross-Origin-Embedder-Policy: require-corp\` ' +\r
          '(or \`credentialless\`), or, for an embed that cannot set headers, \`Document-Isolation-Policy: ' +\r
          'isolate-and-require-corp\` on the frame itself. A single-threaded Lean build would need none of ' +\r
          'this. See FINDINGS.md \xA72 and \xA79.',\r
      });\r
      return;\r
    }\r
  }\r
\r
  self.Module = {\r
    // Omitted entirely for an unshared artifact, so Emscripten allocates the memory it was built for\r
    // rather than being handed limits guessed from outside.\r
    ...(picked ? { wasmMemory: picked.memory, INITIAL_MEMORY: picked.bytes } : {}),\r
    locateFile: (path) =>\r
      path.endsWith('.wasm') && wasmBlobUrl ? wasmBlobUrl : \`\${assetBase}/\${path}\${assetQ}\`,\r
    // Only a pthread build needs to say where its script is: it spawns sub-workers that have to load it\r
    // same-origin. A single-threaded build has no sub-workers, and a build that does not list\r
    // \`mainScriptUrlOrBlob\` in INCOMING_MODULE_JS_API would rather not be handed an unknown key.\r
    ...(artifactIsThreaded ? { mainScriptUrlOrBlob: \`\${assetBase}/lean.js\${assetQ}\` } : {}),\r
    // In bake mode the CLI owns startup \u2014 Emscripten runs \`main\` as soon as \`onRuntimeInitialized\`\r
    // returns, so this worker must not also initialise the runtime itself, and must not wait for a \`ready\`.\r
    ...(bake\r
      ? { arguments: [\`--incr-header-save=\${bake.snapshotPath}\`, PROBE_PATH], noInitialRun: false }\r
      : { noInitialRun: true }),\r
    print: (text) => {\r
      noteActivity();\r
      if (isDebugLine(text)) return logDebug(text);\r
      post({ type: 'stdout', data: text });\r
    },\r
    printErr: (text) => {\r
      noteActivity();\r
      if (isDebugLine(text)) return logDebug(text);\r
      post({ type: 'stderr', data: text });\r
    },\r
    setStatus: (text) => {\r
      if (text) post({ type: 'status', data: text });\r
    },\r
    noInitialRun: true,\r
    preRun: [\r
      function () {\r
        const FS = Module.FS;\r
        Module.ENV['LEAN_PATH'] = '/lib/lean';\r
        for (const dir of ['/lib', '/lib/lean', '/workspace', '/bin']) {\r
          try {\r
            FS.mkdir(dir);\r
          } catch {\r
            /* exists */\r
          }\r
        }\r
        let errors = 0;\r
        for (const file of libraryFiles) {\r
          try {\r
            writeLibEntry(FS, file.name, file.data);\r
          } catch {\r
            errors += 1;\r
          }\r
        }\r
        post({ type: 'library', stage: 'written', files: libraryFiles.length, errors });\r
        libraryFiles = [];\r
        try {\r
          FS.chdir('/workspace');\r
        } catch {\r
          /* ignore */\r
        }\r
        // The bake needs a file to elaborate, and one that imports nothing: that is what makes it pay the\r
        // default \`Init\` header import, which is exactly the cost the snapshot exists to skip.\r
        if (bake) {\r
          try {\r
            FS.writeFile(PROBE_PATH, bake.probe ?? '#check 2+2');\r
          } catch (error) {\r
            post({ type: 'error', data: 'could not write the bake probe: ' + ((error && error.message) || error) });\r
          }\r
        }\r
      },\r
    ],\r
    onRuntimeInitialized: function () {\r
      // The CLI owns startup in bake mode. Returning from here is what lets Emscripten run \`main\`; doing\r
      // this worker's own init first would initialise the runtime twice.\r
      if (bake) return;\r
      try {\r
        Module._lean_initialize_runtime_module();\r
        Module._lean_initialize();\r
        Module._lean_io_mark_end_initialization();\r
        if (Module._lean_init_task_manager) Module._lean_init_task_manager();\r
        if (Module._lean_enable_initializer_execution) Module._lean_enable_initializer_execution();\r
        const spRes = Module._lean_init_search_path();\r
        if ((Module.getValue(spRes + 7, 'i8') & 0xff) !== 0) {\r
          try {\r
            Module._lean_io_result_show_error(spRes);\r
          } catch {\r
            /* ignore */\r
          }\r
          throw new Error('lean_init_search_path failed (see stderr)');\r
        }\r
        void finishStartup();\r
      } catch (err) {\r
        post({ type: 'error', data: 'Lean init failed: ' + ((err && err.message) || err) });\r
      }\r
    },\r
    onExit: function (code) {\r
      if (!bake) {\r
        moduleReady = false;\r
        post({ type: 'status', data: \`Lean exited (\${code})\` });\r
        return;\r
      }\r
      // The CLI has run, so the snapshot is on the filesystem \u2014 or it is not, which is worth saying\r
      // precisely rather than leaving the caller to time out.\r
      try {\r
        // Copied, not handed over: \`FS.readFile\` answers a view into the wasm heap, and posting that would\r
        // either clone the whole heap or fail, since this artifact defines its memory.\r
        const bytes = new Uint8Array(Module.FS.readFile(bake.snapshotPath));\r
        post({ type: 'snapshot', bytes, code });\r
      } catch (error) {\r
        post({\r
          type: 'error',\r
          data: \`the bake exited (\${code}) without writing \${bake.snapshotPath}: \` + ((error && error.message) || error),\r
        });\r
      }\r
    },\r
    onAbort: function (what) {\r
      moduleReady = false;\r
      post({ type: 'error', data: 'Aborted: ' + (what || 'unknown') });\r
    },\r
  };\r
\r
  // Three separate steps, reported separately. Wrapping all of them in one \`catch\` that said "Failed to\r
  // load lean.js" made a failure to fetch the 97 MB wasm look like a failure to fetch the 48 MB script \u2014\r
  // both fetched from the same base, and the message named only one of them.\r
  try {\r
    // Fetch lean.js ourselves and hand it to the runtime as a **same-origin blob**.\r
    //\r
    // \`importScripts\` itself tolerates a cross-origin script, but this is a pthread\r
    // build: the runtime spawns its thread pool with \`new Worker(mainScriptUrlOrBlob)\`,\r
    // and a worker script must be same-origin. With a cross-origin asset base that\r
    // throws during evaluation, and \`importScripts\` reports it only as\r
    // "the script at \u2026 failed to load" \u2014 with every other asset fetching fine, which\r
    // points at the wrong thing entirely. A blob URL is same-origin, and is what\r
    // \`mainScriptUrlOrBlob\` exists for.\r
    const response = await fetchOrThrow(\`\${assetBase}/lean.js\${assetQ}\`);\r
    if (!response.ok) throw new Error(\`HTTP \${response.status} fetching lean.js\`);\r
    const source = await response.text();\r
    // Kept for the lifetime of the runtime: pthread sub-workers load it lazily.\r
    mainScriptBlob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));\r
    if (artifactIsThreaded) Module.mainScriptUrlOrBlob = mainScriptBlob;\r
  } catch (err) {\r
    post({ type: 'error', data: 'Failed to load lean.js: ' + ((err && err.message) || err) });\r
    return;\r
  }\r
\r
  try {\r
    // Emscripten and every pthread sub-worker instantiate from this same blob URL.\r
    await loadWasmUrl();\r
  } catch (err) {\r
    post({ type: 'error', data: 'Failed to fetch the Lean runtime: ' + ((err && err.message) || err) });\r
    return;\r
  }\r
\r
  try {\r
    // The blob is how lean.js is evaluated here at all \u2014 a threaded build additionally needs it to be\r
    // same-origin for its sub-workers, which a bare \`importScripts\` of a CDN URL would not be.\r
    importScripts(mainScriptBlob);\r
  } catch (err) {\r
    post({ type: 'error', data: 'Failed to evaluate lean.js: ' + ((err && err.message) || err) });\r
  }\r
}\r
\r
self.onmessage = async (event) => {\r
  const msg = event.data || {};\r
  if (msg.type === 'start') {\r
    try {\r
      libraryFiles = await loadLibrary();\r
      await startLeanModule();\r
    } catch (err) {\r
      post({ type: 'error', data: 'Loading the Lean library failed: ' + ((err && err.message) || err) });\r
    }\r
  } else if (msg.type === 'compile') {\r
    post({ type: 'result', id: msg.id, ...compileCode(msg.code, msg.path) });\r
  } else if (msg.type === 'load_modules') {\r
    const results = [];\r
    for (const root of msg.roots || []) {\r
      try {\r
        results.push(await loadRoot(root));\r
      } catch (err) {\r
        results.push({ root, files: 0, bytes: 0, error: (err && err.message) || String(err) });\r
      }\r
    }\r
    post({ type: 'modules_loaded', id: msg.id, roots: msg.roots || [], results });\r
  } else if (msg.type === 'load_layer') {\r
    try {\r
      const result = await loadPackedLayer(msg);\r
      post({ type: 'layer_loaded', id: msg.id, label: msg.label, ok: true, ...result });\r
    } catch (err) {\r
      post({ type: 'layer_loaded', id: msg.id, label: msg.label, ok: false, error: (err && err.message) || String(err) });\r
    }\r
  }\r
};\r
`;async function W({baseUrl:e,probe:r="#check 2+2",onProgress:t,timeoutMs:s=12e5}={}){let n=E(e),a={assetBase:n.assetBase,libBase:n.libBase,bake:{probe:r,snapshotPath:"/workspace/init.snap"}},i=new Worker(URL.createObjectURL(new Blob([`self.__LEAN_WASM_CONFIG__ = ${JSON.stringify(a)};
${R}`],{type:"text/javascript"})));try{return await new Promise((d,h)=>{let f=setTimeout(()=>h(new Error(`the bake did not finish within ${Math.round(s/6e4)} minutes`)),s);i.onmessage=y=>{let u=y.data||{};if(u.type==="snapshot"){clearTimeout(f),d(new Uint8Array(u.bytes));return}if(u.type==="error"){clearTimeout(f),h(new Error(u.data));return}u.type==="status"&&u.data&&t?.(u.data),u.type==="library"&&u.stage==="manifest"?t?.(`core layer: ${u.modules} modules in ${u.packs} packs`):u.type==="library"&&u.stage==="pack"&&t?.(`core pack ${u.loaded}/${u.total}`)},i.onerror=y=>{clearTimeout(f),h(new Error(y.message||"the bake worker failed"))},i.postMessage({type:"start"})})}finally{i.terminate()}}var I=[0,97,115,109],pe=2,ye=5,be=0,we=1,ge=2,ke=3,xe=4,U=1,D=2,L=262144;function z(e,r){return{pos:r,byte(){return this.pos>=e.length?null:e[this.pos++]},u32(){let t=0,s=0;for(;;){if(this.pos>=e.length||s>28)return null;let n=e[this.pos++];if(t|=(n&127)<<s,s+=7,(n&128)===0)return t>>>0}},name(){let t=this.u32();if(t===null||this.pos+t>e.length)return null;let s="";for(let n=0;n<t;n++)s+=String.fromCharCode(e[this.pos+n]);return this.pos+=t,s},skip(t){return this.pos+t>e.length?null:(this.pos+=t,!0)}}}function _e(e,r){let t=e.u32();if(t===null)return null;for(let s=0;s<t;s++){let n=e.name(),a=e.name();if(n===null||a===null)return null;let i=e.byte();if(i===null)return null;if(i===ge){let d=e.u32();if(d===null)return null;let h=e.u32();if(h===null)return null;let f=null;return d&U&&(f=e.u32(),f===null)?null:{module:n,field:a,shared:(d&D)!==0,initial:h,maximum:f}}if(i===be){if(e.u32()===null)return null}else if(i===we){if(e.skip(1)===null)return null;let d=e.u32();if(d===null||e.u32()===null||d&U&&e.u32()===null)return null}else if(i===ke){if(e.skip(2)===null)return null}else if(i===xe){if(e.skip(1)===null||e.u32()===null)return null}else return null;if(e.pos>r)return null}return null}function Se(e){if(!e||e.length<8)return null;for(let t=0;t<I.length;t++)if(e[t]!==I[t])return null;let r=z(e,8);for(;r.pos<e.length;){let t=r.byte(),s=r.u32();if(t===null||s===null)return null;let n=r.pos+s;if(n>e.length)return null;if(t===pe)return _e(r,n);r.pos=n}return null}function $e(e){if(!e||e.length<8)return null;for(let t=0;t<I.length;t++)if(e[t]!==I[t])return null;let r=z(e,8);for(;r.pos<e.length;){let t=r.byte(),s=r.u32();if(t===null||s===null)return null;let n=r.pos+s;if(n>e.length)return null;if(t===ye){let a=r.u32();if(a===null||a===0)return null;let i=r.u32();if(i===null)return null;let d=r.u32();if(d===null)return null;let h=null;return i&U&&(h=r.u32(),h===null)?null:{shared:(i&D)!==0,initial:d,maximum:h}}r.pos=n}return null}function G(e){let r=Se(e);if(r)return{source:"import",...r};let t=$e(e);return t?{source:"defined",...t}:null}var H=L/4;function q(e,r){let t=e.reduce((a,i)=>a+i.length,0),s=new Uint8Array(Math.min(t,r)),n=0;for(let a of e){if(n>=s.length)break;let i=a.subarray(0,Math.min(a.length,s.length-n));s.set(i,n),n+=i.length}return s}async function Ee(e){if(!e.body)return new Uint8Array(await e.arrayBuffer()).subarray(0,L);let r=e.body.getReader(),t=[],s=0,n=H;try{for(;;){let{value:a,done:i}=await r.read();if(i||(t.push(a),s+=a.length,n=Y(t[0])?H:L,s>=n))break}}catch{}finally{r.cancel().catch(()=>{})}return q(t,n)}async function Me(e,r){let t=new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip")).getReader(),s=[],n=0;try{for(;n<r;){let{value:a,done:i}=await t.read();if(i)break;s.push(a),n+=a.length}}catch{}finally{t.cancel().catch(()=>{})}return q(s,r)}function Y(e){return e.length>1&&e[0]===31&&e[1]===139}async function K(e){let r=String(e??"").replace(/\/+$/,""),t=[`${r}/lean.wasm.gz`,`${r}/lean.wasm`];for(let s of t){let n;try{n=await fetch(s)}catch{continue}if(n.status!==404&&n.ok)try{let a=await Ee(n),i=Y(a)?await Me(a,L):a,d=G(i);if(!d)continue;return{mode:d.shared?"shared":"unshared",memory:d,url:s,bytesRead:a.length}}catch{continue}}return null}function Ae(e){return e.startsWith("[DEBUG:")||e.startsWith("mainModule? =")||e.startsWith("- /lib/lean/")||e.startsWith("wasm streaming compile failed:")||e==="falling back to ArrayBuffer instantiation"}function Le(e){let r=e.data;return typeof r=="string"?r:r&&typeof r=="object"?r.msg??r.message??JSON.stringify(r):String(r??"")}function T(e,r){let t=[],s=[],n=0;for(let[a,i]of[["stdout",e],["stderr",r]])for(let d of(i??"").split(`
`)){let h=d.trim();if(!h)continue;if(Ae(h)){n+=1;continue}let f=null;if(h.startsWith("{"))try{f=JSON.parse(h)}catch{f=null}if(f&&typeof f=="object"&&f.severity){let y={severity:f.severity,text:Le(f),pos:f.pos??null};(f.severity==="information"?t:s).push(y)}else{let y={severity:a==="stdout"?"output":"error",text:h,pos:null};(a==="stdout"?t:s).push(y)}}return{info:t,problems:s,noise:n}}function X(e){let r=/\(line \d+, col \d+\)|at line \d+, column \d+/;return e.map(({severity:t,text:s,pos:n})=>{let a=String(s).replace(/\u001b\[[0-9;]*m/g,""),i=n?.line!=null&&!r.test(a)?`  (line ${n.line}${n.column!=null?`, col ${n.column}`:""})`:"";return t==="output"?a:`${t}: ${a}${i}`})}var P=["Std","Lean","Batteries"];function M(e){return[{label:"Mathlib",manifestUrl:`${e.layerBase}/real-analysis-layer.json`,packBase:e.layerBase,roots:["Mathlib","Aesop","Qq","Plausible","ProofWidgets","ImportGraph","LeanSearchClient","Game"]}]}var J={Lake:"Lake is a build tool, and there is no build step here."};function Q(e){return e.replace(/\/-[\s\S]*?-\//g,"").replace(/--[^\n]*/g,"")}function N(e){let r=[];for(let t of Q(e).split(`
`)){let s=/^\s*import\s+([A-Za-z0-9_'.]+)/.exec(t);if(!s)continue;let n=s[1].replace(/^'/,"").split(".")[0];n&&!r.includes(n)&&r.push(n)}return r}function V(e){return Q(e).split(`
`).filter(r=>/^\s*import\s+\S/.test(r)).map(r=>r.trim()).join(`
`)}function Z(e){let r=[];for(let t of e){let s=/unknown module prefix '([^']+)'/.exec(t.text);s&&!r.includes(s[1])&&r.push(s[1])}return r}function ee(e){return[...P,...M(e).flatMap(r=>r.roots)]}function Be(e,r){return P.includes(e)||M(r).some(t=>t.roots.includes(e))?"lean-wasm-fetch-assets":null}function re(e,r,t){let s=[],n=a=>{s.includes(a)||s.push(a)};for(let a of N(e))if(r.includes(a)){let i=Be(a,t);n(i?`${a} is not on the asset host. Mirror it with \`${i}\`.`:`${a} is not available here.`)}else J[a]&&n(J[a]);return s}function te(e){let r=[];for(let t of e){let s=/object file '[^']*' of module (\S+)/.exec(t.text);if(!s)continue;let n=`${s[1]} is not in the published Mathlib closure. Upstream ships only the 4,303 modules its Real Analysis course needs, so some of Mathlib is available here and some is not.`;r.includes(n)||r.push(n)}return r}var ve="/workspace/input.lean";function Re(e){return`self.__LEAN_WASM_CONFIG__ = ${JSON.stringify(e)};
${R}`}function ne({assetBase:e,libBase:r,memory:t,onProgress:s,onStatus:n}){let a=null,i=null,d="",h="",f=1,y=[],u=c=>{c&&s?.(c)};function B(c){let o=c.data||{};switch(o.type){case"stdout":d+=o.data+`
`;return;case"stderr":h+=o.data+`
`;return;case"status":n?.(o.data);return;case"memory":u(o.failed?`shared memory: ${o.mb} MB refused, trying a smaller one`:`shared memory: ${o.mb} MB (max ${o.maximumPages} pages)`);return;case"library":o.stage==="manifest"?u(`core layer: ${o.modules} modules in ${o.packs} packs`):o.stage==="pack"?u(`core pack ${o.loaded}/${o.total}`):o.stage==="written"&&u(`${o.files} library files installed`);return;case"modules":o.stage==="progress"&&u(`loading ${o.root}: ${o.files}/${o.total} files`);return;case"layer":o.stage==="progress"&&u(`loading ${o.label}: pack ${o.pack}/${o.packs}`);return;default:break}for(let _ of[...y])_.match(o)&&(y.splice(y.indexOf(_),1),clearTimeout(_.timer),_.resolve(o));o.type==="error"&&A(new Error(o.data))}function A(c){for(let o of y.splice(0))clearTimeout(o.timer),o.reject(c)}function l(c,o,_){return new Promise((k,v)=>{let x={match:c,resolve:k,reject:v,timer:null};x.timer=setTimeout(()=>{let F=y.indexOf(x);F>=0&&y.splice(F,1),v(new Error(`${o} timed out after ${Math.round(_/1e3)}s`))},_),y.push(x)})}function m(c){if(!a)throw new Error("The Lean runtime is not running.");a.postMessage(c)}async function b(){a=new Worker(URL.createObjectURL(new Blob([Re({assetBase:e,libBase:r,memory:t})],{type:"text/javascript"}))),a.onmessage=B,a.onerror=c=>A(new Error(c.message||"Lean runtime error")),m({type:"start"}),await l(c=>c.type==="ready","Starting the Lean runtime",12e4)}async function w(c){let o=f++;return m({type:"load_modules",id:o,roots:c}),(await l(k=>k.type==="modules_loaded"&&k.id===o,`Loading ${c.join(", ")}`,3e5)).results??[]}async function g(c){let o=f++;return m({type:"load_layer",id:o,label:c.label,manifestUrl:c.manifestUrl,packBase:c.packBase}),await l(k=>k.type==="layer_loaded"&&k.label===c.label,`Loading ${c.label}`,6e5)}async function p(c){let o=f++;return d="",h="",m({type:"compile",id:o,code:c,path:ve}),{...await l(k=>k.type==="result"&&k.id===o,"Compiling",6e5),stdout:d,stderr:h}}function $(){A(new Error("The compiler was disposed.")),a?.terminate(),a=null,i&&(URL.revokeObjectURL(i),i=null)}return{start:b,loadModules:w,loadLayer:g,compile:p,dispose:$}}function Ie(e){return`"${String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n").replace(/\r/g,"\\r").replace(/\t/g,"\\t").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"").replace(/\u2028|\u2029/g," ")}"`}var se=/syntax error at line \d+, column \d+/;function ae(e){let r=V(e);return`${r?r+`
`:""}import Lean
open Lean

run_cmd do
  let src := ${Ie(e)}
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
`}var Te=8,oe=["auto","full","off"];function Pe(){if(typeof Worker!="function"||typeof Blob!="function")throw new Error("@live-codes/lean-wasm runs in a browser: the Lean runtime is a Web Worker, and it is handed over as a blob so that it stays same-origin.")}function Oe(){try{return new WebAssembly.Memory({initial:1,maximum:2,shared:!0}),!0}catch{return!1}}function Ue(e){if(e?.mode==="shared"&&!Oe())throw new Error(`The Lean artifact at ${e.url} declares a shared WebAssembly memory, and this browser will not construct one here. Serve the page with \`Cross-Origin-Opener-Policy: same-origin\` and \`Cross-Origin-Embedder-Policy: require-corp\` (or \`credentialless\`); an embed that cannot set those headers can isolate its own frame with \`Document-Isolation-Policy: isolate-and-require-corp\` instead. A single-threaded Lean build would need none of this \u2014 see FINDINGS.md \xA72 and \xA79.`)}function Ne(e){if(!e)return"artifact: the memory import could not be read, so a shared memory is assumed";let{initial:r,maximum:t}=e.memory,s=`min ${r} pages, ${t===null?"no maximum":`max ${t} pages`}`;return e.mode==="unshared"?`artifact: unshared memory (${s}) \u2014 no cross-origin isolation needed`:`artifact: shared memory (${s}) \u2014 this needs SharedArrayBuffer`}async function ie(e={}){Pe();let r=E(e.baseUrl),t=e.syntaxCheck??"auto";if(!oe.includes(t))throw new Error(`syntaxCheck must be one of ${oe.join(", ")}, not ${t}`);let s=M(r),n=await K(r.assetBase),a={memory:n?.mode??"unknown",limits:n?.memory??null,url:n?.url??null};e.onArtifact?.(a),Ue(n),e.onProgress?.(Ne(n));let i=n?{mode:n.mode,...n.memory}:null,d=ne({assetBase:r.assetBase,libBase:r.libBase,memory:i,onProgress:e.onProgress,onStatus:e.onStatus}),h=new Set,f=new Set;await d.start();function y(l,m){if(l.files>0){h.add(l.root),m.loaded.push(`${l.root} (${l.files} files${l.failed?`, ${l.failed} failed`:""})`);return}if(l.alreadyLoaded){h.add(l.root);return}m.notMirrored.includes(l.root)||m.notMirrored.push(l.root)}async function u(l,m){let b=l.filter(p=>!m.attempted.has(p));if(b.length===0)return!1;b.forEach(p=>m.attempted.add(p));let w=!1;for(let p of s){if(!b.some(c=>p.roots.includes(c))||m.layers.has(p.label))continue;m.layers.add(p.label);let $=await d.loadLayer(p);$.ok?(f.add(p.label),$.alreadyLoaded||(m.loaded.push(`${p.label} layer (${$.files} files)`),w=!0)):m.notMirrored.includes(p.label)||m.notMirrored.push(p.label)}let g=b.filter(p=>P.includes(p));if(g.length>0)for(let p of await d.loadModules(g))y(p,m),p.files>0&&(w=!0);return w}async function B(l,m){await u(N(l),m);let b=await d.compile(l);for(let w=0;w<Te;w++){let{problems:g}=T(b.stdout,b.stderr);if(!await u(Z(g),m))break;b=await d.compile(l)}return b}async function A(l,m){let b=await B(ae(l),m),{problems:w}=T(b.stdout,b.stderr);return w.filter(g=>se.test(g.text))}return{language:"lean",assets:r,artifact:a,async run(l,m,b={}){if(typeof l!="string")throw new Error("run() needs the program source as its first argument.");let w=b.syntaxCheck??t,g={attempted:new Set,layers:new Set,loaded:[],notMirrored:[]},p=performance.now(),$=await B(l,g),{info:c,problems:o,noise:_}=T($.stdout,$.stderr);if(w!=="off"&&l.trim()!==""&&!o.some(x=>x.severity==="error")){let x=h.has("Lean")||f.size>0;(w==="full"||x)&&o.push(...await A(l,g))}let k=o.some(x=>x.severity==="error")||$.success===!1,v=k?[...re(l,g.notMirrored,r),...te(o)]:[];return{output:c.map(x=>x.text).join(`
`),errors:[...X(o),...v.map(x=>`note: ${x}`)],exitCode:k?1:0,noise:_,libraries:g.loaded,compileMs:Math.round(performance.now()-p)}},dispose(){d.dispose()}}}var Fe=["lean"],Ce=["auto","full","off"];function je(e){return ee(e??E())}function We(e){return M(e??E())}return fe(De);})();
