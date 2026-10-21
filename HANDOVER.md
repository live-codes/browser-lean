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
| `import Lean` | **9.8 s** | was 137 s; `lean.snap` + the syntax-probe fix |
| Mathlib (`Real.Basic` + `Tactic.Ring`) | **184.7 s** | was 605 s; `mathlib.snap` (408 MB) + 52 packs |

- Chrome and Firefox both confirmed. Safari and mobile have **never been tested**.
- **Re-measured on the canonical mirror (§9.15), non-isolated page, all exit 0:** Init **0.37 s**
  (boot 6.9 s), Std **6.00 s**, Lean **137 s** without a snapshot and **9.80 s** with one, Mathlib **605 s**
  without and **184.66 s** with one.
- **Lean and Mathlib *can* be snapshotted against the served tree.** `lean.snap` is 313.1 MB and loads in
  1.2 s; `mathlib.snap` is 408.0 MB and loads in 150.5 s. The save only dies when baked against the
  artifact's own build tree. The syntax probe also duplicated `import Lean`, which missed the snapshot and
  re-imported; both are fixed (§9.15).
- **Correction, measured after this was written (§9.15): the canonical artifact is Lean `dfe4953`, not
  `62b6a229`.** The binary reports it and so does `variant-2/LEAN_COMMIT`; `out/pinned-test` is the only
  binary carrying `62b6a229`. The mirror anyway works because the two library trees differ only in the
  40-byte githash in each `.olean`, and P0-1 now says the mismatch out loud instead of leaving it silent.
- **The serializer wall is tree-dependent, not absolute.** All four environments save against the served
  (62b6a229) tree and only Init/Std save against the artifact's own tree, with only a 40-byte githash per
  `.olean` differing (§9.15). The flags and the stack were never the limit.
- **Three embeds in one tab all compile.** Peak Chrome working set 4.0 GB (~0.8 GB each); boot grows from
  2.6 s alone to 24–37 s under three-way contention. The 2 GiB virtual reservation does not fail first
  (§9.16).
- `HEAD` when the P0 pass started: `b5f1fd4`. The P0 work above is **uncommitted** in the working tree
  (the mirror itself is generated and gitignored).

## 2. Canonical artifacts — and the obsolete one

| what | where | size |
| --- | --- | --- |
| **Artifact** (single-threaded, Lean `dfe4953`) | `wasm-build/out/variant-2/` — `lean.js` 45.8 MB, `lean.wasm` 97.5 MB | 143 MB |
| **Canonical mirror** | `wasm-build/out/mirror-upstream/` | 1,027 MiB, 5,672 files |
| **Obsolete mirror** | `wasm-build/out/mirror/` (the older `dfe4953` build) | 1.07 GB |

The canonical mirror is: **upstream's** core layer (`core-layer.json` + `core-lib/*.pack`), per-file lib tree
(`lean-lib/**`, 5,598 files, `.gz`), and Mathlib layer (`lean-mathlib/`: manifest + 52 packs) — plus **our**
`lean.js`/`lean.wasm`, `LEAN_COMMIT`, and **our** snapshots, gzipped: `init.snap.gz` 28.6 MB,
`std.snap.gz` 46.0 MB, `lean.snap.gz` 128.8 MB, `mathlib.snap.gz` 168.8 MB (372.1 MB total, against
901.5 MB raw; all host-baked against the served tree; §9.15). The runtime probes `.snap.gz` first and falls
back to a plain `.snap`. The layers are built by Lean `62b6a229`, the artifact by `dfe4953`; the two library
trees differ only in the `.olean` githash, and the pairing is measured working end to end (§9.15). The
artifact's own identity is what P0-1 compares against the manifests. The two large binaries also ship
gzipped and are probed first: `lean.js.gz` 2.2 MB (from 45.8 MB) and `lean.wasm.gz` 16.7 MB (from 97.5 MB).

