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
  without deploying COOP or COEP, regardless of the isolation status of the page around it.

So Lean *could* ship in LiveCodes today behind one of these. Both are Chrome-only and both are trials
or flags that can be withdrawn, so the honest default is to treat isolation as unavailable and prefer a
**single-threaded Lean wasm build**, which needs none of this and works in every browser.

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
  packed layer. `scripts/fetch-assets.mjs` pins `?v=` and refuses to mix builds, and reports the
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

- `scripts/fetch-libs.mjs` (`npm run assets:libs`) mirrors the tree for Std / Lean / Batteries into
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

## 6. Limitations

- **Syntax errors are silently accepted.** This is the most surprising finding, and it is measured,
  not inferred. `def broken : Nat :=`, `#eval (1 +`, and `def x : Nat := 5` followed by `@@@` all
  produce **empty stdout, empty stderr, `success: true`** — the page reports "accepted". Elaboration
  and kernel errors *are* reported, with positions. So the fork's compile entry appears to drop parse
  failures before they reach the message channel. For a playground this is a real gap: a typo gets no
  feedback. It is worth reporting upstream; until then the page cannot distinguish "your proof is
  fine" from "your file did not parse".
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
   whole question. This is a build-and-release task against cauli's build or the Lean FRO's wasm work.
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

with `public/lean-worker.js` and the severity classifier from `public/main.js` carrying over almost
unchanged, and the `{output, error, exitCode}` contract filled from the severity split in §3 —
`information` messages become `output`, everything else becomes `error`. `exitCode` must be derived
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
