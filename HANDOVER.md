# Handover — Lean 4 in the browser, without cross-origin isolation

**The goal this repo answers:** run Lean 4 (kernel, Std, Lean, Mathlib) in a page that is *not* cross-origin
isolated — no COOP/COEP, no `SharedArrayBuffer` — so it can be embedded in LiveCodes without the embedder adding
headers. That is done and measured. This document is the state, the canonical artifacts, the tasks that remain,
and the traps that already cost time once.

Read `FINDINGS.md` for the measurements behind every number here; §9 is the current chapter.

---

## 1. State at handover

Working, verified on a non-isolated page (`crossOriginIsolated: false`, `typeof SharedArrayBuffer === "undefined"`):

| program | first Run | note |
| --- | --- | --- |
| nothing (`#check 2+2`) | **0.30–0.9 s** | was 75–79 s; Init snapshot |
| `import Std.Data.HashMap` | **8.67 s** | was 127.56 s; Std snapshot + file tree |
| `import Lean` | ~4.6 min | import only; **no snapshot possible** |
| Mathlib (`Real.Basic` + `Tactic.Ring`) | works, **~11.1 min** first import | layer loads (52/52 packs); **no snapshot possible** |

- Chrome and Firefox both confirmed. Safari and mobile have **never been tested**.
- Lean and Mathlib cannot be snapshotted: the save dies in unbounded recursion inside Lean's compacted-region
  serializer (`FINDINGS.md` §9.11, §9.14). Sixteen times the wasm stack changes nothing. That is an upstream Lean
  bug, and it is why those two stay slow. Threads would fix it and are exactly what this project removed.
- `HEAD` at handover: `3245e82`. Tree clean (apart from `.commandcode/taste/`, which is tool-managed).

## 2. Canonical artifacts — and the obsolete one

| what | where | size |
| --- | --- | --- |
| **Artifact** (single-threaded, Lean `62b6a229`) | `wasm-build/out/variant-2/` — `lean.js` 45.8 MB, `lean.wasm` 97.5 MB | 143 MB |
| **Canonical mirror** | `wasm-build/out/mirror-upstream/` | 1.18 GB, 5,664 files |
| **Obsolete mirror** | `wasm-build/out/mirror/` (the older `dfe4953` build) | 1.07 GB |

The canonical mirror is: **upstream's** core layer (`core-layer.json` + `core-lib/*.pack`), per-file lib tree
(`lean-lib/**`, 5,598 files, `.gz`), and Mathlib layer (`lean-mathlib/`: manifest + 52 packs) — plus **our**
`lean.js`/`lean.wasm` and **our** snapshots (`init.snap` 230.1 MB, `std.snap` 318.2 MB). Every asset in it is
built by Lean `62b6a229`; that is the whole reason it works, since an `.olean` is only readable by the compiler
that wrote it.

**The old mirror is obsolete**: `patches/0001-cmake-single-threaded.patch` was re-pointed at `62b6a229`, so the
`dfe4953` build can no longer be reproduced from this repo (only its files survive). Delete `out/mirror` and fix
anything that still assumes one mirror.