The whole directory is one deployable unit described by **`mirror.json`** (schema 1): commits, versions,
and a sha256 of every pack, snapshot, glue file and manifest, under an id like
`lean-62b6a2291302-dfe495316874-d53cc995`. `npm run verify:mirror -- <dir>` checks a deployed copy.

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
# or, with the canonical mirror already assembled:  npm run start:canonical
```

**Bake a snapshot** — on the host, no Docker (this is the fast path now):
```
$env:BAKE_LIB_ROOT='<repo>\wasm-build\out\bake-lib'
node --stack-size=4000 wasm-build/bake-snapshot.cjs wasm-build/out/variant-2 wasm-build/out/bakeout <name> "<probe>"
# or:  node wasm-build/bake-mathlib.mjs
```
`wasm-build/out/bake-lib` is built from the mirror by `node wasm-build/build-bake-lib.mjs` (20,395 files: Init
unpacked from the core packs, Std/Lean gunzipped, Mathlib's closure unpacked from its 52 packs). **Bake against
it, not `variant-2/olean`**: the two olean sets differ only in the 40-byte githash, and the artifact's own tree
produces an environment 3.2× larger that the serializer cannot even finish for Lean (§9.15).

**Rebuild the artifact** (Docker required — the daemon must be healthy):
```
docker run --rm --entrypoint bash -w /w -v lean-build-cache:/cache -v <repo>/wasm-build:/w \
  -v <repo>/wasm-build/patches:/patches -v <repo>/wasm-build/out:/out -v <repo>/wasm-build/out/bakeout:/bakeout \
  lean4-wasm-single-threaded /w/build-upstream.sh
