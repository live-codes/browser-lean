# @live-codes/lean-wasm

Run **Lean 4** in the browser with one API — the real elaborator and kernel, compiled to WebAssembly.
The same shape as [`@live-codes/clang-wasm`](https://www.npmjs.com/package/@live-codes/clang-wasm), with
two differences that the runtime forces: this package is **browser-only**, and it ships **no assets**.

```js
import { createCompiler } from '@live-codes/lean-wasm';

const lean = await createCompiler({ baseUrl: 'https://cdn.example.com/lean/' });

const { output, errors, exitCode } = await lean.run('#eval 2 + 2');
// output === '2', errors === [], exitCode === 0

lean.dispose();
```

A classic worker cannot load an ES module, so there is also an IIFE build that sets
`self.leanWasm`:

```js
importScripts('https://cdn.example.com/lean-wasm.global.js');
const lean = await self.leanWasm.createCompiler({ baseUrl: 'https://cdn.example.com/lean/' });
```

## Why no assets ship in this package

`lean.wasm` is **96.2 MiB in a single file**, and jsDelivr refuses files over 20 MB — so it can never
travel in a tarball, whatever the package size limit is. The library data is further out of reach:
377 MiB of per-file `.olean`/`.ir` plus a 316 MiB Mathlib layer. Unlike `clang-wasm`, which bundles
its 28 MB toolchain so `npm install` is enough, Lean's runtime is always fetched from a host.

Fill that host with one command, which writes the layout `baseUrl` expects:

```bash
npx --package @live-codes/lean-wasm lean-wasm-fetch-assets public/lean
```

It is resumable, and `--only wasm`, `--only lib,mathlib` etc. fetch subsets.

```
<baseUrl>/lean-wasm/     lean.js, lean.wasm.gz, core-layer.json, core-lib/*.pack
<baseUrl>/lean-lib/      lean-lib-files.json.gz, then Std/Lean/Batteries module by module (.gz)
<baseUrl>/lean-mathlib/  real-analysis-layer.json, artifacts-*.pack
```

### Compression, and why it is the default

`lean.wasm` is 96.2 MiB, and **Cloudflare Pages refuses files over 25 MiB** (so do several other
git-based hosts). Gzipped it is 16.5 MiB, and the runtime decompresses it in the browser — so the
default build writes `.gz` files and nothing in the mirror exceeds the limit:

| | raw | as served | how |
| --- | --- | --- | --- |
| `lean.wasm` | 96.2 MiB | **16.5 MiB** | gzipped, decompressed with `DecompressionStream` |
| per-file library tree (Std, Lean, Batteries) | 376.8 MiB | **143.1 MiB** | same, one file at a time |
| core layer, 5 packs | 76.1 MiB | 30.7 MiB | already gzip containers, read as they are |
| Mathlib layer, 52 packs | 809.8 MiB | 316.3 MiB | already gzip containers |
| **whole mirror** | **~823 MiB** | **~490 MiB** | 5,607 files, none over 25 MiB |

Measured on the real artifacts: the wasm, the core layer and the library tree go from 5,662 files /
503.7 MiB to 5,607 files / 190.8 MiB, with zero files over the Pages limit.

**gzip, not brotli.** Brotli takes the wasm to 8.9 MiB, but `DecompressionStream` — which is what
decompresses here, with no dependency — does not support it. 16.5 MiB clears the limit, and the
browser's own transfer compression is a separate question the host answers anyway.

### A wrong URL is worse than a broken one

The upstream host — and any static host with an SPA fallback, Cloudflare Pages included — answers
`200` with its `index.html` for a path it does not have. A mis-typed `baseUrl`, or a deploy where
`lean-lib/` never made it into the repository, therefore looks like a successful download: the mirror
fills with HTML, and Lean reports it much later, from inside the kernel, as
`failed to read file '…', invalid header`.

So both ends check. `lean-wasm-fetch-assets` validates every asset's magic number before writing it
and refuses HTML, checks each `.olean` header against the `leanCommit` in `core-layer.json`, and
`--check` re-validates a whole directory without downloading anything. The runtime checks the same
header as it installs each file, and fails with a message naming the file and the likely cause rather
than handing HTML to Lean.

How the runtime picks a layout: it probes `<baseUrl>/lean-wasm/lean.wasm.gz` and
`<baseUrl>/lean-lib/lean-lib-files.json.gz`, and falls back to the plain names. So both layouts work,
and **the pair must not be mixed** — if the index is gzipped, every file in the tree must be too,
because the index decides for the whole directory. Keep the uncompressed originals and the probe
simply prefers the `.gz`; delete them and you host half as much. `--no-compress` writes the plain
layout for a host with no size limit.

For a **git** deploy, track the `.gz` files (and `lean.js`, the manifests and the packs) — that is the
~510 MiB above. `.gitignore` in this repo ignores the mirrors, since it is the development repo rather
than the asset host.

**Serve it with both headers, and they are not interchangeable:**

| header | needed for |
| --- | --- |
| `Access-Control-Allow-Origin: *` | the wasm and the layers, which are fetched with `fetch()` |
| `Cross-Origin-Resource-Policy: cross-origin` | `lean.js`, which arrives via `importScripts()` — a no-cors request that COEP checks against CORP, not CORS |

Miss the second and every asset downloads while the boot still fails with
`Failed to execute 'importScripts' … failed to load`.

## Requirements

**The page must be cross-origin isolated.** `lean.wasm` imports a WebAssembly memory with
`flags: 3` — `has-max | shared` — and a shared memory can only be constructed with a
`SharedArrayBuffer`, which browsers expose only to a cross-origin isolated document. Serve with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp     # or credentialless
```

There is no shim. A stub `SharedArrayBuffer` is not enough here, unlike some other wasm runtimes:
this one really does construct one for its pthread pool, so a fake satisfies the type check and then
wedges the boot. `createCompiler()` throws with this explanation rather than failing obscurely.

If you are embedding into a page whose headers you do not control, the only escape hatches are
Chrome-only: the reverse origin trial for `SharedArrayBuffer`, or `Document-Isolation-Policy`. That is
a deployment trade-off, not something this library can fix.

**Browser only.** The runtime is a Web Worker handed over as a blob (a worker script URL must be
same-origin, and a package consumer has nowhere to serve one from), and it uses `importScripts`. Node
would need a second implementation over `node:worker_threads`.

## Options

```js
const lean = await createCompiler({
  baseUrl,          // required: where the three mirrored directories are served from
  syntaxCheck,      // 'auto' (default) | 'full' | 'off'
  onProgress,       // (message) => void, for a spinner
  onStatus          // (message) => void, the wasm build's own status lines
});
```

`syntaxCheck` controls how hard the compiler looks for **parse errors**, which the runtime drops on
the floor: its collection loop reads the command state's message log after the elaborator has reset
it, so the parser's messages are wiped before it looks. That is a bug in the fork's Lean source
(`cauli/lean4`, `src/Lean/Shell.lean`) and fixing it needs a wasm rebuild. So instead this package
parses the source with Lean's own parser in a second compile:

| mode | behaviour | extra payload |
| --- | --- | --- |
| `auto` | parse, but only once the Lean library is loaded this session | none |
| `full` | always parse, loading Lean and Std if needed | ~350 MiB |
| `off` | never parse | none |

`auto` is the default because the parser lives in the Lean library: a session that only writes plain
Lean pays nothing, and one that imports Lean or Mathlib gets exact parse errors for free.

## `run(code, input?, options?)`

`input` is accepted for API symmetry with the other language packages and **ignored** — this runtime
has no stdin.

```js
const result = await lean.run(code, undefined, { syntaxCheck: 'off' });
```

| field | meaning |
| --- | --- |
| `output` | the program's own messages — `#eval` and `#check` results |
| `errors` | one string per diagnostic, empty when the kernel accepted everything |
| `exitCode` | `0`, or `1` when anything was reported |
| `noise` | toolchain trace lines filtered out of `errors` (they are counted, not silently dropped) |
| `libraries` | what this run installed, e.g. `["Std (1449 files)"]` |
| `compileMs` | wall time for the run, including any library loading |

## Libraries

`Init` is always available; the rest is fetched on demand and cached in the worker's filesystem:

- **`Std`, `Lean`, `Batteries`** — individual files, fetched the first time a program imports one.
- **Mathlib** — a packed layer, and a **4,303-module closure**: the tree upstream builds for its Real
  Analysis game, compiled against the same Lean commit as the binaries. So `Mathlib.Data.Real.Basic`
  and the `ring`/`norm_num`/`linarith` tactics work while `Mathlib.Analysis.SpecialFunctions.Sqrt` does
  not, and the package says which when you hit one. There is deliberately no all-of-Mathlib layer:
  upstream tested one and rejected it because compaction exceeded the practical wasm heap.

Lean names only the **first** missing module prefix per compile, so a program needing several
libraries takes one round each — bounded by progress, never by how many imports it has.

## Verified

`test/page.html` loads the package from one origin and the assets from another (the LiveCodes shape)
and checks both entries end to end. Last run, all passing:

```
  ok   esm: #eval 2 + 2                                   output="4" exit=0
  ok   esm: proof + #check                                output="t (a : Nat) : a + 0 = a" exit=0
  ok   esm: elaboration error                             error: Unknown identifier `this_does_not_exist`  (line 1, col 7)
  ok   esm: import Std (loaded on demand)                 output="[(1, 1), (2, 2), (3, 3)]" libs=["Std (1449 files)"]
  ok   esm: syntax probe (full)                           error: syntax error at line 1, column 19
  ok   iife bundle exposes self.leanWasm.createCompiler   true
  ok   iife in a worker                                   output="\"from the iife in a worker\"" exit=0
```

`npm test` covers the parts that do not need a browser — asset resolution, root parsing, message
classification, the probe's source generation, and that the generated worker module is the Lean host.

Building from a checkout needs `esbuild`, which is a devDependency, so on a machine with
`npm config get omit` set to `dev` use `npm install --include=dev` — otherwise npm reports success and
installs nothing. `npm run build:iife` regenerates `dist/lean-wasm.global.js` and
`npm run sync:worker` regenerates `src/runtime-worker.js` from `worker/lean-worker.js`;
`npm run check` fails if the latter has drifted.

## Using it in LiveCodes

The pieces LiveCodes needs, in the shape its other `@live-codes/*` packages take:

```ts
// src/livecodes/vendors.ts
export const leanWasmBaseUrl = /* @__PURE__ */ getUrl('@live-codes/lean-wasm@0.1.0/');
export const leanAssetsBaseUrl = 'https://cdn.example.com/lean/';   // or baseUrl + 'assets/'

// src/livecodes/languages/lean/lang-lean.ts
export const lean: LanguageSpecs = {
  name: 'lean',
  title: 'Lean',
  compiler: {
    factory: () => async (code) => code,                            // nothing to compile ahead of time
    scripts: ({ baseUrl }) => [`${leanWasmBaseUrl}dist/lean-wasm.global.js`],
    scriptType: 'text/lean',
    largeDownload: true,
  },
  extensions: ['lean'],
  editor: 'script',
};
```

and in `lang-lean-script.ts`, `self.leanWasm.createCompiler({ baseUrl: leanAssetsBaseUrl })` driven from
the sandbox worker, mapping `{ output, errors, exitCode }` onto `window.livecodes.lean`. That is the
same contract `lang-clang-wasm-script.ts` uses, so the runner plumbing there is the model — with two
caveats:

- **The result page must be cross-origin isolated** for the shared memory, which the embedder's
  headers decide. See Requirements above.
- **Keep the compiler on its own thread.** `createCompiler()` already runs the runtime in a nested
  worker, so the caller is never blocked — do not drive it on the result page's main thread.

## Licence

**MIT** for everything here. The Lean compiler and its libraries are Apache-2.0; the WebAssembly
artifacts and the worker's structure come from
[cauli/lean4-wasm-in-browser](https://github.com/cauli/lean4-wasm-in-browser) (Apache-2.0). See
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

The assets this package fetches are **not** included or redistributed: `lean-wasm-fetch-assets`
downloads them from a host you name, and you are responsible for the terms of whatever you serve.
