/*! @live-codes/lean-wasm - MIT. IIFE build, sets self.leanWasm.
 *  importScripts('lean-wasm.global.js') then self.leanWasm.createCompiler({ baseUrl }).
 *  Runs Lean 4 (Apache-2.0) compiled to WebAssembly by cauli/lean4-wasm-in-browser (Apache-2.0);
 *  no third-party JavaScript is bundled. */
var leanWasm=(()=>{var O=Object.defineProperty;var ie=Object.getOwnPropertyDescriptor;var le=Object.getOwnPropertyNames;var ce=Object.prototype.hasOwnProperty;var ue=(e,t)=>{for(var n in t)O(e,n,{get:t[n],enumerable:!0})},de=(e,t,n,s)=>{if(t&&typeof t=="object"||typeof t=="function")for(let r of le(t))!ce.call(e,r)&&r!==n&&O(e,r,{get:()=>t[r],enumerable:!(s=ie(t,r))||s.enumerable});return e};var fe=e=>de(O({},"__esModule",{value:!0}),e);var We={};ue(We,{DEFAULT_BASE_URL:()=>C,LANGUAGES:()=>Ne,SYNTAX_MODES:()=>Ce,availableRoots:()=>Fe,createCompiler:()=>oe,layers:()=>je,requiredAssetPaths:()=>F,resolveAssets:()=>$});var C=void 0,_={wasm:"lean-wasm",lib:"lean-lib",mathlib:"lean-mathlib"};function me(e,t){let n;try{n=new URL(e,globalThis.location?.href)}catch{throw new Error(`${t} must be an absolute http(s) URL, or relative to the page: ${e}`)}if(n.protocol!=="http:"&&n.protocol!=="https:")throw new Error(`${t} must be http or https, not ${n.protocol}//`);return n}function $(e){let t=e??void 0;if(t==null||t==="")throw new Error("baseUrl is required: this package ships no assets (Lean\u2019s wasm is 96.2 MiB, past the 20 MB per-file limit on jsDelivr), so the runtime is fetched from a host you control. Run `npx --package @live-codes/lean-wasm lean-wasm-fetch-assets <dir>` to materialise them, then pass that directory as baseUrl.");let n=me(t,"baseUrl").href.replace(/\/+$/,""),s=r=>`${n}/${r}`;return{baseUrl:`${n}/`,assetBase:s(_.wasm),libBase:s(_.lib),layerBase:s(_.mathlib)}}function F(){return[`${_.wasm}/lean.js`,`${_.wasm}/lean.wasm`,`${_.wasm}/core-layer.json`,`${_.wasm}/core-lib/artifacts-*.pack`,`${_.lib}/lean-lib-files.json`,`${_.lib}/**`,`${_.mathlib}/real-analysis-layer.json`,`${_.mathlib}/artifacts-*.pack`]}var v=[0,97,115,109],he=2,pe=5,ye=0,be=1,we=2,ge=3,ke=4,U=1,j=2,A=262144;function W(e,t){return{pos:t,byte(){return this.pos>=e.length?null:e[this.pos++]},u32(){let n=0,s=0;for(;;){if(this.pos>=e.length||s>28)return null;let r=e[this.pos++];if(n|=(r&127)<<s,s+=7,(r&128)===0)return n>>>0}},name(){let n=this.u32();if(n===null||this.pos+n>e.length)return null;let s="";for(let r=0;r<n;r++)s+=String.fromCharCode(e[this.pos+r]);return this.pos+=n,s},skip(n){return this.pos+n>e.length?null:(this.pos+=n,!0)}}}function xe(e,t){let n=e.u32();if(n===null)return null;for(let s=0;s<n;s++){let r=e.name(),a=e.name();if(r===null||a===null)return null;let i=e.byte();if(i===null)return null;if(i===we){let u=e.u32();if(u===null)return null;let m=e.u32();if(m===null)return null;let h=null;return u&U&&(h=e.u32(),h===null)?null:{module:r,field:a,shared:(u&j)!==0,initial:m,maximum:h}}if(i===ye){if(e.u32()===null)return null}else if(i===be){if(e.skip(1)===null)return null;let u=e.u32();if(u===null||e.u32()===null||u&U&&e.u32()===null)return null}else if(i===ge){if(e.skip(2)===null)return null}else if(i===ke){if(e.skip(1)===null||e.u32()===null)return null}else return null;if(e.pos>t)return null}return null}function _e(e){if(!e||e.length<8)return null;for(let n=0;n<v.length;n++)if(e[n]!==v[n])return null;let t=W(e,8);for(;t.pos<e.length;){let n=t.byte(),s=t.u32();if(n===null||s===null)return null;let r=t.pos+s;if(r>e.length)return null;if(n===he)return xe(t,r);t.pos=r}return null}function Le(e){if(!e||e.length<8)return null;for(let n=0;n<v.length;n++)if(e[n]!==v[n])return null;let t=W(e,8);for(;t.pos<e.length;){let n=t.byte(),s=t.u32();if(n===null||s===null)return null;let r=t.pos+s;if(r>e.length)return null;if(n===pe){let a=t.u32();if(a===null||a===0)return null;let i=t.u32();if(i===null)return null;let u=t.u32();if(u===null)return null;let m=null;return i&U&&(m=t.u32(),m===null)?null:{shared:(i&j)!==0,initial:u,maximum:m}}t.pos=r}return null}function D(e){let t=_e(e);if(t)return{source:"import",...t};let n=Le(e);return n?{source:"defined",...n}:null}var z=A/4;function G(e,t){let n=e.reduce((a,i)=>a+i.length,0),s=new Uint8Array(Math.min(n,t)),r=0;for(let a of e){if(r>=s.length)break;let i=a.subarray(0,Math.min(a.length,s.length-r));s.set(i,r),r+=i.length}return s}async function Me(e){if(!e.body)return new Uint8Array(await e.arrayBuffer()).subarray(0,A);let t=e.body.getReader(),n=[],s=0,r=z;try{for(;;){let{value:a,done:i}=await t.read();if(i||(n.push(a),s+=a.length,r=H(n[0])?z:A,s>=r))break}}catch{}finally{t.cancel().catch(()=>{})}return G(n,r)}async function $e(e,t){let n=new Blob([e]).stream().pipeThrough(new DecompressionStream("gzip")).getReader(),s=[],r=0;try{for(;r<t;){let{value:a,done:i}=await n.read();if(i)break;s.push(a),r+=a.length}}catch{}finally{n.cancel().catch(()=>{})}return G(s,t)}function H(e){return e.length>1&&e[0]===31&&e[1]===139}async function q(e){let t=String(e??"").replace(/\/+$/,""),n=[`${t}/lean.wasm.gz`,`${t}/lean.wasm`];for(let s of n){let r;try{r=await fetch(s)}catch{continue}if(r.status!==404&&r.ok)try{let a=await Me(r),i=H(a)?await $e(a,A):a,u=D(i);if(!u)continue;return{mode:u.shared?"shared":"unshared",memory:u,url:s,bytesRead:a.length}}catch{continue}}return null}function Ee(e){return e.startsWith("[DEBUG:")||e.startsWith("mainModule? =")||e.startsWith("- /lib/lean/")||e.startsWith("wasm streaming compile failed:")||e==="falling back to ArrayBuffer instantiation"}function Se(e){let t=e.data;return typeof t=="string"?t:t&&typeof t=="object"?t.msg??t.message??JSON.stringify(t):String(t??"")}function I(e,t){let n=[],s=[],r=0;for(let[a,i]of[["stdout",e],["stderr",t]])for(let u of(i??"").split(`
`)){let m=u.trim();if(!m)continue;if(Ee(m)){r+=1;continue}let h=null;if(m.startsWith("{"))try{h=JSON.parse(m)}catch{h=null}if(h&&typeof h=="object"&&h.severity){let y={severity:h.severity,text:Se(h),pos:h.pos??null};(h.severity==="information"?n:s).push(y)}else{let y={severity:a==="stdout"?"output":"error",text:m,pos:null};(a==="stdout"?n:s).push(y)}}return{info:n,problems:s,noise:r}}function Y(e){let t=/\(line \d+, col \d+\)|at line \d+, column \d+/;return e.map(({severity:n,text:s,pos:r})=>{let a=String(s).replace(/\u001b\[[0-9;]*m/g,""),i=r?.line!=null&&!t.test(a)?`  (line ${r.line}${r.column!=null?`, col ${r.column}`:""})`:"";return n==="output"?a:`${n}: ${a}${i}`})}var T=["Std","Lean","Batteries"];function E(e){return[{label:"Mathlib",manifestUrl:`${e.layerBase}/real-analysis-layer.json`,packBase:e.layerBase,roots:["Mathlib","Aesop","Qq","Plausible","ProofWidgets","ImportGraph","LeanSearchClient","Game"]}]}var K={Lake:"Lake is a build tool, and there is no build step here."};function X(e){return e.replace(/\/-[\s\S]*?-\//g,"").replace(/--[^\n]*/g,"")}function P(e){let t=[];for(let n of X(e).split(`
`)){let s=/^\s*import\s+([A-Za-z0-9_'.]+)/.exec(n);if(!s)continue;let r=s[1].replace(/^'/,"").split(".")[0];r&&!t.includes(r)&&t.push(r)}return t}function J(e){return X(e).split(`
`).filter(t=>/^\s*import\s+\S/.test(t)).map(t=>t.trim()).join(`
`)}function Q(e){let t=[];for(let n of e){let s=/unknown module prefix '([^']+)'/.exec(n.text);s&&!t.includes(s[1])&&t.push(s[1])}return t}function V(e){return[...T,...E(e).flatMap(t=>t.roots)]}function Ae(e,t){return T.includes(e)||E(t).some(n=>n.roots.includes(e))?"lean-wasm-fetch-assets":null}function Z(e,t,n){let s=[],r=a=>{s.includes(a)||s.push(a)};for(let a of P(e))if(t.includes(a)){let i=Ae(a,n);r(i?`${a} is not on the asset host. Mirror it with \`${i}\`.`:`${a} is not available here.`)}else K[a]&&r(K[a]);return s}function ee(e){let t=[];for(let n of e){let s=/object file '[^']*' of module (\S+)/.exec(n.text);if(!s)continue;let r=`${s[1]} is not in the published Mathlib closure. Upstream ships only the 4,303 modules its Real Analysis course needs, so some of Mathlib is available here and some is not.`;t.includes(r)||t.push(r)}return t}var te=`/**
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
    const response = await fetchOrThrow(candidate);
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
    const response = await fetchOrThrow(\`\${assetBase}/lean.js\${assetQ}\`);
    if (!response.ok) throw new Error(\`HTTP \${response.status} fetching lean.js\`);
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
`;var Be="/workspace/input.lean";function Re(e){return`self.__LEAN_WASM_CONFIG__ = ${JSON.stringify(e)};
${te}`}function ne({assetBase:e,libBase:t,memory:n,onProgress:s,onStatus:r}){let a=null,i=null,u="",m="",h=1,y=[],L=c=>{c&&s?.(c)};function B(c){let o=c.data||{};switch(o.type){case"stdout":u+=o.data+`
`;return;case"stderr":m+=o.data+`
`;return;case"status":r?.(o.data);return;case"memory":L(o.failed?`shared memory: ${o.mb} MB refused, trying a smaller one`:`shared memory: ${o.mb} MB (max ${o.maximumPages} pages)`);return;case"library":o.stage==="manifest"?L(`core layer: ${o.modules} modules in ${o.packs} packs`):o.stage==="pack"?L(`core pack ${o.loaded}/${o.total}`):o.stage==="written"&&L(`${o.files} library files installed`);return;case"modules":o.stage==="progress"&&L(`loading ${o.root}: ${o.files}/${o.total} files`);return;case"layer":o.stage==="progress"&&L(`loading ${o.label}: pack ${o.pack}/${o.packs}`);return;default:break}for(let x of[...y])x.match(o)&&(y.splice(y.indexOf(x),1),clearTimeout(x.timer),x.resolve(o));o.type==="error"&&S(new Error(o.data))}function S(c){for(let o of y.splice(0))clearTimeout(o.timer),o.reject(c)}function l(c,o,x){return new Promise((g,R)=>{let k={match:c,resolve:g,reject:R,timer:null};k.timer=setTimeout(()=>{let N=y.indexOf(k);N>=0&&y.splice(N,1),R(new Error(`${o} timed out after ${Math.round(x/1e3)}s`))},x),y.push(k)})}function d(c){if(!a)throw new Error("The Lean runtime is not running.");a.postMessage(c)}async function p(){a=new Worker(URL.createObjectURL(new Blob([Re({assetBase:e,libBase:t,memory:n})],{type:"text/javascript"}))),a.onmessage=B,a.onerror=c=>S(new Error(c.message||"Lean runtime error")),d({type:"start"}),await l(c=>c.type==="ready","Starting the Lean runtime",12e4)}async function b(c){let o=h++;return d({type:"load_modules",id:o,roots:c}),(await l(g=>g.type==="modules_loaded"&&g.id===o,`Loading ${c.join(", ")}`,3e5)).results??[]}async function w(c){let o=h++;return d({type:"load_layer",id:o,label:c.label,manifestUrl:c.manifestUrl,packBase:c.packBase}),await l(g=>g.type==="layer_loaded"&&g.label===c.label,`Loading ${c.label}`,6e5)}async function f(c){let o=h++;return u="",m="",d({type:"compile",id:o,code:c,path:Be}),{...await l(g=>g.type==="result"&&g.id===o,"Compiling",6e5),stdout:u,stderr:m}}function M(){S(new Error("The compiler was disposed.")),a?.terminate(),a=null,i&&(URL.revokeObjectURL(i),i=null)}return{start:p,loadModules:b,loadLayer:w,compile:f,dispose:M}}function ve(e){return`"${String(e).replace(/\\/g,"\\\\").replace(/"/g,'\\"').replace(/\n/g,"\\n").replace(/\r/g,"\\r").replace(/\t/g,"\\t").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,"").replace(/\u2028|\u2029/g," ")}"`}var re=/syntax error at line \d+, column \d+/;function se(e){let t=J(e);return`${t?t+`
`:""}import Lean
open Lean

run_cmd do
  let src := ${ve(e)}
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
`}var Ie=8,ae=["auto","full","off"];function Te(){if(typeof Worker!="function"||typeof Blob!="function")throw new Error("@live-codes/lean-wasm runs in a browser: the Lean runtime is a Web Worker, and it is handed over as a blob so that it stays same-origin.")}function Oe(){try{return new WebAssembly.Memory({initial:1,maximum:2,shared:!0}),!0}catch{return!1}}function Ue(e){if(e?.mode==="shared"&&!Oe())throw new Error(`The Lean artifact at ${e.url} declares a shared WebAssembly memory, and this browser will not construct one here. Serve the page with \`Cross-Origin-Opener-Policy: same-origin\` and \`Cross-Origin-Embedder-Policy: require-corp\` (or \`credentialless\`); an embed that cannot set those headers can isolate its own frame with \`Document-Isolation-Policy: isolate-and-require-corp\` instead. A single-threaded Lean build would need none of this \u2014 see FINDINGS.md \xA72 and \xA79.`)}function Pe(e){if(!e)return"artifact: the memory import could not be read, so a shared memory is assumed";let{initial:t,maximum:n}=e.memory,s=`min ${t} pages, ${n===null?"no maximum":`max ${n} pages`}`;return e.mode==="unshared"?`artifact: unshared memory (${s}) \u2014 no cross-origin isolation needed`:`artifact: shared memory (${s}) \u2014 this needs SharedArrayBuffer`}async function oe(e={}){Te();let t=$(e.baseUrl),n=e.syntaxCheck??"auto";if(!ae.includes(n))throw new Error(`syntaxCheck must be one of ${ae.join(", ")}, not ${n}`);let s=E(t),r=await q(t.assetBase),a={memory:r?.mode??"unknown",limits:r?.memory??null,url:r?.url??null};e.onArtifact?.(a),Ue(r),e.onProgress?.(Pe(r));let i=r?{mode:r.mode,...r.memory}:null,u=ne({assetBase:t.assetBase,libBase:t.libBase,memory:i,onProgress:e.onProgress,onStatus:e.onStatus}),m=new Set,h=new Set;await u.start();function y(l,d){if(l.files>0){m.add(l.root),d.loaded.push(`${l.root} (${l.files} files${l.failed?`, ${l.failed} failed`:""})`);return}if(l.alreadyLoaded){m.add(l.root);return}d.notMirrored.includes(l.root)||d.notMirrored.push(l.root)}async function L(l,d){let p=l.filter(f=>!d.attempted.has(f));if(p.length===0)return!1;p.forEach(f=>d.attempted.add(f));let b=!1;for(let f of s){if(!p.some(c=>f.roots.includes(c))||d.layers.has(f.label))continue;d.layers.add(f.label);let M=await u.loadLayer(f);M.ok?(h.add(f.label),M.alreadyLoaded||(d.loaded.push(`${f.label} layer (${M.files} files)`),b=!0)):d.notMirrored.includes(f.label)||d.notMirrored.push(f.label)}let w=p.filter(f=>T.includes(f));if(w.length>0)for(let f of await u.loadModules(w))y(f,d),f.files>0&&(b=!0);return b}async function B(l,d){await L(P(l),d);let p=await u.compile(l);for(let b=0;b<Ie;b++){let{problems:w}=I(p.stdout,p.stderr);if(!await L(Q(w),d))break;p=await u.compile(l)}return p}async function S(l,d){let p=await B(se(l),d),{problems:b}=I(p.stdout,p.stderr);return b.filter(w=>re.test(w.text))}return{language:"lean",assets:t,artifact:a,async run(l,d,p={}){if(typeof l!="string")throw new Error("run() needs the program source as its first argument.");let b=p.syntaxCheck??n,w={attempted:new Set,layers:new Set,loaded:[],notMirrored:[]},f=performance.now(),M=await B(l,w),{info:c,problems:o,noise:x}=I(M.stdout,M.stderr);if(b!=="off"&&l.trim()!==""&&!o.some(k=>k.severity==="error")){let k=m.has("Lean")||h.size>0;(b==="full"||k)&&o.push(...await S(l,w))}let g=o.some(k=>k.severity==="error")||M.success===!1,R=g?[...Z(l,w.notMirrored,t),...ee(o)]:[];return{output:c.map(k=>k.text).join(`
`),errors:[...Y(o),...R.map(k=>`note: ${k}`)],exitCode:g?1:0,noise:x,libraries:w.loaded,compileMs:Math.round(performance.now()-f)}},dispose(){u.dispose()}}}var Ne=["lean"],Ce=["auto","full","off"];function Fe(e){return V(e??$())}function je(e){return E(e??$())}return fe(We);})();