Docker volume `lean-build-cache` holds both build trees (`/cache/src` = dfe4953, `/cache/src-upstream` =
62b6a229), `/cache/node24` (needed — Node 22 refuses this artifact's 104,692 exports), and
`/cache/mathlib-meta` (a blobless Mathlib clone used for the compatibility investigation).

## 3. How to run things

**Demo** (start servers *detached* — see traps):
```
Start-Process node -ArgumentList 'serve.js','8129','public','--no-isolation' -WorkingDirectory <repo>
Start-Process node -ArgumentList 'serve.js','8131','wasm-build/out/mirror-upstream' -WorkingDirectory <repo>
# then open http://localhost:8129/?baseUrl=http://localhost:8131
```

**Bake a snapshot** — on the host, no Docker (this is the fast path now):
```
$env:BAKE_LIB_ROOT='<repo>\wasm-build\out\bake-lib'
node wasm-build/bake-snapshot.cjs wasm-build/out/variant-2 wasm-build/out/bakeout <name> "<probe>"
# or, for the demo's Mathlib header:  node wasm-build/bake-mathlib.mjs
```
`wasm-build/out/bake-lib` is built from the mirror by `node wasm-build/build-bake-lib.mjs` (20,395 files: Init
unpacked from the core packs, Std/Lean gunzipped, Mathlib's closure unpacked from its 52 packs).

**Rebuild the artifact** (Docker required — the daemon must be healthy):
```
docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v <repo>/wasm-build:/w \
  -v <repo>/wasm-build/patches:/patches -v <repo>/wasm-build/out:/out -v <repo>/wasm-build/out/bakeout:/bakeout \
  lean4-wasm-single-threaded /w/build-upstream.sh
```
That builds `62b6a229` in `/cache/src-upstream`, then bakes `init` and `std` against it. **Any rebuild invalidates
every snapshot** — they are per-binary.

**Assemble a mirror from upstream's assets**: `node wasm-build/assemble-upstream-mirror.mjs`, then
`node wasm-build/fetch-packs.mjs wasm-build/out/mirror-upstream` (the fetch tool refuses every valid `.pack` — see
traps), and make sure **no `lean.wasm.gz`** is left beside our `lean.wasm`.

**Checks that exist**: `npm run check` (script syntax + vendored bundle in sync), `npm test` in
`packages/lean-wasm` (unit tests), `wasm-build/verify-memory.mjs` (artifact gate: shared vs unshared memory),
`packages/lean-wasm/test/page.html` (the browser suite that reports ALL PASS — it currently points at its own
asset host, not the shipped mirror).

---

## 4. Recommended tasks

### P0 — resolve before integrating

**P0-1. Make an artifact↔asset mismatch loud.** (why) Every asset is one build, and nothing enforces it; a
mismatch is *silent* — the snapshot is refused and the run merely gets slow, or an olean fails deep in the kernel.
(do) Both manifests carry the build: `core-layer.json` → `"version": "lean-core-62b6a22913"`, Mathlib's →
`"version": "lean-4.33.0-pre-62b6a229-real-analysis"`. Compare the hex runs at load and post a status line when
they differ. A sketch of this was written in §9.12 and reverted unverified; `lean-worker.js` already fetches both
manifests. (verify) Point a page at the *old* mirror and expect a message naming both builds.

**P0-2. Regression-test the canonical mirror, and settle the snapshot-size puzzle.** (why) The 8.67 s Std number
was measured on the *old* mirror; the shipped `init.snap`/`std.snap` (230/318 MB) have never been loaded against
the shipped artifact. Worse, a host-baked Init-only snapshot came out **71.1 MB** where the container produced
**230.1 MB** for the same header — unexplained, and if the shipped ones are wrong the failure mode is "just slow".
(do) Run, against `mirror-upstream`: an import-free program, the Std program, the Lean program, Mathlib. Record
`initMs`/`runMs`/log for each. Then re-bake Init on the host and compare sizes and behaviour. (verify) Std first
run should be ≈8–9 s; anything near 127 s means the snapshot was refused.

**P0-3. Memory with multiple embeds.** (why) The artifact defines a **2 GiB initial / 4 GiB max** memory and a
256 MB stack, per page. LiveCodes may put several embeds on one page; this is the likeliest integration failure.
(do) Load 2–3 embeds (or 3 iframes) and measure the tab's memory and whether any fails. If it must shrink, relink
with `LEAN_INITIAL_MEMORY` smaller and **re-bake every snapshot**. (verify) All embeds reach `ready` and a compile.

### P1 — packaging

**P1-1. Host the mirror.** ~1.18 GB static, CORS `*`, the layout above is fixed. Two specific decisions:
`lean.js` is **45.8 MB uncompressed** and the loader fetches it plainly (gzip it, or shrink the build); and the
snapshots are **548 MB** of the total — consider gzipping them (measure compressibility; the runtime would need a
`DecompressionStream` path, which the wasm loader already has).

**P1-2. Publish as one versioned unit.** Artifact + core + lib + Mathlib + snapshots must ship together; see
P0-1. Add the licence notices for the redistributed oleans (Lean and Mathlib are Apache-2.0;
`packages/lean-wasm/THIRD-PARTY-NOTICES.md` exists and needs to cover the assets, not just code).

**P1-3. CI.** `npm test`, `npm run check`, and the browser test page run against a *fixture* host built by
`build-bake-lib.mjs`/`fetch-assets.mjs`, so the suite stops depending on a hand-made mirror.

### P2 — product quality

**P2-1. Long imports are silent.** During Lean's ~4.6 min and Mathlib's ~11.1 min the page shows the layer
loading and then nothing, because the import happens inside wasm. Post a status line naming the module count and
why it is slow; otherwise it reads as broken.

**P2-2. Fix the Mathlib note.** `src/roots.js` advises "mirror it with `lean-wasm-fetch-assets`", which cannot
help against an artifact built by a different Lean. Correct for the package's usual host, wrong here — see §9.12
for the shape of the fix (compare builds before advising).

**P2-3. Refresh the docs.** `README.md` and `wasm-build/README.md` predate the switch to `62b6a229`; they should
state the canonical pin, that the patch targets only that commit, and the mirror layout.

### P3 — deferred

**P3-1. The serializer bug.** Reproduce minimally (a `--incr-header-save` of `import Lean`, ~4.6 min, then
`Maximum call stack size exceeded` / `memory access out of bounds` in `wasm-function[83475]` ↔ `[5197]`) and
report upstream. Until then Lean and Mathlib stay slow; a working save would make both snapshot-able and take
them to seconds.

**P3-2. Safari and mobile.** Untested. Firefox works, which is encouraging; 14,390 `0xFE` bytes remain in the code
section, consistent with atomics being gone but not proof.

**P3-3. Shrink `lean.js`.** 45.8 MB is the largest single transfer after the wasm.

---

## 5. Traps that already cost time — do not rediscover these

1. **The snapshot loader takes a `lean_object*`, not a JS string.** A JS string coerces to `0` as an i32, and the
   loader traps with `memory access out of bounds` *before its first line runs* — which reads exactly like memory
   exhaustion. Box it: `stringToNewUTF8` → `_lean_mk_string`. `§9.8`.
2. **The CLI bake needs `--threads=0`.** Otherwise it builds a real thread pool and `std::thread` fails
   (`failed to create thread`); in a browser that throw means the bake never returns. `§9.8`.
3. **One snapshot per header, and per binary.** The cache key is the header's import list read back out of the
   loaded env, so a probe must *be* the program's imports. Any relink invalidates every snapshot. `§9.10`, `§9.11`.
4. **`lean-lib` layout**: index at `<base>/lean-lib-files.json[.gz]`, modules at `<base>/lean-lib/<path>`. Enforce
   one layout: a stale `.gz` index wins the probe and silently makes every module 404. `§9.9`, `§9.13`.
5. **Never leave `lean.wasm.gz` beside our `lean.wasm`** — the worker prefers `.gz`, so it fetches upstream's
   pthread module and dies with `LinkError: Import #128 "env" "memory": memory import must be a WebAssembly.Memory`.
6. **`lean-wasm-fetch-assets` refuses every valid `.pack`** ("not a gzip pack") because the body reaches its check
   already decompressed. Use `wasm-build/fetch-packs.mjs`.
7. **Upstream's lib index is `lean-lib-files.json.gz`**, so probing the plain name reads as a failure when the
   directory is fine.
8. **The host does 200-with-HTML for paths it lacks.** Never trust a status code — read the first bytes. `§9.13`.
9. **Patch discipline**: regenerate, never hand-edit hunks (the `@@` counts break and `patch` refuses the file).
   Test applied-ness with `git apply -R --check`, *not* `patch -R --dry-run` (batch mode exits 0 on skip).
10. **Bake on Windows**: `process.cwd` must be presented as `/` (the glue chdirs the *virtual* FS to it, and a
    drive-rooted value joins into the NODEFS mount as `<work>/D:\`). Also give it `/home`, `/tmp`, `HOME`,
    `TMPDIR`. `§9.14`.
11. **Bakes need `--stack-size=4000`** for the JS stack; the wasm stack is a link knob
    (`LEAN_WASM_STACK_SIZE`, default 16 MiB, the shipped artifact at 256 MiB).
12. **Tooling**: `set -x` build logs plus PowerShell's `2>&1` can hang a call — poll through `cmd /c` instead.
    Docker Desktop wedges under a full `make -j`; check progress via files in the bind mounts (`out/variant-2`,
    `out/bakeout`), not `docker logs`.
13. **Background servers started with the agent tool's `run_in_background` get killed.** Use detached
    `Start-Process`, then probe a *real* path — `/` on the asset host legitimately 404s and `Invoke-WebRequest`
    throws on that.

## 6. Open questions

- Why a host-baked Init snapshot was 71.1 MB where the container's was 230.1 MB, for the same header.
- Whether the shipped `init.snap`/`std.snap` actually load against the shipped artifact (unmeasured).
- Whether a smaller initial memory (e.g. 1 GiB) is viable for multiple embeds — and worth the re-bake.
- Whether `lean.js` can be gzipped or built smaller.

## 7. Where the detail lives

`FINDINGS.md`: §2 the isolation premise (corrected), §5 the library packs, §9.4–9.7 the import-cost
eliminations, §9.8 the snapshot loader call + `--threads=0`, §9.9 the per-build library and path rules,
§9.10 per-header snapshots and the Std 8.67 s, §9.11 the Lean save's serializer wall, §9.12 Mathlib's
compatibility routes, §9.13 the Mathlib fix and its three traps, §9.14 the 11.1 min number.
