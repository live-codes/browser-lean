# Spike findings — Lean 4 in the browser

**Status: spike complete.** The page runs Lean 4 typed into it, in the tab, with no server-side
compilation: the kernel's verdict on a proof comes back from WebAssembly on your machine. Everything
below was **run**, in headless Chrome, and the numbers are quoted as observed.

The short version: Lean 4 in the browser is now *fast*. A proof is accepted in **~0.3 s** and the
whole runtime is ready in **~2.2 s**, against **~8 minutes** and **~2 minutes per run** for the first
approach this spike tried. What is left is a deployment constraint rather than a wall — §2 — and one
real gap in the runtime itself — §6.

## 0. Corrections to the first pass (both were my errors)

1. **I dismissed the reference implementation without measuring it.** The first version of this
   document called `cauli/lean4-wasm-in-browser` "a full app, not a library, and its assets are served
   behind that app's own Cloudflare Functions", and moved on to a wrapper that was convenient to
   import. That was a bad call: the app *is* the reference for how to run Lean in a browser well, its
   artifacts are fetchable, and the convenient wrapper is ~100× slower per run. Everything in §1–§5
   is the measurement I should have taken first.
2. **I mirrored the wrong binaries.** `/lean-wasm/lean.js` and `/lean-wasm/lean.wasm` without a query
   string are an *older* build (lean.js 85.34 MiB, lean.wasm 131.08 MiB) whose `.olean` files are
   incompatible with the packed core layer. The app requests them with `?v=<build>`, which is a
   different and much better build (lean.js **148 KB**, lean.wasm 96.17 MiB). Mixing them fails at
   runtime with `failed to read file '/lib/lean/Init.olean', incompatible header` — see §5.

## 1. The runtime, and the two decisions that matter

```
Lean 4 source
  → real Lean 4 (cauli/lean4 `reinstate-wasm` fork, wasm32)   elaborate + kernel-check
  → JSON messages, one per line, on stdout                    severity: information | error
  → the page splits them by severity                          output / diagnostics
```

