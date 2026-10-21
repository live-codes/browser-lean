# Running a wasm toolchain without cross-origin isolation

Notes from building **Lean 4 in the browser with no COOP/COEP and no `SharedArrayBuffer`**, written to be
portable: the diagnosis method, the three routes and why one won, what the compile-time work involved, and a
checklist. The case study is Lean; §5 is about Elixir/BEAM specifically, where I have not worked and the
questions are marked as questions.

**TL;DR** — the isolation requirement comes from *threads*, not from the language. Prove the requirement from the
artifact (it is sometimes phantom), prefer a genuinely single-threaded build, expect the work to be in the
runtime's thread assumptions rather than in compiler flags, and never patch a third-party artifact's memory flag
as a shortcut. If threads are unavoidable, an isolated **cross-origin child frame** is the architecture that
keeps them without imposing anything on the embedder.

---

## 1. Locate the blocker before solving it

The chain is: `-pthread` at compile time → atomics/TLS in every object → the linker demands a **shared** memory →
a shared memory needs `SharedArrayBuffer` → that needs a cross-origin isolated document.

Prove each link from the artifact, not from documentation:

- **Parse the wasm memory section.** Is the memory *imported* (`env.memory`, so the embedder supplies it) or
  *defined by the module*? What are the flags (`has-max | shared`)? A `shared` memory is the real requirement;
  anything else is a symptom.
- **Read the glue.** Does it construct `new WebAssembly.Memory({ shared: true })`? Does it gate threading on
  `!!globalThis.SharedArrayBuffer`?
- **Count `0xFE` bytes** in the code section (the atomics prefix). A count consistent with operand bytes alone is
  not proof, but a large one is a strong hint atomics remain.
- **Boot it in a non-isolated page** with a trivial program and read the failure verbatim. Serve the same page
  with and without the headers so the failure stays reproducible — my demo server has a `--no-isolation` switch
  for exactly this — and the message will name the layer that objects.

**Confirm the requirement is real.** A sibling project here (`browser-cobol`) believed it needed isolation and did
not: a stray `instanceof` test on artifacts whose memories were all `shared: false`. Lean's is genuinely in the
artifact, and no shim substitutes for it. Both conclusions come from the same check.

## 2. Three routes

**A. Headers (COOP: same-origin + COEP: require-corp) — not available to an embedder.** Cross-origin isolation is
inherited from the top-level document, so a page cannot give itself headers. This is exactly why embeds of
threaded toolchains (here: `browser-elixir`) could not be made to work cleanly inside someone else's page.

**B. Chrome escape hatches — interim only.**

- The **reverse origin trial for `SharedArrayBuffer` on desktop**, which grants the buffer without isolation. On a
  deprecation path, and it is the same mechanism Chrome has extended repeatedly since the Chrome 92 restriction.
- **`Document-Isolation-Policy`**, which does ship (Chrome 137 desktop) and applies **per frame**, so it needs
  nothing from the embedder. But: Chrome-only, it needs a real HTTP response, and it gives up synchronous
  same-origin DOM access.

Both are Chrome-only. Treat them as a stopgap, not the plan.

**C. A single-threaded artifact — chosen.** No headers, no Chrome-only behaviour, works in every browser
(verified Chrome and Firefox). The isolation requirement comes from threads, not from the language.

**Explicitly rejected: patching the wasm's `shared` flag and neutering `PThread` in the glue.** It validates, and
V8 will happily run atomics on unshared memory — then `PThread.initMainThread()` posts the memory to four workers
and you get a `DataCloneError`. Three patches into a third-party artifact, one engine's behaviour, no
portability. Do not do this.

## 3. What the fix actually required

**Build without `-pthread`.** That drops atomics/TLS from every object and — the part that matters — stops the
linker demanding a shared memory. The resulting module **defines** an unshared memory (`flags=1`, min/max pages)
rather than importing `env.memory`, so the embedder constructs nothing at all.