```
That builds `62b6a229` in `/cache/src-upstream`. **Any rebuild invalidates every snapshot** — they are
per-binary — so bake them on the host after assembling, against `bake-lib` (below and §9.15).

**Assemble a mirror from upstream's assets**: `node wasm-build/assemble-upstream-mirror.mjs`. The fetch step
now keeps `.pack` containers gzipped (trap 6) and carries the baked snapshots; `fetch-packs.mjs` remains if
you want the packs fetched verbatim. The assembly replaces any upstream `lean.wasm.gz` with ours, so the
pthread module cannot win the probe.

**Checks that exist**: `npm run check` (script syntax + generated-worker and vendored-bundle drift), `npm test`
in `packages/lean-wasm` (unit tests), `npm run test:mirror` (the mirror manifest), `npm run test:browser`
(the full browser suite against a mirror, via headless Chrome and CDP — no Playwright),
`wasm-build/verify-memory.mjs` (artifact gate: shared vs unshared memory), `npm run verify:mirror` (a mirror
against its `mirror.json`), `packages/lean-wasm/test/page.html` (the same suite by hand; it takes `?assets=`),
and `public/embeds-test.html?n=2|3` (N embeds in one tab; needs both servers above running).

---

## 4. Recommended tasks

### P0 — resolve before integrating

**P0-1. Make an artifact↔asset mismatch loud.** ✅ **Done (§9.15).** `lean-worker.js` fetches
`lean-wasm/LEAN_COMMIT` and compares it with the core and Mathlib manifests' `leanCommit`, posting one status
line per disagreeing pair; `assemble-upstream-mirror.mjs` and `fetch-assets.mjs` carry the identity. Against
the canonical mirror it names `dfe4953` against `62b6a229` at boot and the run proceeds. This is how the
handover's own artifact-commit error surfaced.

**P0-2. Regression-test the canonical mirror, and settle the snapshot-size puzzle.** ✅ **Done (§9.15).**
Against `mirror-upstream`: Init 0.37 s, Std 6.00 s, Lean 137.01 s (9.80 s with `lean.snap`), Mathlib
605.01 s (184.66 s with `mathlib.snap`), all exit 0 on a non-isolated page. The snapshot puzzle is the
tree: a host bake against `bake-lib` is 74,540,737 bytes and against `variant-2/olean` exactly the
container's 241,301,441; the two trees differ only in the 40-byte `.olean` githash. The smaller snapshots
load and seed the cache (boot 2.6 s, first run 0.21 s), so Init/Std now ship 71.1 + 109.4 MB instead of
230.1 + 318.2 MB. Lean (313.1 MB, 1.2 s to load) was still 105 s until the syntax probe stopped duplicating
`import Lean`; Mathlib (408.0 MB, 150.5 s to load) saves too and its first run is 184.66 s.

**P0-3. Memory with multiple embeds.** ✅ **Done (§9.16).** Two and three same-origin embeds in one tab
each booted and compiled, all exit 0. Peak Chrome working set was **3,515 MB for two** and **4,026 MB for
three** (~0.8 GB per embed, against the 2 GiB virtual reservation each). What degrades is boot: 2.6 s
alone, ~7 s with two, 24–37 s with three. The harness is `public/embeds-test.html?n=3`.

### P1 — packaging

**P1-1. Host the mirror.** ~1.0 GiB static (1,027 MiB; it was ~1.5 GiB with the snapshots raw), CORS `*`,
the layout above is fixed. **Every large transfer is compressed and probed first**: snapshots (`.snap.gz`,
372 MB for the four, from 902 MB raw), `lean.js.gz` (2.2 MB from 45.8 MB) and `lean.wasm.gz` (16.7 MB from
97.5 MB). What remains is the host decision: Cloudflare Pages refuses anything over 25 MiB, so the wasm and
the snapshots (`lean.snap.gz` 135 MB, `mathlib.snap.gz` 169 MB) need R2/B2/Bunny rather than Pages.

**P1-2. Publish as one versioned unit.** ✅ `mirror.json` (schema 1, written by
`wasm-build/mirror-manifest.mjs`) records the artifact/core/Mathlib commits and versions, the id, and a
sha256 of every pack, snapshot, glue file and the two manifests. `npm run verify:mirror` checks a deployed
copy against it; the canonical unit is **`lean-62b6a2291302-dfe495316874-d53cc995`** and verifies 67 files,
867.1 MiB. `THIRD-PARTY-NOTICES.md` covers the redistributed oleans and the fork. The artifact/assets
commit difference is recorded as a **note**, not a failure — it is a property of this pairing.

**P1-3. CI.** ⚠ **Partly.** `.github/workflows/ci.yml` runs `npm test`, `npm run test:mirror`, `npm run check`,
and a deterministic rebuild + drift check for the generated worker and IIFE build. `sync-worker.mjs --check`
is now part of `npm run check`, and CRLF is normalized so a Linux rebuild matches a Windows one.
`npm run test:browser` now runs the full suite against any mirror with headless Chrome and CDP — no
Playwright, no hand-made asset host — and passes against the canonical one (ESM, IIFE in a worker, Std,
syntax probe). Still open: running that suite **in CI**, which needs a cached/downloaded fixture mirror; the
canonical one is ~1 GB and the upstream fixture pays a multi-minute Lean import.

### P2 — product quality

**P2-1. Long imports are silent.** ✅ Mostly superseded (§9.15). On a host with the four snapshots the long
imports are gone — Lean 9.8 s, Mathlib 184.7 s — and the one remaining silent stretch, Mathlib's 150 s
deserialization, now posts a line before the synchronous load starts. Without a snapshot the old note
applies: the import happens inside wasm and the page says only that it is running.

**P2-2. Fix the Mathlib note.** ✅ The worker now hands the artifact/core/layer commits to the compiler
(`library` and `layer` messages carry `build`), and `unavailableImportNotes` uses them: when the artifact
and asset commits differ, the "mirror it with `lean-wasm-fetch-assets`" note adds *which* build to mirror
and says a fetch from any other build will not do. Tested in `api.test.js`, and in a real mirror without
`lean-mathlib/`: the note names both commits, and the run fails in **0.26 s** instead of 171 s because the
layer manifest is now fetched before the 408 MB snapshot is loaded.

**P2-3. Refresh the docs.** ✅ `README.md` and `wasm-build/README.md` now state the canonical pins (the
fork's default `dfe4953`, upstream-assets `62b6a229`), the mirror layout, the gzipped snapshots and the new
first-run numbers; the historical sections are marked as such rather than silently rewritten. `FINDINGS.md`
§9.15–9.16 carry the measurements.

### P3 — deferred

**P3-1. The serializer bug — the wall was the tree.** The save dies with unbounded recursion when baked
against the artifact's own build tree, but the *same* saves succeed against the 62b6a229 tree: Lean
(2,308 modules, 328.3 MB), Mathlib (3,075 modules, 427.8 MB), and Init/Std as before. The input
difference is the 40-byte `.olean` githash. The remaining question is the mechanism (hash-keyed
sharing/compaction), not a stack or a flag, and worth reporting upstream. The ceiling is now the
*deserializer*: Mathlib's 408 MB snapshot takes 150.5 s to load, against 741.5 s to import.

**P3-2. Safari and mobile.** ⚠ **Not testable here.** No Safari on Windows and Firefox is not installed on this
host, so this needs a machine with those engines. Firefox has been reported working; 14,390 `0xFE` bytes
remain in the code section, consistent with atomics being gone but not proof.

**P3-3. Shrink `lean.js`.** ✅ **Transport done.** Gzip takes 45.8 MB to **2.2 MB (20.4×)** — almost all
of it a repetitive export table — and the worker probes `lean.js.gz` first, falling back to the plain file.
Shrinking the build itself is still optional; the transfer is no longer the problem.

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
5. **A `lean.wasm.gz` must be ours, not upstream's.** The worker prefers `.gz`, so an upstream pthread module
   left beside our `lean.wasm` wins the probe and dies with `LinkError: Import #128 "env" "memory": memory
   import must be a WebAssembly.Memory`. The assembly writes our gzipped module over any upstream copy.
6. **`.pack` files are gzip containers and must stay that way.** `lean-wasm-fetch-assets` used to decompress
   them and then fail its own gzip check ("not a gzip pack"). Fixed (`keepGzip`): it writes the body as gzip,
   and re-gzips it if a CDN already handed it over decompressed. `wasm-build/fetch-packs.mjs` remains as a
   verbatim fallback.
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

- **Mechanism**, not outcome, of the snapshot-size gap: the inputs differ only in the 40-byte `.olean` githash,
  yet the saved environment is 3.2× smaller, and Mathlib's 408 MB snapshot deserializes in 150 s where Lean's
  313 MB takes 1.2 s. Hash-keyed sharing/compaction in the serializer is the likely lever; worth reporting
  upstream once the mechanism is pinned down.
- Whether a smaller initial memory (e.g. 1 GiB) is viable for multiple embeds — and worth the re-bake.
- Whether the `lean.js` *build* can be shrunk (the export table). Transport is solved: `.js.gz` is 2.2 MB.
- Safari and mobile remain untested; no Safari exists on this Windows host and Firefox is not installed here,
  so P3-2 needs a machine with those engines.

## 7. Where the detail lives

`FINDINGS.md`: §2 the isolation premise (corrected), §5 the library packs, §9.4–9.7 the import-cost
eliminations, §9.8 the snapshot loader call + `--threads=0`, §9.9 the per-build library and path rules,
§9.10 per-header snapshots and the Std 8.67 s, §9.11 the Lean save's serializer wall, §9.12 Mathlib's
compatibility routes, §9.13 the Mathlib fix and its three traps, §9.14 the 11.1 min number, §9.15 the
build-identity check, the mirror regression, the four snapshots and the syntax-probe fix, §9.16 the
multi-embed memory measurements.