The artifacts are built by [`cauli/lean4-wasm-in-browser`](https://github.com/cauli/lean4-wasm-in-browser)
and deployed to `lean.cau.li`. Two architectural choices in that project account for essentially all
of the difference in performance, and both are visible in its
[`lean-worker-persistent.worker.js`](https://lean.cau.li/lean-worker-persistent.worker.js):

- **A real Web Worker, running the runtime once, reused across compiles.** The persistent worker
  "initializes the runtime ONCE (without running `main()`, which would tear down via `EXIT_RUNTIME=1`)
  and serves repeated compiles through the fork's `lean_wasm_compile` export. The first compile
  imports Init and caches the environment inside Lean; subsequent compiles reuse it."
  The alternative — driving an Emscripten module per run — rebuilds the whole environment every time.
  The worker's own comment says why an iframe is the wrong container: *"a same-origin iframe shares
  the main thread, which froze the whole tab"*.
- **A packed core layer.** 629 Init modules / 1,887 files (`.olean` + `.ir` + `.ir.sig`) are shipped
  as **5 gzip packs** with a manifest of per-entry offsets, so startup is 5 requests instead of
  ~1,900. 76.07 MiB raw / 30.69 MiB compressed.

And one choice that fixes a functional gap rather than a performance one: **shipping `.ir` files**.
They carry the compiled bodies the interpreter needs, which is what makes `#eval` of *library*
functions work at all (§4).

## 2. Cross-origin isolation is required — measured twice, from both ends

`lean.wasm` does not define a memory; it **imports** one. Parsing the import section of the pinned
build:

```
imported memories: [{"flags":3,"shared":true,"min":1024,"max":65536,"maxPages":65536}]
VERDICT: shared memory = true
```

`flags: 3` is `has-max | shared`. A `shared` memory can only be constructed with a
`SharedArrayBuffer`, which browsers expose only to a cross-origin isolated document. The upstream
worker confirms the same requirement from the other side — it constructs the memory itself:

```js
new WebAssembly.Memory({ initial: ..., maximum: ..., shared: true })
```

So this is not a misdiagnosis to be worked around. It is worth stating plainly because
`browser-cobol` found its own isolation requirement *was* phantom — a stray `instanceof` on
artifacts whose memories were all `shared: false`. Lean's is in the artifact, and no shim substitutes
for it. `serve.js` therefore sets COOP/COEP by default, with `--no-isolation` kept so the failure
stays reproducible: served without headers, the page reports `crossOriginIsolated === false`, shows a
banner, and a Run fails with an actionable message before downloading anything.

**For LiveCodes this is a deployment constraint, not a dead end — but a fragile one.** A result page
runs in a sandboxed iframe inside someone else's document, and cross-origin isolation is inherited from
the top-level document, so a page cannot give itself COOP/COEP (which is exactly why `browser-elixir`
could not be embedded cleanly). Chrome offers two escape hatches that skip the headers:

- the **reverse origin trial for `SharedArrayBuffer` on desktop**, which lets a page use
  `SharedArrayBuffer` *without* being cross-origin isolated. This is the same mechanism Chrome has used
  to give sites more time since the Chrome 92 restriction; it has already been extended more than once
  and sits on a deprecation path.
- **`Document-Isolation-Policy`**, which lets a document turn on `crossOriginIsolated` for itself,
  without deploying COOP or COEP, regardless of the isolation status of the page around it. This one has
  shipped — Chrome 137 for desktop — and unlike COOP/COEP it applies per frame, so it needs nothing from
  the embedder. Measured in §9.6.

So Lean *could* ship in LiveCodes today behind one of these. They are Chrome-only, and the origin trial
sits on a deprecation path, so the honest default is to treat isolation as unavailable and prefer a
**single-threaded Lean wasm build**, which needs none of this and works in every browser. §9 is what that
build actually requires — and it is upstream Lean work, not just a build.

The page therefore keys off `SharedArrayBuffer` itself, not off `crossOriginIsolated` — otherwise it
would refuse to start in exactly the configuration a trial provides. Verified by shadowing the global
in a non-isolated document: the pill reads "SharedArrayBuffer, not isolated", no banner appears, and
the boot proceeds instead of being blocked. (That shim is not a real `SharedArrayBuffer`, so the boot
then wedges and the watchdog below reports it; under an actual trial the buffer is real.)

One sizing detail that bites: the memory's declared maximum must not be exceeded. Passing
`maximum: 65536` to the older build fails at instantiation with

```
LinkError: Import #461 "env" "memory": memory import has a larger maximum size 65536
than the module's declared maximum 32768
```

The old build declares max 32768, the pinned one 65536. It is readable off the module, and worth
re-reading whenever the pinned version moves.

## 3. Message handling: severity, not streams

With the fork's compile entry, messages arrive as **one JSON object per line on stdout** — `#eval`
results, `#check` output and errors all together. stderr is empty in every run observed. So the
stream a message arrived on tells you nothing:

```json
{"severity":"information","data":"2","pos":{"line":1,"column":0},"kind":"[anonymous]"}
{"severity":"error","data":"Unknown identifier `this_is_not_defined`","pos":{"line":1,"column":6}}
```

The page classifies by `severity` where the line is a JSON message, and otherwise falls back to the
stream — which is what a plain-text runtime would need. There is also toolchain tracing to drop
(`[DEBUG:*]`, `[PROFILE]`, `[PWORKER]`, …), matched narrowly by hand so an unrecognised line is
always shown rather than swallowed; the count of filtered lines is reported in the log. Upstream
filters the same class of lines with a slightly broader regex, which is corroboration that this is
inherent to the build rather than something the page introduced.

## 4. Verified

Each row was run through the page and the panes read back.

| snippet | output | exit | run |
| --- | --- | --- | --- |
| `#eval "Hello from Lean!"` | `"Hello from Lean!"` | 0 | — |
| `#eval 2 + 2`, `#eval 2 ^ 10`, `#check Nat.add_comm` | `4`, `1024`, `Nat.add_comm (n m : Nat) : n + m = m + n` | 0 | — |
| `def fib` + `#eval fib 10` / `#eval fib 20` | `55`, `6765` | 0 | 0.28 s |
| `theorem add_comm … := by induction b with …` | accepted, no diagnostics | 0 | 0.28–0.67 s |
| **`#eval (List.range 5).map (fun n => n * n)`** | **`[0, 1, 4, 9, 16]`** | 0 | 0.08 s |
| `#eval [1,2,3].foldl (· + ·) 0`, `String.join` | `6`, `"abc"` | 0 | — |
| `#check this_is_not_defined` | `error: Unknown identifier \`this_is_not_defined\` (line 1, col 6)` | 1 | 0.01 s |
| `theorem t : (1 : Nat) = 2 := by rfl` | `error: Tactic \`rfl\` failed: … ⊢ 1 = 2 (line 1, col 32)` | 1 | 0.03 s |

The library-`#eval` row is the one that would have been impossible with the first approach: `lean4.js`
answered that same line with `error: Unknown constant \`List.reverse._redArg\``, because its trimmed
library ships `.olean` files without the `.ir` bodies the interpreter needs. Type-checking worked
there; *evaluating* library code did not. This build evaluates it.

Runtime startup: **2.2 s** to `ready` (5.5 s on a cold first attempt), of which the 5-pack fetch and
unpack is a small part and the Init import is the rest. Note the page is deliberately lazy — nothing
is fetched until the first Run.

## 5. Cost

Pinned build, on disk:

| asset | bytes | notes |
| --- | --- | --- |
| `lean.wasm` | 100,838,905 (96.17 MiB) | |
| `core-lib/artifacts-00{0..4}.pack` | 32,184,975 (30.69 MiB) | gzip; 629 modules, 1,887 entries, 76.07 MiB raw |
| `core-layer.json` | 313,732 (0.30 MiB) | per-entry offsets |
| `lean.js` | 148,402 (0.14 MiB) | |
| **total** | **~127 MiB** | |

Over the wire it is much less: the binaries are served brotli-compressed, and the packs are already
gzip. `Content-Encoding: br` on `lean.wasm` takes **96.17 MiB down to 16,107,800 B (15.4 MiB)** —
this wasm compresses ~6×, presumably because a large part of its 84 MB data section is sparse. So a
first load transfers roughly **47 MB**, not 127 MB. (The "~105 MB" figure that prompted this pass
matches neither my wire nor my on-disk total; the closest match is the *slim* variant's README row
(3.4 + 70 + 30.7), and slim is not deployed — `/lean-wasm/slim/lean.js` 404s. Either way the
direction of the correction was right, and the real numbers are better still.)

Two traps worth recording:

- **The unversioned URLs are a different, older build.** `/lean-wasm/lean.wasm` is 131.08 MiB and
  `/lean-wasm/lean.js` is 85.34 MiB, and their `.olean` files are incompatible with the current
  packed layer. The fetch CLI (`lean-wasm-fetch-assets`, behind `npm run assets`) pins `?v=` and
  refuses to mix builds, and reports the
  mismatch as `incompatible header` at runtime if you get it wrong. Upstream's own build script
  enforces the same pairing and aborts on a mismatch.
- **The glue got ~580× smaller and that is not a typo.** The explicit export list replaces
  Emscripten's export-everything mode, which cost ~105 MB of JS glue for a ~231k-entry export table.
  148 KB versus 85.34 MiB.

### Optional libraries: lazy, per-file, loaded on demand

`Init` arrives packed in the core layer. Everything else upstream offers — `Std`, `Lean`
(metaprogramming), `Batteries` — ships as **individual files** and is fetched on demand. The page now
supports them. Before that work, every import failed the same way:

```
import Std        → error: unknown module prefix 'Std'
                    error: No directory 'Std' or file 'Std.olean' in the search path entries:
                    error: /lib/lean
import Lean       → same, 'Lean'          (0.49 s)
import Batteries  → same, 'Batteries'     (0.26 s)
import Mathlib    → same, 'Mathlib'       (0.23 s)
```

i.e. the page behaved like upstream's **slim** variant ("Init only"), never like its full one.

They are **lazy and per-file**, not a second packed layer:

| | how it ships upstream | size |
| --- | --- | --- |
| Init (core) | 5 gzip packs, fetched at boot | 76.07 MiB raw / 30.69 MiB compressed, 629 modules |
| Std / Lean / Batteries | **individual files** from the static `lean-lib/` tree, fetched on first import | 88.8 / 261.2 / ~26.8 MiB (measured) |
| Mathlib | its own packed layer, for the Real Analysis game | 4,303 modules / 52 packs / **331.7 MB compressed** |

`lean-lib-files.json` indexes **2,658 module files** — Lean 1,195, Init 629, Std 482, Batteries 186,
Lake 159, plus single `LeanChecker`/`LeanIR`/`Leanc`/`LakeMain` entries — and each one serves its
`.olean` (and `.ir`/`.ir.sig`) individually; `Std.olean`, `Std.ir`, `Batteries.olean` and `Lean.olean`
all return 200 with the `olea` magic. There is **no** `std-layer.json` or `batteries-layer.json` (those
URLs return the SPA shell), because packing is a startup optimisation for the Init closure only, not a
packaging scheme for the optional libraries. The per-library sizes above are the bytes the page
actually fetched — Std in 1,449 files and Lean in 3,588 files, i.e. every published file for both —
replacing an earlier sampled estimate; the whole mirror is 5,598 files / 376.8 MiB on disk.

#### What was implemented

- `npm run assets:libs` (the package's fetch CLI) mirrors the tree for Std / Lean / Batteries into
  `public/lean-lib/`, index included: **5,598 files, ~377 MiB** — `.olean` + `.ir` + `.ir.sig` for each
  of 1,866 modules.
- The worker gained `load_modules`: it reads `lean-lib-files.json`, fetches every file under a root,
  and writes them into `/lib/lean` mid-session. Writing after boot is enough because module resolution
  happens at compile time — the same property `browser-haskell` documented for adding packages to a
  live session.
- The page compiles, and on Lean's `unknown module prefix 'X'` it loads `X` and recompiles.
  **The dependency closure is discovered by asking the compiler**, not by parsing `.olean`
  dependency headers, so `import Batteries` pulls in whatever Batteries itself needs without any graph
  logic on our side.
- **The retry loop is bounded by progress, not by import count.** The page reads the program's `import`
  lines and loads those roots in one phase up front; the loop then only runs for *transitive*
  dependencies. Measured: **8 imports across the three libraries cost one compile** (2.09 s, already
  installed); `import Batteries` alone on a cold page cost three compiles (10.05 s), because it
  discovers Batteries → Lean → Std one compile at a time. That is inherent: Lean reports only the
  first missing prefix per compile, since the frontend aborts with an uncaught exception, so the number
  of *rounds* is bounded by the number of distinct libraries, never by the number of imports. The
  8-round cap is a backstop against a mirror that never satisfies an import, and if it is ever reached
  the page says so instead of leaving a bare "unknown module prefix".

Verified end to end, the fetch being paid once on first use:

| snippet | output | exit | run |
| --- | --- | --- | --- |
| `import Std.Data.HashMap` + a `HashMap` fold, `#eval`d | `[(1, 1), (2, 2), (3, 3)]` | 0 | 0.20 s |
| `import Lean` + `#eval (Name.mkSimple "hello").toString` | `"hello"`, `Lean.Expr : Type` | 0 | 0.02 s |
| `import Batteries` | accepted | 0 | 5.5 s first, then 0.1 s |
| all three imported together | accepted | 0 | 1.1 s |

That the `#eval`s work at all is the point of shipping `.ir` next to `.olean` — the same gap that made
`lean4.js` answer `Unknown constant List.reverse._redArg` in §0.

### Mathlib works — as a packed layer, and as a closure

Mathlib is the one library upstream does *not* publish per-file, and the one it does not publish in
full. It ships as `real-analysis-layer.json`: the **4,303-module closure** its Real Analysis course
needs, compiled against the same Lean commit as our pinned binaries (`62b6a229…`), as **52 gzip packs,
316.3 MiB compressed / 809.8 MiB raw**. Upstream is explicit that full Mathlib was tried and rejected —
"a full Mathlib environment snapshot was tested but deliberately not shipped: compaction exceeded the
practical WASM heap".

So Mathlib needed a second *transport*, not a second library tree, and the worker now has both:

- `load_modules` — per-file, for Std / Lean / Batteries.
- `load_layer` — manifest + gzip packs with per-entry offsets, for Mathlib. Packs are installed one at a
  time and released, so peak memory stays near a single pack rather than the whole 800 MiB layer.

The layer also answers for the roots it carries — Aesop, Qq, Plausible, ProofWidgets, ImportGraph,
LeanSearchClient, Game — so an import of any of those resolves too. `npm run assets:mathlib` mirrors it.

Verified:

| snippet | output | exit | run |
| --- | --- | --- | --- |
| `import Mathlib.Data.Real.Basic` + `Mathlib.Tactic.Ring`; `example (x : ℝ) : x + 0 = x := by ring` | accepted; `#check Real` → `Real : Type` | 0 | 10.4 s cold, 2.6 s warm |
| `Mathlib.Tactic.NormNum` and `Linarith` proofs on `ℚ` and `ℝ` | accepted | 0 | 2.6 s |
| `import Mathlib.Analysis.SpecialFunctions.Sqrt` (outside the closure) | `object file '…/Sqrt.olean' of module … does not exist` | 1 | 0.2 s |

Two things worth recording:

- **`import Mathlib` on its own is not a module.** There is no `Mathlib.olean` umbrella in the layer — nor
  in Mathlib generally — so it fails with `unknown module prefix 'Mathlib'` even with the layer
  installed. Importing specific modules is the only way, as in any Lean project.
- **A module outside the closure fails differently**, and the first version of the note logic missed it:
  the prefix *resolves*, so Lean reports `object file '…' of module X does not exist` rather than an
  unknown prefix. The page now recognises that shape and says this is the published closure, not a
  mistake.

One implementation note: the first attempt failed with `Could not load the Mathlib layer: Unexpected
token 'N', "Not found:"` — a key-name mismatch, where the page sent `manifest` and the worker read
`manifestUrl`, so it fetched `undefined` and parsed this server's 404 body as JSON. Worth knowing
because the failure mode of a bad manifest URL is "the compiler cannot find a library we think we
loaded", which the page now also reports separately (see the `unresolved` note below).

### Hosting: which assets are already on a CORS-enabled CDN

For publishing this as a package, "can we just point at upstream?" splits by asset type, and the split
is not where you would guess. Measured with a ranged `GET` carrying an `Origin` header:

| asset | host | `Access-Control-Allow-Origin` | usable from another origin? |
| --- | --- | --- | --- |
| `lean.wasm` (96.2 MiB), `lean.js` (148 KB) | lean.cau.li, via a Cloudflare Function | none — and `Cross-Origin-Resource-Policy: same-origin` | **no** |
| `core-layer.json`, `core-lib/*.pack` (30.7 MiB) | lean.cau.li, static Pages | `*` | yes |
| `lean-lib-files.json`, `lean-lib/**` (377 MiB) | lean.cau.li, static Pages | `*` | yes |
| `real-analysis-layer.json`, `real-analysis-lib/*.pack` (316 MiB) | lean.cau.li, static Pages | `*` | yes |
| `lean.js` + `lean.wasm` (older build, 216 MiB) | lean4-wasm.timqian.com (R2) | `*` | yes, but the wrong build |

So **everything except the two binaries is already served with `Access-Control-Allow-Origin: *`** — the
~347 MiB of library data could be fetched straight from upstream with no hosting at all. The one thing
that cannot is `lean.wasm`, and it is 96.2 MiB of the total.

The trap worth recording: on this host a **`HEAD` omits the CORS headers that a `GET` returns**. Testing
`https://lean4-wasm.timqian.com` earlier, `HEAD` showed no `Access-Control-Allow-Origin` and the host
looked unusable; a real `GET` returned `*`. I very nearly drew the opposite conclusion twice. Test with
a ranged `GET`.

Alternatives checked, so nobody re-checks them:

- **jsDelivr** is not a route to this at all, independent of the 150 MB package limit: there is also a
  **20 MB per-file** limit, and `lean.wasm` is 96.2 MiB. The core packs (5 files, ~6 MB each, 30.7 MiB
  total) would fit; the wasm never will without a granted increase.
- **GitHub Releases** do not work: the redirect target returns **no `Access-Control-Allow-Origin`** and
  sends `Content-Disposition: attachment`. Public and huge, but not fetchable from a page.
- **GitHub Pages** does work (`Access-Control-Allow-Origin: *`), and would hold a 96.2 MiB file under the
  100 MiB limit — but it has a soft 100 GB/month bandwidth cap and is explicitly not intended as a CDN.
- **Cloudflare R2 / B2 / Bunny** are the honest answer for the binaries: 96 MB to store is cents per
  month, egress is free on R2, and CORS is a bucket setting.

Two caveats on hotlinking upstream even where it is permitted:

1. **Those paths are unversioned and mutable.** Only the Function honours `?v=`; the static packs are
   served with `Cache-Control: public, max-age=0, must-revalidate` and `cf-cache-status: DYNAMIC`, so a
   redeploy changes the bytes under a fixed URL. The manifests carry `leanCommit`, so a consumer can
   refuse a layer built for a different binary — that check matters more here than the URL pinning that
   works for the binaries.
2. **They are not edge-cached.** `cf-cache-status: DYNAMIC` means every consumer reaches origin storage,
   and throughput was poor in testing (96 MiB took minutes). Fine for development; asking a published
   package's users to pull 347 MiB from someone else's bucket is not.

### Serving the assets from a different origin

Everything above assumes the assets share the page's origin, which is true of `npm start` but not of a
package consuming a CDN. Making that work needed two changes, both found by testing rather than
reasoning — and my first diagnosis was wrong:

1. **`Cross-Origin-Resource-Policy: cross-origin`, not just CORS.** `lean.js` arrives via
   `importScripts()`, which is a **no-cors** request, and COEP checks that against CORP;
   `Access-Control-Allow-Origin` does not satisfy it. Adding ACAO alone left every pack downloaded and
   the boot dying at `Failed to execute 'importScripts' … failed to load` — a message that reads like a
   network failure while the network is fine.
2. **The bootstrap must be same-origin, so `lean.js` is fetched and imported from a blob URL.** Adding
   CORP was not enough either. Isolating the mechanism in a throwaway worker showed cross-origin
   `importScripts` works perfectly — `lean.js: ok` — so the failure was not the fetch. It is that this
   is a pthread build: the runtime spawns its thread pool with `new Worker(mainScriptUrlOrBlob)`, and a
   **worker script must be same-origin**, so a cross-origin main script throws during evaluation and
   `importScripts` reports it only as "failed to load". The worker now fetches `lean.js` (a CORS
   request ACAO covers) and imports a blob URL — which is precisely what Emscripten's
   `mainScriptUrlOrBlob` is for.

Verified by serving the page from `:8129` with `?baseUrl=http://localhost:8131`, a genuinely
cross-origin load of all three directories:

| program | assets from | result |
| --- | --- | --- |
| Std example | `:8131` — 1,449 files, 88.8 MiB | accepted, `[(1, 1), (2, 2), (3, 3)]` |
| Mathlib example | `:8131` — 12,909 files, 809.8 MiB | accepted, `mine (x : ℝ) : x + 0 = x` |
| default, no `?baseUrl=` | same origin | accepted (regression check) |

So a CDN mirroring `public/`'s three directories under one base is all that is needed:

```
<base>/lean-wasm/  <base>/lean-lib/  <base>/lean-mathlib/
```

with `Access-Control-Allow-Origin` **and** `Cross-Origin-Resource-Policy: cross-origin` on all three.

Hence the recommendation in §7: ship **code only** and treat every asset host as configuration.

### Serving it compressed, and the 25 MiB host limit

`lean.wasm` is 96.2 MiB, which Cloudflare Pages refuses outright — *"Pages only supports files up to
25 MiB"*. One file blocks the whole deploy: of 5,662 files in the mirror, every other one is small.

Gzip takes it to **16.5 MiB** (5.82×) and the per-file library tree from 376.8 to 143.1 MiB. Brotli
would take the wasm to 8.9 MiB, but `DecompressionStream` — the browser's own decompressor, and the
reason this needs no dependency — does not support brotli. So: gzip, ~823 MiB of mirror down to ~490
MiB, and nothing over the limit.

Three traps, all found by testing rather than reasoning:

1. **`Module.wasmBinary` does not reach the pthread sub-workers.** Setting it made the main thread
   instantiate from memory, and then a sub-worker tried `XMLHttpRequest` on `lean.wasm` — the one file a
   compressed host does not have — and the boot died with `NetworkError: Failed to execute 'send' on
   'XMLHttpRequest': Failed to load …/lean.wasm`. What works is a **blob URL** returned from
   `locateFile`: it is same-origin, every thread resolves it, and `type: 'application/wasm'` keeps
   streaming compilation. The blob is built from the decompressed bytes, so the download stays single.
2. **The per-file tree's layout is decided by its index**, which is also the only place worth probing:
   if `<libBase>/lean-lib-files.json.gz` exists, every module is `<path>.gz`. Probing per file would add
   5,598 round trips, and mixing the two layouts breaks the tree rather than degrading it.
3. **A wrong URL is worse than a broken one, because these hosts answer `200` with HTML.**
   `https://lean.cau.li/lean.js` returns the SPA shell with a `200`, and so does `/lean-lib/Std.olean` —
   only `/lean-wasm/…` has the assets. A shape probe that trusted the status code therefore accepted the
   site root as an asset host, wrote 1,576 bytes of `index.html` into every one of 5,598 `.olean.gz`
   files, and the whole thing surfaced much later as
   `error: uncaught exception: failed to read file '/lib/lean/Lean.olean', invalid header`. Cloudflare
   Pages does the same thing wherever an SPA fallback is configured, so a deploy missing `lean-lib/`
   looks exactly like a successful one.

   Both ends now check instead of trusting: the CLI validates each asset's magic number before writing
   it (HTML rejected outright, `.olean` headers matched against `core-layer.json`'s `leanCommit`,
   `--check` re-validates a directory without downloading), and the runtime checks the same header as it
   installs each file, naming the file and the likely cause instead of handing HTML to Lean. A gzip
   source is also never gzipped twice, since that decompresses to something Lean calls an invalid
   header for the same reason.

Verified by pointing the demo at a compressed mirror on another origin: the proof example ran (wasm
from `lean.wasm.gz`, `Lean ready in 4.6s`) and `import Std` loaded all 1,449 files from `.gz` sources.
The plain layout was re-verified after the change — the probe 404s and falls back.

### Two more things a deployment has to get right

Both were found by deploying to Cloudflare Pages, and both are the same mistake in different clothes:
trusting the machine you developed on.

**The page must not depend on a route, only on files.** The first deploy failed before it started:
`Failed to load module script: Expected a JavaScript-or-Module script but the server responded with a
MIME type of "text/html"`. The page imported the package's ES module entry through `/vendor/lean-wasm/`,
a path prefix that `serve.js` mapped onto `packages/lean-wasm/` — a route that exists on this machine and
nowhere else. On Pages it fell through to the SPA fallback and came back as `index.html`, so the MIME
type was `text/html` and the browser refused it. The build is now vendored into `public/vendor/` by
`npm run sync:vendor` (generated from the package's `dist/`, drift-checked in `npm run check`), loaded as
a plain `<script>`, and `serve.js` no longer maps anything — it is as dumb as the host, so the mistake
fails locally too. Everything else about the deploy was fine: the wasm, the core layer, the per-file
library tree and Mathlib were all present and correctly typed, and it is only this one import that broke.

**A static host still needs COOP/COEP, and on Pages that means a `_headers` file.** Isolation is not
something the runtime can arrange for itself (§2), and the deploy had no headers at all, so the page
would have loaded and then failed to construct its shared memory. Cloudflare Pages reads `_headers` from
the published directory, so `public/_headers` now carries COOP/COEP plus the two CORS headers a CDN role
needs (`Access-Control-Allow-Origin` for fetched assets, `Cross-Origin-Resource-Policy` for `lean.js`,
which arrives via `importScripts` as a no-cors request). Without COEP `require-corp` there is no
`SharedArrayBuffer`; without CORP, a cross-origin boot fetches everything and then dies on
`importScripts`.

## 6. Limitations

- **Syntax errors are no longer silently accepted** — worked around in the page, with the real fix
  being one function upstream. The cause, the workaround, its cost and its switch are all in §6.1.
- **Cross-origin isolation is mandatory** (§2), with no shim and no fallback. A *stub* `SharedArrayBuffer`
  is not enough here, unlike the situation `browser-cobol` documented: this runtime really does construct
  one for its pthread pool, so a fake satisfies the type check and then wedges the boot. That is why the
  page watches for a real buffer and why it needs the next point.
- **A wedged boot is now reported instead of hanging.** The module can instantiate and then never finish
  starting — observed by supplying a stub `SharedArrayBuffer`, where `new WebAssembly.Memory({shared: true})`
  succeeded, the library was written, and `onRuntimeInitialized` never fired. The worker emits a throttled
  activity heartbeat and the page fails after 60 s of silence with an explanation, rather than sitting on
  "loading" forever. Worth having for an embedded context, where a missing capability and a blocked worker
  look identical from the outside.
- **No interrupt.** A non-terminating elaboration cannot be stopped; recovery is a page reload, which
  now costs ~2 s rather than ~8 minutes, so this is much less severe than in the first pass.
- **~127 MiB of assets** (≈47 MB over the wire) are mirrored locally; they are not committed.
- **The mirror depends on a third-party deploy.** `lean.cau.li`'s binaries cannot be hotlinked
  (`Cross-Origin-Resource-Policy: same-origin`, no `Access-Control-Allow-Origin`), which is why they
  are mirrored. The packs and manifest *do* send `Access-Control-Allow-Origin: *`, but one version
  story is simpler than two.
- **Chrome only, as tested.** Safari, Firefox and mobile were not exercised.

### 6.1 Syntax errors: cause, workaround, one-function fix

Measured, not inferred: `def broken : Nat :=`, `#eval (1 +`, and `def x : Nat := 5` followed by `@@@`
all produced **empty stdout, empty stderr, `success: true`**, so the page reported "accepted" while
elaboration and kernel errors reported normally.

**Cause.** From the fork's `Lean.Shell.wasmCompile` (`src/Lean/Shell.lean`) together with
`Lean.Elab.Frontend.processCommand`:

```lean
-- Frontend.processCommand
match ... Parser.parseCommand ictx pmctx pstate cmdState.messages with
| (cmd, ps, messages) =>
  setParserState ps
  setMessages messages          -- the parser's messages go into the command state
  elabCommandAtFrontend cmd     -- …and this resets that log when it starts
```

and the fork's collection loop reads the log *after* `processCommand` returns:

```lean
    acc := acc ++ (← Elab.Frontend.getCommandState).messages
```

So parse messages are written and then wiped inside the same command, before anything reads them.
Elaboration messages survive because they are logged after the reset.

**The upstream fix** is to capture the parser's own `MessageLog` between those two calls —
`Parser.parseCommand` is pure (`Id.run`), so it returns the accumulated log directly:

```lean
let (cmd, ps', log') := Parser.parseCommand ictx pmctx pstate log
acc := acc ++ log'
```

That needs a wasm rebuild, so it is out of scope here. Worth noting it is **not fixed on any branch**:
`master` has no wasm entry points at all, and the wasm branches share the flawed loop.

**Workaround, implemented in the page.** The page does that parse itself in a second, small compile:
`syntaxProbeSource` builds a Lean file that imports Lean (and the user's own imports) and runs a
`run_cmd` which parses the user's source with `Parser.parseHeader` + `Parser.parseCommand` and throws
with the error positions.

| source | before | now |
| --- | --- | --- |
| `def broken : Nat :=` | accepted, exit 0 | `error: syntax error at line 2, column 0`, exit 1 |
| `def x : Nat := 5` / `@@@` / `#eval x` | accepted, exit 0 | same error, exit 1 — and `#eval x` still printed `5`, so the parser recovered and only the probe caught it |
| a valid `induction` proof | accepted | accepted — no false positive |
| the Mathlib example | accepted | accepted |

Note the second row: a *recoverable* parse error is invisible to any "did the file run to the end"
trick, which is why this parses the text rather than appending a sentinel.

Two things it got wrong first, both caught by testing rather than reasoning:

- **The probe must import what the user imports.** Parsing `ℝ` without Mathlib's notation produced a
  bogus syntax error on a file the kernel accepts — a false positive is worse than the silence being
  fixed. The probe now carries the user's `import` lines across.
- **The probe is a real Lean file**, so it needs the same library resolution as user code. Bypassing
  that failed with `unknown module prefix 'Lean'`, and then `'Std'` once Lean was loaded (Lean imports
  Std), so both paths now share one `compileWithLibraries` helper.

**What does *not* work: inferring parse errors from control flow.** Appending a probe command and
checking whether the parser reaches it is free, and looked sufficient — an incomplete command ought to
consume it. It does not work, because Lean's parser **recovers**: `#eval (1 + 1` still ran the appended
command, and so did `def broken : Nat :=` (a `Syntax.missing` node plus resynchronisation). Both
measured. So there is no cheap signal to read; the errors have to come from a parser, and the parser
lives in the Lean library.

**Cost, and the switch.** The probe needs `import Lean`, which pulls the Lean library (~261 MiB) and Std
(~89 MiB) once per session — far too much to pay by default for a typo check, which is why the mode
matters:

| `?syntaxCheck=` | behaviour | extra payload |
| --- | --- | --- |
| `auto` (default) | parse, but only if the Lean library is already loaded this session | none |
| `full` | always parse, loading the libraries if needed | ~350 MiB |
| `0` | never | none |

`auto` is what keeps the default page at ~127 MB. A session that only writes plain Lean pays nothing and
a typo stays silent there; a session that imports Lean or Mathlib gets exact parse errors for free.
Measured: a fresh session logged `Syntax check: skipped — it needs the Lean library`, then after one
`import Lean` the same file failed with `syntax error at line 2, column 0` in 13 ms and 2 compiles. A run
that already reports errors skips the check either way. Upstream's one-line fix makes all of this
unnecessary.

One implementation note worth keeping: "is the Lean library loaded?" is a property of the **session**,
not of the run — the worker's filesystem outlives a run — and the first version tracked it per run, so
the check silently never fired after the library was loaded.

## 7. Recommendation for LiveCodes

Much better positioned than the first pass, and still not shippable — for one reason, not two.

**What is now solved.** The per-run boot is gone (~0.3 s per compile, and it reuses the imported
environment), the payload is ~47 MB over the wire instead of 310 MB, library `#eval` works, and the
whole thing is ~127 MiB of static files that can be hosted anywhere. The shape is a clean fit for
LiveCodes' `*-wasm` languages: one Worker per result page, initialised once, driven repeatedly.

**What still stands in the way.** §2 — and it is now a deployment trade-off rather than a wall.
LiveCodes cannot give an embedded result page COOP/COEP, so on any browser other than Chrome this
runtime has no `SharedArrayBuffer` and cannot start. Chrome-only escape hatches exist (the reverse
origin trial for `SharedArrayBuffer`, or `Document-Isolation-Policy`), which makes shipping acceptable
if it must happen; both can be withdrawn, and neither helps Firefox or Safari. Two ways forward,
in preference order:

1. **A single-threaded Lean wasm build.** No isolation, no trial, works everywhere, and removes the
   whole question. §9 is the recipe, and the honest headline is that it is blocked on two pieces of
   upstream Lean work — a sequential task manager, and an `Init`-import allocation that currently has no
   thread pool to drain it — not on the build flags, which are an afternoon.
2. **Ship Chrome-only behind the origin trial**, with the same feature detection the page already has:
   where `SharedArrayBuffer` is missing, the language should report that plainly rather than fail
   obscurely. Acceptable, and worth avoiding if it can be.

**If a single-threaded build appears**, the integration would be:

```
src/livecodes/languages/lean/lang-lean.ts           compiler.factory is identity;
                                                    scripts: [baseUrl + '{{hash:lang-lean-script.js}}'];
                                                    scriptType: 'text/lean'; largeDownload: true
src/livecodes/languages/lean/lang-lean-script.ts    creates the Worker, wires the protocol, exposes
                                                    livecodes.lean.{run,input,loaded,output,error,exitCode}
```

with the driver already written: that is `packages/lean-wasm` (`@live-codes/lean-wasm`), which owns the
worker host, the library and layer loading, and the severity classifier, and which the demo in this
repo now runs on. The `{output, error, exitCode}` contract comes from the severity split in §3 —
`information` messages become `output`, everything else becomes `error` — and `exitCode` is derived
from the diagnostics rather than from the runtime's own `success` flag, which is `true` for a file
that elaborates with errors (§3).

**Assets** belong in `browser-compilers` or a mirror we control, referenced from `vendors.ts` and
pinned by hash, with the `?v=`/layer pairing asserted at build time as §5 describes.

**Worth reporting upstream:** the silent parse failures (§6), and the fact that the unversioned asset
URLs serve a build whose library is incompatible with the current layer.

## 8. Reproducing

```bash
npm run assets             # mirror ~127 MB into public/lean-wasm/ (once)
npm start                  # → http://localhost:8129/  (COOP/COEP ON — required)
npm run start:no-isolation # same page with no headers, to see the failure (§2)
npm run check              # syntax-check all four JS files
```

The page exposes `document.documentElement.dataset` (`status`, `stage`, `runs`, `isolated`,
`exitCode`, `initMs`, `runMs`) and its element ids as globals, so a headless probe can drive it
without string literals — set `editor.value`, click `#run`, poll `dataset.status`. `window.__raw`
holds the unclassified `stdout`/`stderr` of the last run, which is how the silent-parse-failure
finding in §6 was established.

Artifact inspection used a ~60-line wasm section parser over the module's import section, plus
`curl -I`/`-w` with and without `Accept-Encoding: br` for the size and compression columns.

## 9. A single-threaded build: what it takes

§2 and §7 both land on the same answer: a build whose memory is not `shared` needs no COOP/COEP, no
origin trial and no `Document-Isolation-Policy`, and works in every browser. **It is not a flag flip, and
the reason is upstream Lean work rather than build configuration.** What follows is read out of
`cauli/lean4` @ `reinstate-wasm` and `cauli/lean4-wasm-in-browser`; the measurements marked as such were
taken here, and **no single-threaded artifact has been built or run** — there is none to run.

[`wasm-build/`](wasm-build/) is the harness for that build — Dockerfile, patches, verifier — and its
README is the operational version of §9.1–9.3. Both patches apply cleanly to the pinned revision (checked,
not assumed), and the verifier rejects the artifact shipped today with the right answer (`shared`, min 1024
/ max 65536). The build itself has not been run.

### 9.1 The flags that make it a pthread build

Two are load-bearing, and they live in different variables in `src/CMakeLists.txt`:

| where | flag | why it matters |
| --- | --- | --- |
| l.78, l.281 | `option(MULTI_THREAD "MULTI_THREAD" ON)` → `-D LEAN_MULTI_THREAD` | the task manager and `lthread` are compiled out without it |
| l.216 | `set(EMSCRIPTEN_SETTINGS "-fwasm-exceptions -pthread")` | **the `-pthread` here is unconditional**, reaches every compile, and is what puts atomics and TLS in the objects |
| l.678 | `-pthread` appended when `MULTI_THREAD AND NOT MSVC AND NOT Darwin` | drops out on its own with `MULTI_THREAD=OFF` |
| l.927 | `… -s STACK_SIZE=16777216 -sINITIAL_MEMORY=67108864 -sMAXIMUM_MEMORY=4294967296 -sPTHREAD_POOL_SIZE=4` | the pool is the 4 workers the glue spawns eagerly |
| l.217 | `-sALLOW_MEMORY_GROWTH=1 -sINCOMING_MODULE_JS_API=…,mainScriptUrlOrBlob,…` | |

So `MULTI_THREAD=OFF` alone is not enough — line 216's `-pthread` still yields the shared memory, and
`-sPTHREAD_POOL_SIZE=4` still yields the pool. Both go:

```
-DMULTI_THREAD=OFF
set(EMSCRIPTEN_SETTINGS "-fwasm-exceptions")     # l.216, minus -pthread
# l.927, minus -sPTHREAD_POOL_SIZE=4
```

Three things get *better* in that configuration, which is worth knowing before deciding it is all cost:

- **`-sALLOW_MEMORY_GROWTH=1` starts working.** Today the memory cannot grow — a `SharedArrayBuffer` is
  not resizable here (l.921–923), which is why the worker reserves 2 GB up front (§2) and why
  `scripts/patch-wasm-memory.py` exists upstream at all, raising the declared maximum by hand. An
  unshared memory grows, so `-sINITIAL_MEMORY` can drop a long way.
- **`-sINITIAL_MEMORY=67108864` was sized for the pthread layout** — "static data + the 16MB stack +
  per-thread TLS; the pthread layout needs ~22MB up front" (l.920–921). No TLS, no 16 MB main stack.
- **`-sASSERTIONS=1` becomes usable again.** l.228–230 records that it "is broken on emsdk 6 pthread
  workers" — the breakage is in the pthread boot path, and assertions are exactly what a first bring-up
  of this build wants.

`-fwasm-exceptions` stays. It is native EH, independent of threads, and l.205–209 documents why the
JS-emulated alternative is not on the table: every potentially-throwing call goes through an `invoke_*`
trampoline and consumes browser JS stack, which a worker cannot enlarge, so deep kernel recursion dies
with `RangeError` while the 16 MB wasm stack is nearly empty. `-sMAIN_MODULE=2` and the explicit
`emscripten-exports.txt` list also stay as they are.

### 9.2 Blocker one: no task manager, and `Promise.new` panics without one

The fork says this itself, in the comment sitting directly above those flags (l.201–204):

> Threads: 4.33's import machinery creates IO.Promises during env realization, and without
> LEAN_MULTI_THREAD the task manager is a no-op, so Promise.new panics by design. A single-thread (no
> COOP/COEP, phone-sized) build needs a sequential task manager upstream first.

The runtime source confirms both halves. `lean_init_task_manager_using` (`src/runtime/object.cpp:1073`)
is *entirely* inside `#if defined(LEAN_MULTI_THREAD)`, so with the macro off `g_task_manager` is
permanently null. Task execution already copes — `lean_task_spawn_core` (l.1160), `lean_task_map_core`
(l.1182) and `lean_task_bind_core` (l.1244) each take a `!g_task_manager` branch and run the continuation
inline, as `lean_task_pure(apply_1(c, box(0)))`. The promise and IO paths do not:

| `src/runtime/object.cpp` | with no task manager |
| --- | --- |
| `lean_promise_new` l.1281 | `lean_internal_panic` — "`IO.Promise.new` called before the task manager is running…" |
| `lean_promise_resolve` l.1304, `deactivate_promise` l.1324 | dereference `g_task_manager` |
| `lean_io_wait_any_core` l.1277, `lean_io_get_task_state_core` l.1270, `lean_io_cancel_core` l.1264 | dereference `g_task_manager` |

**The work is the thing the comment names: a sequential task manager** — a task-manager object created
when `LEAN_MULTI_THREAD` is off, which drains its queue inline at `wait_for`/`wait_any` instead of on
worker threads. It is smaller than it sounds: the queue, the dependency graph and the priority handling
in `task_manager` (l.729–1069) are orthogonal to *where* the drain happens, and only the drain has to
become a call rather than a pool. With it, `lean_promise_new` stops panicking, `wait_any` has something
to ask, and no call site needs an `#ifdef`.

Two constraints to design around:

- **It cannot be selected at runtime.** `get_lean_num_threads` (l.1082) reads `LEAN_NUM_THREADS` only
  under `#ifndef LEAN_EMSCRIPTEN`, and otherwise returns `hardware_concurrency()` — on wasm the answer is
  the device's core count with no environment override. The choice has to be made at build time.
- **The artifact can report which kind it is once it boots**, and only once it boots:
  `Internal.isMultiThread` (`src/Lean/Shell.lean:226`, extern `lean_internal_is_multi_thread`) exists
  already. Before boot, the memory import flag is still the only signal — which is what §9.4 builds on.

### 9.3 Blocker two: the `Init` import OOMs with nothing to drain it

The other half of the same comment (l.176–180) is what decides whether the route is shippable:

> Build with Emscripten pthreads. The single-threaded WASM build OOMs during the `Init` olean import
> (upstream's async-const realization accumulates unboundedly with no worker threads to drain it); the
> pthread build — like the native and the older 4.28 WASM builds — drains that work on real worker
> threads. Requires cross-origin isolation (COOP/COEP) in the browser for SharedArrayBuffer.

We did not reproduce this and cannot: it needs a build that does not exist. Two things follow regardless.
It is a *memory* failure with a known shape — realization producing faster than a single thread retires
it — so the sequential manager has to be drained *inside* the import loop, or the realization batched, and
either way it is verified by importing the same 629-module `Init` closure the pthread build imports today
(§5) and watching memory. And it is the reason the fork has not already shipped this: the flags are an
afternoon, this is not.

Worth recording, because it narrows the work: **the compile path is already single-thread-aware.** `Shell.lean`
(l.124–130) elaborates with the synchronous `Frontend.processCommands` loop rather than
`Elab.IO.processCommands` specifically because the latter "drives elaboration through the language-server
snapshot/task infrastructure, which spawns elaboration tasks … In the single-threaded WASM worker those
tasks are never drained, leaving the runtime in a state where the *next* `lean_wasm_compile` call fails
immediately." So compiling is already task-free by construction; what is left is environment realization
and import — §9.2 and this.

### 9.4 What changed on this side

The runtime no longer assumes a shared memory; it asks the artifact. That work is done and verified
against the pthread build, and it is what makes the build in §9.1–9.3 usable the day it exists — nothing
here waits on the artifact, and the pthread path is untouched.

1. **The probe — `src/artifact-probe.js`** — reads the memory import out of the artifact before the boot.
   Not in the original list, because the requirement had never been separated from the artifact: a
   `SharedArrayBuffer` check in the compiler is really a question about the wasm, and once it is asked
   properly it is both artifact-correct and cheap. Two mechanisms, chosen so a plain static host needs to
   do nothing special: **no `Range` request** (the ordinary response body is read and the reader cancelled
   once it has enough — `serve.js` here ignores `Range`, Cloudflare Pages honours it), and **a partial
   gunzip**, because `DecompressionStream` inflates a prefix of a gzip stream and then ends in an error
   that is expected rather than a failure. Measured: **65,536 bytes** off the wire for the pinned
   artifact, against 17,335,349 for the whole gzipped file. The budget is one number plus a conservative
   4× compression assumption, and everything fails soft to `unknown` — a 404, and the SPA-fallback host
   that answers `200` with HTML (§5), both read as unknown rather than as a memory.
2. **`worker/lean-worker.js`, `pickMemory()`** — unchanged for a shared artifact, and skipped entirely
   for an unshared one. The step-down ladder stays for the pthread build (a shared memory cannot grow);
   an unshared artifact is left to Emscripten, which already knows the limits it was built with and *can*
   grow the memory. The declared maximum is now a ceiling and the declared minimum a floor, so §2's
   `LinkError` — our 65536-page maximum against an older build's declared 32768 — can no longer be
   produced at all.
3. **`startLeanModule()`** — `mainScriptUrlOrBlob` is set only for a threaded build, since only that
   build spawns sub-workers that must load the script same-origin. The `lean.js` blob stays for both:
   it is how the script is evaluated in the worker at all, and it keeps a cross-origin boot from needing
   `Cross-Origin-Resource-Policy` (§5). That is a correction to the original plan, which assumed the blob
   was pthread-only.
4. **`src/compiler.js`** — the `SharedArrayBuffer` check is now a check on the artifact's declaration,
   and an artifact the probe could not read is deliberately *not* treated as shared: the boot will fail
   with its own explanation a moment later, and refusing to start on that basis would block a
   single-threaded build for a reason that has nothing to do with it. The compiler also exposes
   `artifact: {memory, limits, url}`, which is what the page's pill now reports.
5. **Assets** — still open, and only needed once an artifact exists: a new `leanCommit` means a new core
   layer and a manifest pairing (§5), and a fresh mirror. The wasm should come out *smaller* without TLS
   and atomics. `fetch-assets.mjs` already refuses to mix builds, so the pairing check is in place.

Verified in headless Chrome, three ways — the second and third are new behaviour, and the third is the
one that matters:

| | `SharedArrayBuffer` | result |
| --- | --- | --- |
| pthread artifact (`npm start`) | present, isolated | boots, proof accepted; `initMs 5768`, `runMs 954`. The log gains `artifact: shared memory (min 1024 pages, max 65536 pages)` and `shared memory: 2048 MB (max 65536 pages)` |
| pthread artifact, `--no-isolation` | absent | refuses, naming the artifact and both remedies, **before the boot**: a host instrumented to count bytes reports **720,896 of 17,335,349** written before the abort landed. The client read 64 KiB and cancelled; the 16.5 MiB artifact was never fetched |
| an **unshared** artifact, `--no-isolation` | absent | **passes the gate and proceeds into the boot** — the log reads `artifact: unshared memory (min 256 pages, max 32768 pages) — no cross-origin isolation needed`, and no `SharedArrayBuffer` is involved anywhere. (It then fails on the rest of the synthetic host it was pointed at, which has no library — that host is the stand-in for the artifact this is all for) |

The 720,896-byte figure is worth keeping: it is server-side bytes handed to the socket before the client's
cancel arrived, not bytes the client used, and it is the honest number for "downloads nothing" when the
response is streamed — 0.7 MB of 16.5 MiB rather than zero. The third row is the acceptance test for the
route, run against a synthetic artifact because the real one does not exist yet.

### 9.5 How to know it worked, and what was measured here

The acceptance test is the one this spike has never been able to run: boot under
`npm run start:no-isolation`, where `crossOriginIsolated === false` and `typeof SharedArrayBuffer ===
'undefined'`, and run §4's table. A proof accepted in that document is the result. Then Firefox and
Safari, which §6 records as never exercised — the payoff no Chrome-only escape hatch can give.

Measured here, so whoever builds it knows what the failure modes look like (headless Chrome 155, a
non-isolated document — `crossOriginIsolated: false`, `typeof SharedArrayBuffer: undefined`):

| probe | result |
| --- | --- |
| `new WebAssembly.Memory({initial: 1024, maximum: 65536, shared: false})` | OK, 64 MiB — and `grow` works |
| `structuredClone(unshared Memory)` / `postMessage({wasmMemory})` | `DataCloneError` |
| `Atomics.load` on an unshared buffer | OK |
| `Atomics.waitAsync` on an unshared buffer | `TypeError: … is not a shared typed array` |
| the shipped module with its memory import patched to `flags 1` | validates — and a control module whose body runs `memory.atomic.notify` executes on an unshared memory |

That last row is why the one-byte patch is not a shortcut. The module genuinely does not need the shared
flag — but `PThread.initMainThread()` spawns its 4 workers eagerly and `postMessage({wasmMemory})` to
each, so an unshared memory turns the pool into a `DataCloneError` on a `preRun` dependency and the boot
*wedges* instead of degrading. Patching would mean neutering the glue as well, and it would still be
leaning on V8 tolerating atomics on a non-shared memory, which the threads proposal says is invalid (the
glue would also throw in `Atomics.waitAsync`, above). So the byte patch is a way to *demonstrate* that the
shared flag is declarative; it is not a way to ship.

### 9.6 Until then

The current artifact cannot run without isolation, so §2's two escape hatches are the only options — and
§2 needed one correction: **`Document-Isolation-Policy` is not a trial.** It shipped in Chrome 137 for
desktop (`desktop_first: 137`, Android 146 planned; Safari's standards position is negative, Firefox's
positive but unimplemented). It is a *response header on the frame*, so unlike COOP/COEP it asks nothing
of the embedder, and it does what §2 hoped — verified here by serving a child frame with
`Document-Isolation-Policy: isolate-and-require-corp` inside a parent that sends no isolation headers at
all:

```
parent crossOriginIsolated: false          parent typeof SharedArrayBuffer: undefined
child  crossOriginIsolated: true           child  typeof SharedArrayBuffer: function
child  shared memory OK, 1048576 bytes
```

Two costs, both structural rather than temporary: it has to come from a real HTTP response, so a `srcdoc`
or `blob:` frame has nowhere to put it; and an isolated frame loses **synchronous** DOM access to
same-origin non-isolated frames — the parent's `contentWindow` read is blocked, exactly as the WICG
explainer says — so the bridge has to be `postMessage`.

That is a deployment that could ship Lean in LiveCodes in Chrome today. The single-threaded build is still
the one that ends the question, and §9.2–9.3 are what it is waiting on.

### 9.7 It builds, and it runs Lean with no isolation at all

**The build works.** `wasm-build/` — the Dockerfile, the two patches, the flags — produced an artifact that
Lean accepts proofs on, in a document that is not cross-origin isolated, with no `SharedArrayBuffer`,
served by a host that sends no COOP or COEP. Measured in headless Chrome 155, page and assets on different
origins:

```
page: crossOriginIsolated=false  typeof SharedArrayBuffer=undefined
artifact: unshared memory (min 1024 pages, max 65536 pages) — no cross-origin isolation needed
run: status=done exitCode=0 initMs=3434 runMs=53963
output: "add_comm (a b : Nat) : a + b = b + a"
```

So §9.2 and §9.3 — the two blockers quoted from the fork's own comments — are answered by the patch in
`patches/0002`, not by upstream work after all. What that patch does is §9.2's "sequential task manager"
in its smallest form: keep `-D LEAN_MULTI_THREAD`, create the manager with **zero** workers so
`g_task_manager` is never null, and make `wait_for`/`wait_any` drain the task queue on whichever thread is
waiting. The waiter becomes the worker, which is also what stops the async-const realization from
accumulating — the same change answers both blockers. The flags are §9.1's, with `-pthread` removed from
`EMSCRIPTEN_SETTINGS` (where it is unconditional) and from the generic linker block, and
`-sPTHREAD_POOL_SIZE=4` dropped.

**The artifact is the shape §9.4 predicted, and one detail of it was not.** It is a `-sMAIN_MODULE=2`
module: 97.52 MiB, importing 54 functions and nothing else, and **defining** its own memory —

```
imports: 54, by kind {0: 54}
memory section: 1 defined memory
  defined memory: flags=1 shared=false min=1024 max=65536
```

That broke the runtime's probe, which read only the *import* section — because the pthread build is the
other shape (`env.memory`, flags 3, supplied by the embedder). For this module it found nothing, reported
`unknown`, and an unknown artifact is treated as shared, so the runtime refused to run exactly the artifact
it had been changed to support. `readMemory` now reads either, and reports which, because it also decides
who constructs the memory: the embedder for an import, nobody for a definition.

The library tree matches the deployed layer exactly, which is the best evidence available that this is the
same build rather than a lookalike: packing the `Init` closure gives **629 modules, 1,887 files, 76.1 MB
raw, 5 gzip packs, 30.7 MB compressed** — the same six numbers §5 records for the layer upstream ships.

**A correction to §2, and it is about the engine's version.** In Chrome 155 a document with
`crossOriginIsolated: false` and `typeof SharedArrayBuffer === 'undefined'` still constructs a **shared
wasm memory**:

```
new SharedArrayBuffer(8):                      ReferenceError — SharedArrayBuffer is not defined
new WebAssembly.Memory({shared:true}):         OK, buffer=65536
```

§2 concluded that a shared memory implies cross-origin isolation because the constructor is gated. For wasm
memories on this engine that implication no longer holds, and it was load-bearing: the runtime's gate refused
on it, so the gate now probes the operation the runtime actually performs — constructing the memory. **But
that does not make the pthread artifact runnable without isolation, and the first pass here claimed it did
without testing it.** Measured: the pinned pthread artifact in a non-isolated page does not boot at all — the
worker stalls and the runtime reports `Starting the Lean runtime timed out after 120s`. The reason is that
Emscripten's glue gates its own threading on the `SharedArrayBuffer` *global* (`_emscripten_has_threading_support
= () => !!globalThis.SharedArrayBuffer`), which a non-isolated document does not have, so the pthread task
manager wedges no matter what the memory constructor permits. §2 was right for the artifact; only the
*inference from the constructor* was wrong. Which leaves the single-threaded build as the only one that runs
without isolation, and its ~100 s import as a cost that has to be paid or skipped.

**The cost is in the first compile, and it is large: 54 seconds.** Boot is *faster* than the pthread build
(3.4 s against 5.1–5.8 s, with no worker pool to pre-spawn), but the first `Run` on this build took
**53,963 ms** against ~0.3 s warm on the pthread build. That is the `Init` import running on one thread
with nothing to parallelize it — §9.3's "accumulates faster than one thread retires it", paid honestly
rather than avoided. Subsequent compiles in the same session reuse the imported environment and are fast,
but a LiveCodes result page pays this on first use, so it would need measuring against the pthread build's
own cold path before choosing between them.

**Atomics: still unresolved, and now with numbers.** Raw `0xFE` bytes in the code section drop from
**429,614** in the pinned pthread build to **14,390** in this one — a 30× fall that is consistent with
atomics being gone and does not establish it, since 14,390 bytes in 86 MB is about the rate operand bytes
alone would produce. A real disassembler or Firefox and Safari are the check; V8 is not, and §9.5 records
why. The harness prints the count and says this in those words rather than implying a verdict.

**One host bug fell out of it, in this repo's own `serve.js`.** The runtime probes `lean.wasm.gz` and falls
back to `lean.wasm` on a `404`; `serve.js` sent its `404` without `Access-Control-Allow-Origin`, and a
cross-origin `fetch` of a response the browser will not hand over rejects with `TypeError: Failed to
fetch` — indistinguishable from a dead network, and it named `lean.wasm.gz`, which was fine, while hiding
the absence of `lean.wasm.gz`'s sibling, which was the actual state. Error responses need the same CORS
headers as successes, and now get them.

What is left is not a build problem: publishing an artifact (~127 MB per variant), re-mirroring the library
trees it produces, and knowing whether Firefox and Safari accept a module with an unshared memory that may
still carry atomic instructions.

## 9.8 The first-run cost, eliminated — and the bug was in how the snapshot was called

The single-threaded build's import is no longer on the users' path. On the same non-isolated page, with no
`SharedArrayBuffer`: **first run 0.30 s and 0.55 s**, against **75–79 s** without a snapshot, and a
page-to-accepted-proof wall of **5.4–5.5 s** — `Lean ready` now *includes* installing a 230 MB snapshot, and
`Run #1` after it is half a second. The three measured numbers for this build now read 0.3 s (snapshot),
75–79 s (no snapshot), and 54 s (§9.7's earlier run, which had a different page payload and no library layer
in memory yet).

**The call was wrong, and that was the whole problem.** The export's signature is
`LEAN_EXPORT lean_object* lean_wasm_load_snapshot(lean_object*)` — the path is a Lean `String`, i.e. a boxed
`lean_object*`. The worker passed a **JavaScript string**, which coerces to `0` as an i32, so the loader
dereferenced a null-ish pointer and trapped with `memory access out of bounds` *before its first line ran*.
A wrong call dressed as a wrong amount of memory — and it cost a 2 GiB rebuild, which changed nothing, to
rule the memory out. The correct call is the one the compile path already used:

    const ptr = Module.stringToNewUTF8(path);
    const obj = Module._lean_mk_string(ptr);

The tell was there to read: the loader traces its own entry (`[WASM DEBUG] wasmLoadSnapshot: loading …`) and
**no trace appeared at all**. A trap below the trace means the body never started, which is an argument
problem, not a data problem. One look at the generated C (`build/wasm-*/stage1/lib/temp/Lean/Shell.c`) gave
the signature, after several rounds of guessing from the Lean side.

**The bake needed `--threads=0`.** The CLI defaults to `defaultNumThreads`, builds a real task-manager pool,
and `std::thread` fails on an artifact with no pthreads: `lean::throwable: failed to create thread`, before it
elaborates anything. Under Node that prints; in a browser the throw leaves the bake never returning, which is
what the ten-minute silence was. Zero workers routes the tasks through the same sequential path the
playground uses.

**And the cost it skips is measured, not inferred.** With the drain instrumentation left on, the CLI reports:

    [DRAIN] tasks=8 drains=1 inside_drain_ms=133907

Eight tasks, **134 s inside them**, ~17 s each, one after another. That is the import, and why no build flag
changes it. §9.4's "the drain accumulates under 5 s" measured the playground's cached `wasm_compile` path
instead of the CLI's frontend path; they are not the same work.

**Two harness bugs, both silent.** The variant argument was compared literally, so `build.sh wasm-2` skipped
the runtime patch while still writing that variant's applied-marker — and the next run trusted the marker,
skipped the reset, and built without it. Such a binary links, boots, and then panics in `IO.Promise.new`,
which reads as anything but a build problem. The tree's state is now *asked* (`git apply -R --check`) rather
than remembered, and the argument is validated. Not with `patch -R --dry-run`: in batch mode patch skips a
patch it believes is applied and still exits 0, so that check calls every patch applied. Separately, the
container runs a copy of `build.sh` baked in at image build time, so edits to the script appear to do nothing
— identical output, identical line numbers. `/w/build.sh` runs the mounted one.

**What this does not settle.** A snapshot is build-specific by construction — the loader's own doc says its
closure relocation is only correct against that binary's function table — so one must be baked per artifact,
and a 230 MB file per variant is a publishing decision rather than a technical one. Chrome is what this repo
measured; **the snapshot path was then run in Firefox and works there too** (reported, not measured here).
Safari is untested, which is the same gap the atomics count has.

## 9.9 The optional libraries are per-build, and so is every path to them

`Std`, `Lean` and `Batteries` are not packed. The runtime fetches them file by file when the compiler says
`unknown module prefix 'X'` — `src/roots.js` turns that into a fetch and a retry — so a mirror needs a second
directory beside `lean-wasm/`. Three things about it are easy to get wrong, and all three fail in a way that
looks like something else.

**The paths.** Upstream keeps the index beside the runtime and the tree one level down:
`/lean-wasm/lean-lib-files.json`, but `/lean-wasm/lean-lib/Std.olean`. Asking for `<root>/Std.olean` does not
404 — the host answers `200` with its SPA shell for every path it does not have — so all 5,598 requests come
back as 1,576 bytes of HTML and are refused one by one at the end of a two-minute run. Probe the host and read
the first bytes; a status code is worthless there.

**The build.** Upstream's tree is built by `62b6a229`, this artifact's core layer by `dfe49531`. The fetch tool
refuses the mixture, and the runtime would fail on it anyway, because an `.olean` is only readable by the
compiler that wrote it. So a fork-built artifact mirrors its *own* library, which the build tree already holds
— 32k files, of which only the `Init` closure is packed into the core layer.

**The root module.** `Std.olean` is a sibling of `Std/`, not a member of it, so a search inside the directory
misses it — and it is the module `import Std` resolves. Upstream's index lists it first
(`[ "Batteries.olean", …`), which is how the omission surfaced.

`Batteries` is absent from the tree entirely: it is not part of Lean's distribution, so a fork build cannot
serve `import Batteries` at all, and the note the runtime prints — "mirror it with `lean-wasm-fetch-assets`" —
is optimistic for this build. `mirror-lib.sh` does the mirroring and writes the plain `lean-lib-files.json`
index the runtime probes; plain rather than `.gz`, because a `.gz` index tells it to expect every module
compressed too.

**And the layout has to be enforced, not merely intended.** The runtime probes `lean-lib-files.json.gz` first,
and finding one tells it every module in that directory is `.gz`. So a stale index from the *other* layout
wins the probe and makes the whole tree unreadable: each `<module>.gz` request 404s, each 404 reads as "this
module has no such sibling", every file is skipped, and the run ends precisely where it started —
`unknown module prefix 'Std'`, with the note saying Std is not on the asset host. That is what happened here
after the modules were finally in place: upstream's `.gz` index had been left behind by a fetch whose modules
were all refused, and the plain index written afterwards was never the one being read. It also explains a
symptom worth remembering — the page reported the *note* rather than a fetch error, because from the worker's
point of view nothing had failed. `mirror-lib.sh` deletes the other layout's index rather than merely
avoiding it.

## 9.10 The same trick for the libraries: one snapshot per header

The Std demo's first run was **127.56 s**; it is now **12.84 s**. Nothing about the artifact changed — 104 s
of that was the `Std` import, and a snapshot removes an import the same way it removed `Init`'s.

Timing the phases *first* is what made this quick, and the split is worth keeping: boot 9.0 s (including the
230 MB `Init` snapshot, which has cut the first compile attempt from 75 s to ~9 s), then that attempt failing
with `unknown module prefix 'Std'`, then **5 s to fetch all 1,449 files** of the tree at 8-way concurrency,
then **104 s to load those 483 modules** — the number worth attacking, and the only one of the four a
snapshot helps.

A snapshot's cache key is the *header's import list*, read back out of the loaded environment, so it covers a
program only when the imports match exactly. `std.snap` is baked from a probe that is `import Std.Data.HashMap`
— the demo's own header — and comes out at 318 MB, 1.4× the `Init` snapshot, so it fits the same heap.
`wasm-build/bake-snapshots.sh` bakes them by name (`init`, `std`, `lean`), off-line and once.

It is loaded **on demand** rather than at boot: the on-demand path tries `snapshots/<root>.snap` before the
file tree, and then fetches the tree anyway — not as a fallback but as a necessity, because the program's
header still has to *resolve* the module it imports, and a snapshot only supplies the elaborated environment.
What it removes is the realization: the 104 s, not the 5 s.

Two caveats. It trades **318 MB on the wire** for ~104 s of compute — right for a mirror on localhost or a
LAN, and worth re-measuring against a real host, where the tree's ~10 MB compressed might be the better deal.
And the loader's verdict cannot be read on this path (the same blindness that made the `Init` snapshot's
message inconclusive), so the worker reports what it *did* — "handed the snapshot to the loader" — and lets
the run's own time be the answer.