**Fix the runtime's thread assumptions. This is the real work, not the flags.** A toolchain runtime usually
expects a task manager, and with no threads two things break: promises panic ("called before the task manager is
running"), and awaited tasks never complete ("cannot make progress"). One patch fixed both in Lean: create the
manager with **zero workers**, so the global manager is never null, and make `wait_for`/`wait_any` **drain the
queue on the waiting thread**. Sequential rather than concurrent, but correct.

**Make the loader tolerant of both memory shapes.** My artifact probe understood only an *imported* memory, so it
read the new build as `unknown` and refused to run the very artifact it was there to support — it now reads a
*defined* memory too. It also gated on `globalThis.SharedArrayBuffer`, which current Chrome no longer ties to the
constructor; it now probes the operation the runtime actually performs.

**Verify with numbers.** `flags=1 shared=false`; atomic-prefix bytes 429,614 → 14,390 (consistent with atomics
gone, not proof); boot and compile in a non-isolated page on two engines.

## 4. Compile time — what transfers

First runs went from **75–79 s → 0.30 s** (import-free program) and **127.56 s → 8.67 s** (`import Std.Data.HashMap`).

**Measure the phases before optimising.** Five flag-level explanations were eliminated (optimisation level,
exports, memory growth, the drain loop, the manager itself) before the cause was clear: the cost was the
*realisation* of the import — eight tasks, ~17 s each, run serially. Timestamp boot, first attempt, fetch, and
import separately. Assuming a cause cost me three wrong attempts.

**A persistent worker is the cheapest big win.** Initialise the runtime once and reuse it across compiles. It costs
nothing to adopt and removes repeated initialisation entirely.

**Warm state — only if your runtime can serialise it.** Lean's approach: bake the post-import environment off-line
with the *same binary* (`--incr-header-save`), ship it, and load it at startup so the first compile hits an
environment cache instead of importing. Three constraints that will bite anyone:

- **Build-specific.** The snapshot embeds closure relocations valid only against that binary's function table. Any
  rebuild invalidates every snapshot, and a mismatch fails *silently* — as slowness, or deep inside the runtime.
- **Keyed by the import list.** One snapshot per header, and the probe must *be* that header (same imports, same
  order). Not a general cache.
- **Signatures matter.** Lean's loader takes a *boxed* language string, not a JavaScript string. A JS string
  coerced to `0`, the loader trapped **before its first print**, and it read exactly like running out of memory.
  That cost a rebuild and hours; read the generated C signature rather than guessing from the source.

**Do not optimise the network first.** Fetching 1,449 files took 5 s; loading them took 104 s.

**Know the ceiling.** Two of Lean's environments (2,308 and 3,075 modules) *cannot* be snapshotted: the save dies
in unbounded recursion inside the compacted-region serialiser, and sixteen times the wasm stack reproduces it
unchanged. So warm state is not universal — test with a mid-size probe before betting on it. If it fails, the
honest options are warming at page load (moving the cost) or accepting it.

**Two cheap lessons worth copying regardless.** Put a **timeout on every asset fetch** — a dead host hung the boot
past the host's own limit and looked like a broken build. And make **version mismatches loud**: compare build
strings in the manifests; a silent fallback reads as "slow", not "wrong".

## 5. For Elixir / BEAM specifically

Not my territory — treat these as questions to check, not findings.

**BEAM is the hard version of this problem.** Lean tolerated a serial task manager; BEAM's schedulers *are* the
runtime. So: **can your wasm build run with a single scheduler, or without atomics at all?** If yes, §3 applies
directly — remove `-pthread`, then find and replace the runtime's thread assumptions one at a time, booting in a
non-isolated page after each change to read the next error. If no, "single-threaded artifact" is off the table and
the answer changes.

**If threads are genuinely required, use an isolated child frame.** Isolation is per-frame for a *cross-origin*
iframe, so serve the compiler from its own origin (`compiler-sandbox.<domain>`) with COOP/COEP, plus CORP/CORS on
its assets, and let the embedding page set nothing, talking over `postMessage`. That keeps threads *and* works in
every browser — which the Chrome-only hatches do not. Use `Document-Isolation-Policy` as the stopgap when you want
it in-page, and the origin trial as a last resort.

**Do not** patch the artifact's memory flags to dodge it; that path ends in `DataCloneError`.

**Compile time**: the analogue of Lean's import is your one-time cost — VM boot, stdlib/beam loading, module
compilation. If the runtime has no warm-state mechanism, the levers that remain are the persistent worker and
warming at page load. Measure the phases first: if the one-time cost is *fetching* rather than *computing*, none
of the snapshot machinery is worth building.

## 6. Checklist

1. Prove the requirement from the artifact — memory imported vs defined, flags, glue, atomics count. It may be
   phantom.
2. Reproduce the failure verbatim in a non-isolated page before changing anything.
3. Prefer a single-threaded build; expect the work in the runtime's thread assumptions, not the compiler flags.
4. Never patch a third-party artifact's memory flag as a shortcut.
5. If threads are unavoidable: isolated cross-origin child frame with COOP/COEP; the embedder sets nothing.
6. Keep the runtime in a persistent worker; measure boot / fetch / initialise / compile separately.
7. Warm state only if it is build-matched, header-keyed, versioned as a unit — and check the ceiling early.
8. Make failures loud: timeouts on fetches, explicit messages for refused warm state and version mismatch.
