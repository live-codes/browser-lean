/*! @live-codes/lean-wasm - MIT. IIFE build, sets self.leanWasm.
 *  importScripts('lean-wasm.global.js') then self.leanWasm.createCompiler({ baseUrl }).
 *  Runs Lean 4 (Apache-2.0) compiled to WebAssembly by cauli/lean4-wasm-in-browser (Apache-2.0);
 *  no third-party JavaScript is bundled. */
var leanWasm=(()=>{var U=Object.defineProperty;var de=Object.getOwnPropertyDescriptor;var he=Object.getOwnPropertyNames;var ue=Object.prototype.hasOwnProperty;var me=(e,t)=>{for(var n in t)U(e,n,{get:t[n],enumerable:!0})},fe=(e,t,n,a)=>{if(t&&typeof t=="object"||typeof t=="function")for(let r of he(t))!ue.call(e,r)&&r!==n&&U(e,r,{get:()=>t[r],enumerable:!(a=de(t,r))||a.enumerable});return e};var pe=e=>fe(U({},"__esModule",{value:!0}),e);var Ge={};me(Ge,{DEFAULT_BASE_URL:()=>j,LANGUAGES:()=>ze,SYNTAX_MODES:()=>je,availableRoots:()=>We,bakeSnapshot:()=>D,createCompiler:()=>ce,layers:()=>De,requiredAssetPaths:()=>W,resolveAssets:()=>_});var j=void 0,$={wasm:"lean-wasm",lib:"lean-lib",mathlib:"lean-mathlib"};function ye(e,t){let n;try{n=new URL(e,globalThis.location?.href)}catch{throw new Error(`${t} must be an absolute http(s) URL, or relative to the page: ${e}`)}if(n.protocol!=="http:"&&n.protocol!=="https:")throw new Error(`${t} must be http or https, not ${n.protocol}//`);return n}function _(e){let t=e??void 0;if(t==null||t==="")throw new Error("baseUrl is required: this package ships no assets (Lean\u2019s wasm is 96.2 MiB, past the 20 MB per-file limit on jsDelivr), so the runtime is fetched from a host you control. Run `npx --package @live-codes/lean-wasm lean-wasm-fetch-assets <dir>` to materialise them, then pass that directory as baseUrl.");let n=ye(t,"baseUrl").href.replace(/\/+$/,""),a=r=>`${n}/${r}`;return{baseUrl:`${n}/`,assetBase:a($.wasm),libBase:a($.lib),layerBase:a($.mathlib)}}function W(){return[`${$.wasm}/lean.js`,`${$.wasm}/lean.wasm`,`${$.wasm}/core-layer.json`,`${$.wasm}/core-lib/artifacts-*.pack`,`${$.wasm}/snapshots/*.snap.gz`,`${$.lib}/lean-lib-files.json`,`${$.lib}/**`,`${$.mathlib}/real-analysis-layer.json`,`${$.mathlib}/artifacts-*.pack`]}var R=`/**
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
 * Whether it needs a cross-origin isolated document is the artifact's decision, not this file's. The
 * probe in @live-codes/lean-wasm reads the memory import off the module before the download, and a
 * single-threaded build \u2014 one that declares an unshared memory \u2014 runs here with no isolation at all
 * (FINDINGS.md \xA79). The pthread build the project ships today does need it.
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

// What the artifact declares about its memory, read by \`probeArtifactMemory\` in @live-codes/lean-wasm and
// handed in as configuration \u2014 the worker cannot ask, because it holds the whole module and the answer
// has to arrive before the download (FINDINGS.md \xA72).
//
//   {mode: 'shared',   initial, maximum}  a pthread build: it needs SharedArrayBuffer, and the memory
//                                         this worker constructs must match the declared limits
//   {mode: 'unshared', initial, maximum}  a single-threaded build: no SharedArrayBuffer, no isolation,
//                                         and no memory for this worker to construct at all
//   null                                  the probe could not read the artifact, so the runtime does
//                                         what it did before it could ask and assumes \`shared\`
const declaredMemory = workerConfig.memory ?? null;
const artifactIsThreaded = declaredMemory?.mode !== 'unshared';

// Bake mode: run the runtime **as the Lean CLI** to produce an \`--incr-header-save\` environment snapshot,
// rather than booting the playground. The snapshot takes the \`Init\` import out of the first Run, which on
// the single-threaded build is ~100 s against ~1.3 s for the pthread build (FINDINGS.md \xA79.7), and it has
// to be produced by the binary that will load it \u2014 a snapshot embeds closure relocations valid only
// against the saving binary's function table.
//
// It cannot share a session with compiling: the CLI parses its own arguments and the runtime exits when it
// is done (\`-sEXIT_RUNTIME=1\`). See \`packages/lean-wasm/src/bake.js\`.
const bake = workerConfig.bake ?? null;
// Where the bake writes its probe, and where a snapshot is written when one is loaded at boot. Both live
// inside the virtual filesystem; \`/workspace\` is created in \`preRun\` either way.
const PROBE_PATH = '/workspace/probe.lean';
const SNAPSHOT_PATH = '/workspace/init.snap';

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
 * cross-origin isolation \u2014 and it is only needed when the artifact declares one.
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
 * cannot produce that mismatch \u2014 it only has to stay under the ceiling.
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
 * \`fetch\` reports a network failure as a bare \`TypeError: Failed to fetch\`, which says nothing about which
 * of several URLs it was \u2014 and this worker fetches several. Naming the URL here is the difference between
 * a five-second diagnosis and an afternoon.
 */
async function fetchOrThrow(url) {
  try {
    return await fetch(url);
  } catch (error) {
    throw new Error(\`\${url}: \${error && error.name ? error.name + ' \u2014 ' : ''}\${(error && error.message) || error}\`);
  }
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
    // A timeout for the same reason the snapshots have one: a host that accepts the connection and then says
    // nothing hangs the boot with no message at all, which reads exactly like a very slow start.
    const response = await fetch(candidate, { signal: AbortSignal.timeout(60000) });
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
  const build = await checkBuildIdentity('the core layer', manifest);
  post({
    type: 'library',
    stage: 'manifest',
    modules: manifest.modules,
    packs: manifest.packs.length,
    // Handed to the compiler so its "mirror it" note can say *which* build to mirror. The worker's own
    // status line reports the mismatch; this is the same fact, at the point where it changes the advice.
    build: build ? { artifact: build.artifact, core: build.core } : null
  });

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

// ---- Build identity -----------------------------------------------------
//
// Every asset in a mirror is built by one Lean commit, and nothing enforces it. A mismatch is silent:
// an \`.olean\` written by another compiler may be refused deep in the kernel, a snapshot baked against
// another binary is simply ignored, and either way the visible symptom is "slow" rather than "wrong".
//
// Three things name a build: the artifact (\`lean-wasm/LEAN_COMMIT\`, written by build.sh and copied by
// assemble-upstream-mirror.mjs), the core layer's manifest, and a packed layer's manifest. Compare
// them as they arrive and post one line per disagreeing pair. This is a diagnostic, not a gate: the
// run still proceeds, because a mismatch has to be *seen* rather than turned into another failure.

const reportedBuildMismatches = new Set();
// \`undefined\` = not asked yet, \`null\` = not published (upstream's mirror has no such file).
let artifactCommit;

/** The commit a manifest names, as 40 lowercase hex characters, or null. */
function commitOf(manifest) {
  const direct = typeof manifest?.leanCommit === 'string' ? manifest.leanCommit.toLowerCase() : '';
  if (/^[0-9a-f]{40}$/.test(direct)) return direct;
  // Older manifests carry it only inside \`version\`: "lean-core-62b6a22913" or
  // "lean-4.33.0-pre-62b6a229-real-analysis". The run is a prefix of the commit, not the whole hash.
  const version = typeof manifest?.version === 'string' ? manifest.version : '';
  const run = version.match(/[0-9a-f]{10,40}/i)?.[0];
  return run ? run.toLowerCase() : null;
}

const shortCommit = (commit) => commit.slice(0, 12);

async function getArtifactCommit() {
  if (artifactCommit !== undefined) return artifactCommit;
  artifactCommit = null;
  try {
    const response = await fetch(\`\${assetBase}/LEAN_COMMIT\`);
    if (!response.ok) return artifactCommit;
    const text = (await response.text()).trim().toLowerCase();
    if (/^[0-9a-f]{40}$/.test(text)) artifactCommit = text;
  } catch {
    // The identity is a diagnostic, never a requirement: an old mirror without this file still runs.
  }
  return artifactCommit;
}

let coreCommit = null;

/**
 * Compare the artifact, the core layer and a packed layer, and report each disagreeing pair once.
 *
 * \`kind\` is the human name of the thing \`manifest\` describes (\`the core layer\`, \`Mathlib\`). Only
 * mismatches are posted, so a matched mirror stays quiet.
 */
async function checkBuildIdentity(kind, manifest) {
  const layerCommit = commitOf(manifest);
  if (!layerCommit) return null;
  if (kind === 'the core layer') coreCommit = layerCommit;

  const artifact = await getArtifactCommit();
  const pairs = [];
  if (artifact && artifact !== layerCommit) {
    pairs.push([
      \`build mismatch: the Lean artifact is \${shortCommit(artifact)}, but \${kind} was built by \` +
        \`\${shortCommit(layerCommit)}. Object files and snapshots are per-build, so this layer may be \` +
        \`refused or misread \u2014 rebuild the artifact at \${shortCommit(layerCommit)} \` +
        \`(wasm-build/build-upstream.sh) or serve a layer built by \${shortCommit(artifact)}.\`,
      \`artifact:\${artifact}:\${layerCommit}\`
    ]);
  }
  if (kind !== 'the core layer' && coreCommit && coreCommit !== layerCommit) {
    pairs.push([
      \`build mismatch: the core layer is \${shortCommit(coreCommit)}, but \${kind} is \` +
        \`\${shortCommit(layerCommit)}. The two cannot be loaded in one session; mirror both from the \` +
        \`same Lean build.\`,
      \`core:\${coreCommit}:\${layerCommit}\`
    ]);
  }

  for (const [message, key] of pairs) {
    if (reportedBuildMismatches.has(key)) continue;
    reportedBuildMismatches.add(key);
    post({ type: 'status', data: message });
  }

  return { artifact, core: coreCommit, layer: kind === 'the core layer' ? null : layerCommit };
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
 * Supplying one library root: a baked snapshot when there is one for it, otherwise every published file of
 * it, one file at a time.
 *
 * No dependency graph is computed either way: the page retries the compile after each load, and Lean's own
 * "unknown module prefix" error names the next root that is missing, so the closure is discovered by asking
 * the compiler.
 */
/**
 * Fetch a baked snapshot, preferring the gzipped layout.
 *
 * A snapshot is by far the largest thing a mirror serves (Mathlib's is 408 MB), and it is mostly
 * repetitive environment data: gzip takes the four snapshots from 946 MB to 390 MB (2.4\xD7). The wasm
 * already arrives through the same \`DecompressionStream\` path, so this is one more probe and one more
 * \`gunzip\`, not a new transport. A host that only has the plain layout keeps working; the \`.gz\` probe
 * 404s and the fallback is the old file.
 *
 * The timeout is longer than the wasm's: 177 MB over a slow link is not a dead host.
 */
async function fetchSnapshot(name, label) {
  const candidates = [
    [\`\${assetBase}/snapshots/\${name}.snap.gz\`, 'gzip'],
    [\`\${assetBase}/snapshots/\${name}.snap\`, 'plain']
  ];
  for (const [url, layout] of candidates) {
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    } catch {
      continue;
    }
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(\`\${url}: HTTP \${response.status}\`);
    post({ type: 'status', data: \`fetching the \${label} snapshot (\${layout})\u2026\` });
    let bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    return { bytes, layout };
  }
  return null;
}

/**
 * Try a baked snapshot for this root before its per-file tree.
 *
 * On a single-threaded build the *import* dominates, not the bytes: measured on the Std demo, fetching its
 * 483 modules' 1,449 files takes 5 s and loading them takes 104 s. A snapshot turns that import into a
 * deserialization. The loader reports its verdict on stderr \u2014 \`cached env for [...]\`, or \`failed: ...\` \u2014 and
 * that is the only signal worth trusting; its return value is an IO result whose layout is not ours to guess.
 *
 * Returns null when there is no snapshot for this root or it was refused, and the caller falls through to
 * the tree \u2014 which stays the general path, because a snapshot only matches the header it was baked for.
 */
async function tryRootSnapshot(root) {
  const started = performance.now();
  const name = root.toLowerCase();
  let bytes = null;
  let layout = 'plain';
  try {
    const found = await fetchSnapshot(name, root);
    if (!found) return null;
    bytes = found.bytes;
    layout = found.layout;
  } catch {
    return null;
  }
  if (!bytes) return null;

  const path = \`/workspace/\${name}.snap\`;
  const trace = [];
  const outerPrintErr = Module.printErr;
  Module.printErr = (line) => {
    if (typeof line === 'string' && line.includes('wasmLoadSnapshot')) trace.push(line);
    if (typeof outerPrintErr === 'function') outerPrintErr(line);
  };
  // Three steps, reported separately. A single \`catch { return null }\` made a failed install indistinguishable
  // from no snapshot at all: the page silently took the file tree, and a run that had measured 13 s came back
  // at 61 s with nothing to explain the difference. If a step fails, say which and why.
  let failure = null;
  let resultTag = null;
  const megabytes = (bytes.length / 1048576).toFixed(1);
  try {
    Module.FS.writeFile(path, bytes);
    Module.FS.writeFile(\`\${path}.deps\`, new Uint8Array([0x5b, 0x5d]));
    // Deserialization is synchronous and single-threaded, so this is the last chance to say anything before
    // it runs. Mathlib's 408 MB environment takes ~150 s; without this line the page looks dead for that
    // whole time, which is exactly what P2-1 of the handover is about.
    post({
      type: 'status',
      data: \`installing the \${root} snapshot (\${megabytes} MB) \u2014 deserialization runs on one thread\u2026\`
    });
    try {
      // The file tree is still fetched afterwards, and that is not a fallback: the program's header has to
      // *resolve* the module it imports, and a snapshot only supplies the elaborated environment for that
      // header. What the snapshot removes is the realization \u2014 the 104 s, not the 5 s.
      const result = Module._lean_wasm_load_snapshot(mkLeanString(path));
      try {
        resultTag = Module.getValue(result + 7, 'i8') & 0xff;
      } catch {
        resultTag = 'unreadable';
      }
    } catch (error) {
      failure = \`the loader threw: \${(error && error.message) || error}\`;
    }
  } catch (error) {
    failure = \`writing it into the file system failed: \${(error && error.message) || error}\`;
  } finally {
    Module.printErr = outerPrintErr;
  }

  const refused = trace.find((line) => line.includes('failed'));
  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  // The loader returns an IO result; its ctor tag sits at +7, the same layout the compile path reads.
  const verdict = resultTag === 0 ? 'loader returned 0 (ok)' : \`loader returned \${resultTag}\`;
  post({
    type: 'status',
    data: failure
      ? \`could not install the \${root} snapshot (\${megabytes} MB after \${elapsed}s): \${failure} \u2014 the file tree follows\`
      : refused
        ? \`the \${root} snapshot was refused (\${refused}) after \${elapsed}s \u2014 the file tree follows\`
        : \`handed the \${root} snapshot to the loader (\${megabytes} MB\${layout === 'gzip' ? ', gzip' : ''} in \${elapsed}s; \${verdict}\${trace[0] ? \`; \${trace[0].slice(0, 160)}\` : ''}) \u2014 the file tree follows either way\`
  });
  return null;
}

async function loadRoot(root) {
  if (loadedRoots.has(root)) return { root, files: 0, bytes: 0, alreadyLoaded: true };

  const fromSnapshot = await tryRootSnapshot(root);
  if (fromSnapshot) {
    loadedRoots.add(root);
    return fromSnapshot;
  }

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

  // The manifest first, and the snapshot only after it. The snapshot is the expensive part (Mathlib's is
  // 408 MB and takes ~170 s to deserialize); if the layer is not published at all, loading it only to fail
  // on the missing packs wastes that time. The packs are required regardless, because the program's header
  // must resolve its imports.
  const manifest = await (await fetch(manifestUrl)).json();
  if (!manifest.packs || !Array.isArray(manifest.packs)) {
    throw new Error(\`\${label}: manifest has no packs\`);
  }
  const build = await checkBuildIdentity(label, manifest);

  // A baked snapshot for this layer's header. It supplies the elaborated environment; the packs supply the
  // oleans the header must resolve. It falls through either way, because the packs are needed regardless.
  await tryRootSnapshot(label);

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
  post({
    type: 'layer',
    stage: 'loaded',
    label,
    files,
    bytes,
    build: build ? { artifact: build.artifact, core: build.core, layer: build.layer } : null
  });
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
 * The snapshot is why a first Run can be fast at all: it carries the imported \`Init\` environment, so the
 * ~100 s import the single-threaded build otherwise pays (FINDINGS.md \xA79.7) never happens \u2014 upstream's
 * \`Shell.lean\` says a snapshot "skips the multi-minute \`loadExts\` import entirely". It is optional: a host
 * without one still works and simply pays the import.
 */
async function finishStartup() {
  if (typeof Module._lean_wasm_load_snapshot === 'function') {
    const snapshotStarted = performance.now();
    let bytes = null;
    let layout = 'plain';
    try {
      // A dead asset host must not hang the boot. Without a timeout this fetch waits indefinitely, \`ready\` is
      // never posted, and the page dies at its own 120 s limit instead of falling back to a first run that
      // imports \u2014 which is exactly what a stopped mirror looked like while I was chasing something else.
      const found = await fetchSnapshot('init', 'Init');
      if (found) {
        bytes = found.bytes;
        layout = found.layout;
      }
    } catch (error) {
      post({ type: 'status', data: \`no Init snapshot fetchable here (\${(error && error.message) || error}); the first run will import\` });
      bytes = null;
    }
    if (bytes) {
      try {
        Module.FS.writeFile(SNAPSHOT_PATH, bytes);
        // The loader reads a dependency sidecar beside the snapshot. A self-contained snapshot's list is
        // empty, which is why upstream ships only the snapshot itself and writes the sidecar in the worker.
        Module.FS.writeFile(\`\${SNAPSHOT_PATH}.deps\`, new Uint8Array([0x5b, 0x5d]));
        // The path must be a \`lean_object*\`, not a JavaScript string. The export's parameter is a Lean
        // \`String\`, and a JS string coerces to 0 as an i32 \u2014 so the loader dereferences a bogus pointer and
        // traps with "memory access out of bounds" *before* its first line runs. That is a wrong call
        // dressed up as a wrong amount of memory, and it cost a 2 GiB rebuild to rule the memory out.
        // \`mkLeanString\` is the same marshalling the compile path above uses.
        const trace = [];
        const outerPrintErr = Module.printErr;
        Module.printErr = (line) => {
          if (typeof line === 'string' && line.includes('wasmLoadSnapshot')) trace.push(line);
          if (typeof outerPrintErr === 'function') outerPrintErr(line);
        };
        try {
          Module._lean_wasm_load_snapshot(mkLeanString(SNAPSHOT_PATH));
        } finally {
          Module.printErr = outerPrintErr;
        }
        // The loader prints \`cached env for [\u2026]\` on success and \`failed: \u2026\` on refusal, but that trace does
        // not reach \`printErr\` on every path \u2014 so report what is known rather than assert a verdict. A missing
        // trace is not a failure: the first run's time is what settles it, and on this build it is ~0.3 s when
        // the cache is seeded against ~75 s when it is not.
        const megabytes = (bytes.length / 1048576).toFixed(1);
        const elapsed = ((performance.now() - snapshotStarted) / 1000).toFixed(1);
        const refused = trace.find((line) => line.includes('failed'));
        post({
          type: 'status',
          data: trace.some((line) => line.includes('cached env for'))
            ? \`the loader seeded the environment cache from the Init snapshot (\${megabytes} MB\${layout === 'gzip' ? ', gzip' : ''} in \${elapsed}s) \u2014 the first run skips the import\`
            : refused
              ? \`the Init snapshot was refused (\${refused}) \u2014 the first run imports instead\`
              : \`Init snapshot handed to the loader (\${megabytes} MB\${layout === 'gzip' ? ', gzip' : ''} in \${elapsed}s); the first run's time shows whether the cache was seeded\`,
        });
      } catch (error) {
        post({
          type: 'status',
          data: \`could not install the Init snapshot (\${(error && error.message) || error}); the first run will import\`,
        });
      }
    }
  }
  moduleReady = true;
  post({ type: 'ready' });
}

/**
 * Fetch the JavaScript glue, preferring the gzipped layout.
 *
 * \`lean.js\` is 45.8 MB, almost all of it a repetitive export table, and gzip takes it to 2.4 MB (20.4\xD7).
 * It is fetched here rather than by \`importScripts\` so a compressed host stays one download; that also
 * makes \`.js.gz\` a one-line addition rather than a host header. The plain file stays as the fallback.
 */
async function loadLeanScript() {
  const candidates = [
    [\`\${assetBase}/lean.js.gz\`, 'gzip'],
    [\`\${assetBase}/lean.js\${assetQ}\`, 'plain']
  ];
  for (const [url, layout] of candidates) {
    const response = await fetchOrThrow(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(\`HTTP \${response.status} fetching \${url}\`);
    let bytes = new Uint8Array(await response.arrayBuffer());
    const transferBytes = bytes.length;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await gunzip(bytes);
    return { source: new TextDecoder().decode(bytes), layout, transferBytes, decodedBytes: bytes.length };
  }
  throw new Error(\`No lean.js (or lean.js.gz) at \${assetBase}\`);
}

async function startLeanModule() {
  // A shared memory is only this worker's job when the artifact declares one. A single-threaded build
  // declares an unshared memory, which needs no SharedArrayBuffer and therefore no cross-origin
  // isolation \u2014 and there is nothing to construct here either, because that memory can grow and
  // Emscripten already knows the limits it was built with.
  let picked = null;
  if (artifactIsThreaded) {
    picked = pickMemory();
    if (!picked) {
      post({
        type: 'error',
        data:
          'The Lean artifact declares a shared WebAssembly memory, and this document has no ' +
          'SharedArrayBuffer \u2014 which it would only have if it were cross-origin isolated. Serve the page ' +
          'with \`Cross-Origin-Opener-Policy: same-origin\` and \`Cross-Origin-Embedder-Policy: require-corp\` ' +
          '(or \`credentialless\`), or, for an embed that cannot set headers, \`Document-Isolation-Policy: ' +
          'isolate-and-require-corp\` on the frame itself. A single-threaded Lean build would need none of ' +
          'this. See FINDINGS.md \xA72 and \xA79.',
      });
      return;
    }
  }

  self.Module = {
    // Omitted entirely for an unshared artifact, so Emscripten allocates the memory it was built for
    // rather than being handed limits guessed from outside.
    ...(picked ? { wasmMemory: picked.memory, INITIAL_MEMORY: picked.bytes } : {}),
    locateFile: (path) =>
      path.endsWith('.wasm') && wasmBlobUrl ? wasmBlobUrl : \`\${assetBase}/\${path}\${assetQ}\`,
    // Only a pthread build needs to say where its script is: it spawns sub-workers that have to load it
    // same-origin. A single-threaded build has no sub-workers, and a build that does not list
    // \`mainScriptUrlOrBlob\` in INCOMING_MODULE_JS_API would rather not be handed an unknown key.
    ...(artifactIsThreaded ? { mainScriptUrlOrBlob: \`\${assetBase}/lean.js\${assetQ}\` } : {}),
    // In bake mode the CLI owns startup \u2014 Emscripten runs \`main\` as soon as \`onRuntimeInitialized\`
    // returns, so this worker must not also initialise the runtime itself, and must not wait for a \`ready\`.
    ...(bake
      ? { arguments: [\`--incr-header-save=\${bake.snapshotPath}\`, PROBE_PATH], noInitialRun: false }
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
        // default \`Init\` header import, which is exactly the cost the snapshot exists to skip.
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
      // The CLI owns startup in bake mode. Returning from here is what lets Emscripten run \`main\`; doing
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
        post({ type: 'status', data: \`Lean exited (\${code})\` });
        return;
      }
      // The CLI has run, so the snapshot is on the filesystem \u2014 or it is not, which is worth saying
      // precisely rather than leaving the caller to time out.
      try {
        // Copied, not handed over: \`FS.readFile\` answers a view into the wasm heap, and posting that would
        // either clone the whole heap or fail, since this artifact defines its memory.
        const bytes = new Uint8Array(Module.FS.readFile(bake.snapshotPath));
        post({ type: 'snapshot', bytes, code });
      } catch (error) {
        post({
          type: 'error',
          data: \`the bake exited (\${code}) without writing \${bake.snapshotPath}: \` + ((error && error.message) || error),
        });
      }
    },
    onAbort: function (what) {
      moduleReady = false;
      post({ type: 'error', data: 'Aborted: ' + (what || 'unknown') });
    },
  };

  // Three separate steps, reported separately. Wrapping all of them in one \`catch\` that said "Failed to
  // load lean.js" made a failure to fetch the 97 MB wasm look like a failure to fetch the 48 MB script \u2014
  // both fetched from the same base, and the message named only one of them.
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
    const script = await loadLeanScript();
    post({
      type: 'status',
      data:
        \`lean.js: \${(script.transferBytes / 1048576).toFixed(1)} MB\` +
        (script.layout === 'gzip' ? \` gzipped (\${(script.decodedBytes / 1048576).toFixed(1)} MB unpacked)\` : '')
    });
    // Kept for the lifetime of the runtime: pthread sub-workers load it lazily.
    mainScriptBlob = URL.createObjectURL(new Blob([script.source], { type: 'text/javascript' }));
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
    // The blob is how lean.js is evaluated here at all \u2014 a threaded build additionally needs it to be
    // same-origin for its sub-workers, which a bare \`importScripts\` of a CDN URL would not be.
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
`;async function D({baseUrl:e,probe:t="#check 2+2",onProgress:n,timeoutMs:a=12e5}={}){let r=_(e),o={assetBase:r.assetBase,libBase:r.libBase,bake:{probe:t,snapshotPath:"/workspace/init.snap"}},i=new Worker(URL.createObjectURL(new Blob([`self.__LEAN_WASM_CONFIG__ = ${JSON.stringify(o)};
${R}`],{type:"text/javascript"})));try{return await new Promise((c,h)=>{let l=setTimeout(()=>h(new Error(`the bake did not finish within ${Math.round(a/6e4)} minutes`)),a);i.onmessage=y=>{let f=y.data||{};if(f.type==="snapshot"){clearTimeout(l),c(new Uint8Array(f.bytes));return}if(f.type==="error"){clearTimeout(l),h(new Error(f.data));return}f.type==="status"&&f.data&&n?.(f.data),f.type==="library"&&f.stage==="manifest"?n?.(`core layer: ${f.modules} modules in ${f.packs} packs`):f.type==="library"&&f.stage==="pack"&&n?.(`core pack ${f.loaded}/${f.total}`)},i.onerror=y=>{clearTimeout(l),h(new Error(y.message||"the bake worker failed"))},i.postMessage({type:"start"})})}finally{i.terminate()}}var I=[0,97,115,109],be=2,we=5,ge=0,ke=1,xe=2,$e=3,Se=4,N=1,G=2,A=262144;function H(e,t){return{pos:t,byte(){return this.pos>=e.length?null:e[this.pos++]},u32(){let n=0,a=0;for(;;){if(this.pos>=e.length||a>28)return null;let r=e[this.pos++];if(n|=(r&127)<<a,a+=7,(r&128)===0)return n>>>0}},name(){let n=this.u32();if(n===null||this.pos+n>e.length)return null;let a="";for(let r=0;r<n;r++)a+=String.fromCharCode(e[this.pos+r]);return this.pos+=n,a},skip(n){return this.pos+n>e.length?null:(this.pos+=n,!0)}}}function Me(e,t){let n=e.u32();if(n===null)return null;for(let a=0;a<n;a++){let r=e.name(),o=e.name();if(r===null||o===null)return null;let i=e.byte();if(i===null)return null;if(i===xe){let c=e.u32();if(c===null)return null;let h=e.u32();if(h===null)return null;let l=null;return c&N&&(l=e.u32(),l===null)?null:{module:r,field:o,shared:(c&G)!==0,initial:h,maximum:l}}if(i===ge){if(e.u32()===null)return null}else if(i===ke){if(e.skip(1)===null)return null;let c=e.u32();if(c===null||e.u32()===null||c&N&&e.u32()===null)return null}else if(i===$e){if(e.skip(2)===null)return null}else if(i===Se){if(e.skip(1)===null||e.u32()===null)return null}else return null;if(e.pos>t)return null}return null}function _e(e){if(!e||e.length<8)return null;for(let n=0;n<I.length;n++)if(e[n]!==I[n])return null;let t=H(e,8);for(;t.pos<e.length;){let n=t.byte(),a=t.u32();if(n===null||a===null)return null;let r=t.pos+a;if(r>e.length)return null;if(n===be)return Me(t,r);t.pos=r}return null}function Be(e){if(!e||e.length<8)return null;for(let n=0;n<I.length;n++)if(e[n]!==I[n])return null;let t=H(e,8);for(;t.pos<e.length;){let n=t.byte(),a=t.u32();if(n===null||a===null)return null;let r=t.pos+a;if(r>e.length)return null;if(n===we){let o=t.u32();if(o===null||o===0)return null;let i=t.u32();if(i===null)return null;let c=t.u32();if(c===null)return null;let h=null;return i&N&&(h=t.u32(),h===null)?null:{shared:(i&G)!==0,initial:c,maximum:h}}t.pos=r}return null}function q(e){let t=_e(e);if(t)return{source:"import",...t};let n=Be(e);return n?{source:"defined",...n}:null}var Y=A/4;function K(e,t){let n=e.reduce((o,i)=>o+i.length,0),a=new Uint8Array(Math.min(n,t)),r=0;for(let o of e){if(r>=a.length)break;let i=o.subarray(0,Math.min(o.length,a.length-r));a.set(i,r),r+=i.length}return a}async function Le(e){if(!e.body)return new Uint8Array(await e.arrayBuffer()).subarray(0,A);let t=e.body.getReader(),n=[],a=0,r=Y;try{for(;;){let{value:o,done:i}=await t.read();if(i||(n.push(o),a+=o.length,r=X(n[0])?Y:A,a>=r))break}}catch{}finally{t.cancel().catch(()=>{})}return K(n,r)}async function ve(e,t){let n=new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip")).getReader(),a=[],r=0;try{for(;r<t;){let{value:o,done:i}=await n.read();if(i)break;a.push(o),r+=o.length}}catch{}finally{n.cancel().catch(()=>{})}return K(a,t)}function X(e){return e.length>1&&e[0]===31&&e[1]===139}async function J(e){let t=String(e??"").replace(/\/+$/,""),n=[`${t}/lean.wasm.gz`,`${t}/lean.wasm`];for(let a of n){let r;try{r=await fetch(a)}catch{continue}if(r.status!==404&&r.ok)try{let o=await Le(r),i=X(o)?await ve(o,A):o,c=q(i);if(!c)continue;return{mode:c.shared?"shared":"unshared",memory:c,url:a,bytesRead:o.length}}catch{continue}}return null}function Ee(e){return e.startsWith("[DEBUG:")||e.startsWith("mainModule? =")||e.startsWith("- /lib/lean/")||e.startsWith("wasm streaming compile failed:")||e==="falling back to ArrayBuffer instantiation"}function Ae(e){let t=e.data;return typeof t=="string"?t:t&&typeof t=="object"?t.msg??t.message??JSON.stringify(t):String(t??"")}function C(e,t){let n=[],a=[],r=0;for(let[o,i]of[["stdout",e],["stderr",t]])for(let c of(i??"").split(`
`)){let h=c.trim();if(!h)continue;if(Ee(h)){r+=1;continue}let l=null;if(h.startsWith("{"))try{l=JSON.parse(h)}catch{l=null}if(l&&typeof l=="object"&&l.severity){let y={severity:l.severity,text:Ae(l),pos:l.pos??null};(l.severity==="information"?n:a).push(y)}else{let y={severity:o==="stdout"?"output":"error",text:h,pos:null};(o==="stdout"?n:a).push(y)}}return{info:n,problems:a,noise:r}}function Q(e){let t=/\(line \d+, col \d+\)|at line \d+, column \d+/;return e.map(({severity:n,text:a,pos:r})=>{let o=String(a).replace(/\u001b\[[0-9;]*m/g,""),i=r?.line!=null&&!t.test(o)?`  (line ${r.line}${r.column!=null?`, col ${r.column}`:""})`:"";return n==="output"?o:`${n}: ${o}${i}`})}var P=["Std","Lean","Batteries"];function L(e){return[{label:"Mathlib",manifestUrl:`${e.layerBase}/real-analysis-layer.json`,packBase:e.layerBase,roots:["Mathlib","Aesop","Qq","Plausible","ProofWidgets","ImportGraph","LeanSearchClient","Game"]}]}var V={Lake:"Lake is a build tool, and there is no build step here."};function Z(e){return e.replace(/\/-[\s\S]*?-\//g,"").replace(/--[^\n]*/g,"")}function T(e){let t=[];for(let n of Z(e).split(`
`)){let a=/^\s*import\s+([A-Za-z0-9_'.]+)/.exec(n);if(!a)continue;let r=a[1].replace(/^'/,"").split(".")[0];r&&!t.includes(r)&&t.push(r)}return t}function ee(e){return Z(e).split(`
`).filter(t=>/^\s*import\s+\S/.test(t)).map(t=>t.trim()).join(`
`)}function te(e){let t=[];for(let n of e){let a=/unknown module prefix '([^']+)'/.exec(n.text);a&&!t.includes(a[1])&&t.push(a[1])}return t}function ne(e){return[...P,...L(e).flatMap(t=>t.roots)]}function Te(e,t){return P.includes(e)||L(t).some(n=>n.roots.includes(e))?"lean-wasm-fetch-assets":null}function re(e,t,n,a=null){let r=[],o=l=>{r.includes(l)||r.push(l)},i=a?.artifact??null,c=a?.core??null,h=i&&c&&i!==c?` This host's Lean artifact is ${i.slice(0,12)} but its libraries are ${c.slice(0,12)}, so fetch assets built by the artifact's Lean \u2014 \`lean-wasm-fetch-assets\` from any other build will not do.`:"";for(let l of T(e))if(t.includes(l)){let y=Te(l,n);o(y?`${l} is not on the asset host. Mirror it with \`${y}\`.${h}`:`${l} is not available here.`)}else V[l]&&o(V[l]);return r}function ae(e){let t=[];for(let n of e){let a=/object file '[^']*' of module (\S+)/.exec(n.text);if(!a)continue;let r=`${a[1]} is not in the published Mathlib closure. Upstream ships only the 4,303 modules its Real Analysis course needs, so some of Mathlib is available here and some is not.`;t.includes(r)||t.push(r)}return t}var Re="/workspace/input.lean";function Ie(e){return`self.__LEAN_WASM_CONFIG__ = ${JSON.stringify(e)};
${R}`}function se({assetBase:e,libBase:t,memory:n,onProgress:a,onStatus:r}){let o=null,i=null,c="",h="",l=1,y=[],f={artifact:null,core:null,layer:null};function v(d){if(d.build)for(let s of["artifact","core","layer"])d.build[s]&&(f[s]=d.build[s])}let M=d=>{d&&a?.(d)};function u(d){let s=d.data||{};switch(s.type){case"stdout":c+=s.data+`
`;return;case"stderr":h+=s.data+`
`;return;case"status":r?.(s.data);return;case"memory":M(s.failed?`shared memory: ${s.mb} MB refused, trying a smaller one`:`shared memory: ${s.mb} MB (max ${s.maximumPages} pages)`);return;case"library":v(s),s.stage==="manifest"?M(`core layer: ${s.modules} modules in ${s.packs} packs`):s.stage==="pack"?M(`core pack ${s.loaded}/${s.total}`):s.stage==="written"&&M(`${s.files} library files installed`);return;case"modules":s.stage==="progress"&&M(`loading ${s.root}: ${s.files}/${s.total} files`);return;case"layer":v(s),s.stage==="progress"&&M(`loading ${s.label}: pack ${s.pack}/${s.packs}`);return;default:break}for(let x of[...y])x.match(s)&&(y.splice(y.indexOf(x),1),clearTimeout(x.timer),x.resolve(s));s.type==="error"&&m(new Error(s.data))}function m(d){for(let s of y.splice(0))clearTimeout(s.timer),s.reject(d)}function w(d,s,x){return new Promise((b,F)=>{let O={match:d,resolve:b,reject:F,timer:null};O.timer=setTimeout(()=>{let z=y.indexOf(O);z>=0&&y.splice(z,1),F(new Error(`${s} timed out after ${Math.round(x/1e3)}s`))},x),y.push(O)})}function g(d){if(!o)throw new Error("The Lean runtime is not running.");o.postMessage(d)}async function k(){o=new Worker(URL.createObjectURL(new Blob([Ie({assetBase:e,libBase:t,memory:n})],{type:"text/javascript"}))),o.onmessage=u,o.onerror=d=>m(new Error(d.message||"Lean runtime error")),g({type:"start"}),await w(d=>d.type==="ready","Starting the Lean runtime",12e4)}async function p(d){let s=l++;return g({type:"load_modules",id:s,roots:d}),(await w(b=>b.type==="modules_loaded"&&b.id===s,`Loading ${d.join(", ")}`,3e5)).results??[]}async function S(d){let s=l++;return g({type:"load_layer",id:s,label:d.label,manifestUrl:d.manifestUrl,packBase:d.packBase}),await w(b=>b.type==="layer_loaded"&&b.label===d.label,`Loading ${d.label}`,6e5)}async function E(d){let s=l++;return c="",h="",g({type:"compile",id:s,code:d,path:Re}),{...await w(b=>b.type==="result"&&b.id===s,"Compiling",6e5),stdout:c,stderr:h}}function B(){m(new Error("The compiler was disposed.")),o?.terminate(),o=null,i&&(URL.revokeObjectURL(i),i=null)}return{start:k,loadModules:p,loadLayer:S,compile:E,dispose:B,get build(){return{...f}}}}function Ce(e){return`"${String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n").replace(/\r/g,"\\r").replace(/\t/g,"\\t").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"").replace(/\u2028|\u2029/g," ")}"`}var oe=/syntax error at line \d+, column \d+/;function ie(e){let t=ee(e);return`${T(e).some(r=>r==="Lean"||r==="Mathlib")?t:`${t}${t?`
`:""}import Lean`}
open Lean

run_cmd do
  let src := ${Ce(e)}
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
`}var Pe=8,le=["auto","full","off"];function Oe(){if(typeof Worker!="function"||typeof Blob!="function")throw new Error("@live-codes/lean-wasm runs in a browser: the Lean runtime is a Web Worker, and it is handed over as a blob so that it stays same-origin.")}function Ue(){try{return new WebAssembly.Memory({initial:1,maximum:2,shared:!0}),!0}catch{return!1}}function Ne(e){if(e?.mode==="shared"&&!Ue())throw new Error(`The Lean artifact at ${e.url} declares a shared WebAssembly memory, and this browser will not construct one here. Serve the page with \`Cross-Origin-Opener-Policy: same-origin\` and \`Cross-Origin-Embedder-Policy: require-corp\` (or \`credentialless\`); an embed that cannot set those headers can isolate its own frame with \`Document-Isolation-Policy: isolate-and-require-corp\` instead. A single-threaded Lean build would need none of this \u2014 see FINDINGS.md \xA72 and \xA79.`)}function Fe(e){if(!e)return"artifact: the memory import could not be read, so a shared memory is assumed";let{initial:t,maximum:n}=e.memory,a=`min ${t} pages, ${n===null?"no maximum":`max ${n} pages`}`;return e.mode==="unshared"?`artifact: unshared memory (${a}) \u2014 no cross-origin isolation needed`:`artifact: shared memory (${a}) \u2014 this needs SharedArrayBuffer`}async function ce(e={}){Oe();let t=_(e.baseUrl),n=e.syntaxCheck??"auto";if(!le.includes(n))throw new Error(`syntaxCheck must be one of ${le.join(", ")}, not ${n}`);let a=L(t),r=await J(t.assetBase),o={memory:r?.mode??"unknown",limits:r?.memory??null,url:r?.url??null};e.onArtifact?.(o),Ne(r),e.onProgress?.(Fe(r));let i=r?{mode:r.mode,...r.memory}:null,c=se({assetBase:t.assetBase,libBase:t.libBase,memory:i,onProgress:e.onProgress,onStatus:e.onStatus}),h=new Set,l=new Set;await c.start();function y(u,m){if(u.files>0){h.add(u.root),m.loaded.push(`${u.root} (${u.files} files${u.failed?`, ${u.failed} failed`:""})`);return}if(u.alreadyLoaded){h.add(u.root);return}m.notMirrored.includes(u.root)||m.notMirrored.push(u.root)}async function f(u,m){let w=u.filter(p=>!m.attempted.has(p));if(w.length===0)return!1;w.forEach(p=>m.attempted.add(p));let g=!1;for(let p of a){if(!w.some(E=>p.roots.includes(E))||m.layers.has(p.label))continue;m.layers.add(p.label);let S=await c.loadLayer(p);S.ok?(l.add(p.label),S.alreadyLoaded||(m.loaded.push(`${p.label} layer (${S.files} files)`),g=!0)):m.notMirrored.includes(p.label)||m.notMirrored.push(p.label)}let k=w.filter(p=>P.includes(p));if(k.length>0)for(let p of await c.loadModules(k))y(p,m),p.files>0&&(g=!0);return g}async function v(u,m){await f(T(u),m);let w=await c.compile(u);for(let g=0;g<Pe;g++){let{problems:k}=C(w.stdout,w.stderr);if(!await f(te(k),m))break;w=await c.compile(u)}return w}async function M(u,m){let w=await v(ie(u),m),{problems:g}=C(w.stdout,w.stderr);return g.filter(k=>oe.test(k.text))}return{language:"lean",assets:t,artifact:o,async run(u,m,w={}){if(typeof u!="string")throw new Error("run() needs the program source as its first argument.");let g=w.syntaxCheck??n,k={attempted:new Set,layers:new Set,loaded:[],notMirrored:[]},p=performance.now(),S=await v(u,k),{info:E,problems:B,noise:d}=C(S.stdout,S.stderr);if(g!=="off"&&u.trim()!==""&&!B.some(b=>b.severity==="error")){let b=h.has("Lean")||l.size>0;(g==="full"||b)&&B.push(...await M(u,k))}let s=B.some(b=>b.severity==="error")||S.success===!1,x=s?[...re(u,k.notMirrored,t,c.build),...ae(B)]:[];return{output:E.map(b=>b.text).join(`
`),errors:[...Q(B),...x.map(b=>`note: ${b}`)],exitCode:s?1:0,noise:d,libraries:k.loaded,compileMs:Math.round(performance.now()-p)}},dispose(){c.dispose()}}}var ze=["lean"],je=["auto","full","off"];function We(e){return ne(e??_())}function De(e){return L(e??_())}return pe(Ge);})();
