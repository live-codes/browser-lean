# Build a single-threaded Lean wasm

This builds the artifact that removes the cross-origin isolation requirement entirely, instead of living
with it or working around it. `FINDINGS.md` §9 is the analysis; this directory is the machinery, and
§9.1–§9.3 should be read first, because **the flags are the easy part and the build will not work
without the runtime change.**

What it produces: `lean.js`, `lean.wasm` and the `.olean` tree for `wasm32`, whose memory import is
`flags 1` — unshared — instead of `flags 3` — `has-max | shared`. An unshared memory needs no
`SharedArrayBuffer`, so a page needs no COOP/COEP, no `Document-Isolation-Policy` and no origin trial,
and works in every browser rather than only Chrome. The runtime in this repo already handles that
artifact: it reads the mode off the wasm before booting
([`packages/lean-wasm/src/artifact-probe.js`](../packages/lean-wasm/src/artifact-probe.js)), so it needs
no changes to consume what this builds.

## Status: the harness is checked, the build is not

**No artifact has been produced yet.** What is known so far is from attempting it: the image builds, the
patches apply, and the first `make stage1` fails in stage0 — for a reason that turned out to be upstream's
recipe and not this one (`## What the fork's own Docker recipe gets wrong`, below). The build is expected
to take hours once it gets past that, so this README is explicit about what is verified and what is not.

The two blockers below are quoted from the fork's own source, which is the strongest evidence available
without a completed build; the *ordering* of them is a prediction, and variant 1 exists to test it.

What has been checked, because each is cheap and each would otherwise waste hours: the patches apply
cleanly to the pinned revision (generated from the real files, after hand-counted hunks turned out to be
miscounted, and verified with `git apply --check`), and `verify-memory.mjs` correctly *rejects* the
artifact this project ships today — `shared`, min 1024 / max 65536, exit 1 — while counting the 429,614
atomic-prefix bytes a single-threaded build has to beat.

## Prerequisites

- Docker, with ~15 GB of free disk and 8 GB+ of RAM. The fork's own note: the first build takes 30–60
  minutes, incremental relinks are minutes.
- Network access for the fork clone (~1 GB) and the emsdk download.

## Running it

```bash
cd wasm-build
docker build -t lean4-wasm-single-threaded .

# Variant 1: the flags only. This is expected to FAIL, and how it fails is the point.
docker run --rm -v "$PWD/out:/out" -v "$PWD/cache:/cache" lean4-wasm-single-threaded 1

# Variant 2: flags plus the sequential task manager. This is the one that should work.
docker run --rm -v "$PWD/out:/out" -v "$PWD/cache:/cache" lean4-wasm-single-threaded 2
```

On Windows, give both mounts absolute paths and use `--mount` if the drive letter confuses the parser:

```powershell
docker run --rm --mount type=bind,source=D:/repo/wasm-build/out,target=/out `
                --mount type=bind,source=D:/repo/wasm-build/cache,target=/cache `
                lean4-wasm-single-threaded 2
```

**Mount `cache` — it is not optional in practice.** It holds the pinned fork and the cmake build tree, so
a relink after a change to patch 0002 is minutes instead of another full build:

```bash
docker run --rm -v "$PWD/out:/out" -v "$PWD/cache:/cache" -e MAKE_TARGET=lean lean4-wasm-single-threaded 2
```

Each variant gets its own build directory (`build/wasm-1`, `build/wasm-2`), so switching between them does
not reconfigure a tree the other one built. `-e EMSCRIPTEN_DEBUG=ON` adds a name section and assertions,
which is worth the extra build when a wasm trap needs symbolising.

Artifacts land in `out/<variant>/` — `lean.js`, `lean.wasm`, `olean/`, the resolved `LEAN_COMMIT`, and
`applied.patch` (what the build actually applied, for provenance). Each run ends by telling you to read
the memory import out of the wasm it just built, using the runtime's own parser, so the first thing you
look at is either `unshared` or a statement of why the artifact is not what was asked for.

## Variant 1: the flags only — expected to fail, and why that is useful

`patches/0001-cmake-single-threaded.patch` removes `-pthread`, `-sPTHREAD_POOL_SIZE=4` and friends. It is
mechanical, and on its own it produces exactly the failure the fork's CMake describes (l.201–204):

> 4.33's import machinery creates IO.Promises during env realization, and without LEAN_MULTI_THREAD the
> task manager is a no-op, so Promise.new panics by design. A single-thread (no COOP/COEP, phone-sized)
> build needs a sequential task manager upstream first.

The mechanism, from `src/runtime/object.cpp`: `lean_init_task_manager_using` is entirely inside
`#if defined(LEAN_MULTI_THREAD)`, so with the macro off there is no manager at all, and
`lean_promise_new` (l.1281) panics "by design" rather than return something that can never be resolved.
Six more promise/IO paths dereference `g_task_manager` unchecked.

The second blocker is the one that decides whether the route is shippable (l.176–180):

> The single-threaded WASM build OOMs during the `Init` olean import (upstream's async-const realization
> accumulates unboundedly with no worker threads to drain it); the pthread build — like the native and
> the older 4.28 WASM builds — drains that work on real worker threads.

Run variant 1 to find out which of these you hit first, and how. That is the measurement this directory
cannot hand you.

## Variant 2: the flags plus a sequential task manager

`patches/0002-sequential-task-manager.patch` is the part that needs the build loop to converge. Its
design is deliberately the *smallest* change that can work, and it differs from the direction the fork's
comment implies — worth knowing before choosing:

Both variants drop `-pthread`, which is what produces the unshared memory. They differ in whether they
also drop `-D LEAN_MULTI_THREAD`:

| | `-D LEAN_MULTI_THREAD` | what then has to change |
| --- | --- | --- |
| the fork's suggestion | dropped | the promise and IO paths, which are compiled in either way but assume a manager — a sequential manager, or null-handling at seven call sites |
| **what this patch does** | **kept** | only `task_manager` in `src/runtime/object.cpp` |

Keeping the macro is smaller and it sidesteps the panic rather than working around it: with the macro on,
the manager *exists*, so `lean_promise_new`, `resolve`, `wait_any`, `get_task_state` and `cancel` all have
something to talk to, and no call site needs an `#ifdef`. The change is:

1. Create the manager with zero workers instead of skipping it, so `g_task_manager` is never null.
2. **Drain on wait.** With no workers, nothing retires a queued task, so `wait_for` and `wait_any` must
   run the queue themselves rather than sleep on a condition variable that nothing will signal. This is
   the "sequential task manager": the waiter becomes the worker.
3. Set `g_current_task_object` while draining, so a nested `wait_for` inside a drained task behaves the
   way the existing `in_pool` logic expects.

Item 2 is also the answer to the OOM blocker: the async-const realization is drained *by the import loop
that is waiting on it*, instead of queueing faster than one thread can retire it.

The risk to watch: `wait_for` contains a guard for `(sync := true)` tasks — "`Task.get` called from a
`(sync := true)` task" — which exists to catch a deadlock in the threaded runtime. In a single-threaded
runtime every wait is effectively synchronous, so that guard's intent has to be preserved while its
trigger is re-examined; if `Init` import trips it, that is the line to look at. The patch keeps the guard
and adds the drain ahead of it, which is the conservative choice.

## What the artifact must satisfy

1. **It builds**, and `verify-memory.mjs` says `unshared`, min/max printed.
2. **No atomic instructions.** Removing `-pthread` should be what guarantees this, and it must hold: the
   threads proposal says atomic instructions are invalid against an unshared memory, so a conformant
   engine rejects the module rather than running it. V8 is lenient here — measured in §9.5 — which is
   exactly why this cannot be checked on Chrome alone.

   There is a number to beat: the pinned pthread artifact has **429,614** bytes in its code section that
   look like the atomic instruction prefix, and a single-threaded build should have none.
   `verify-memory.mjs` counts them as a first pass and says plainly that it is only that — 0xFE can occur
   inside an operand, so a non-zero count means "disassemble it", while zero is strong evidence. The real
   check is Firefox and Safari.
3. **It runs the §4 table** in the demo, served with `npm run start:no-isolation`, with
   `crossOriginIsolated === false` and `typeof SharedArrayBuffer === 'undefined'`.
4. **It matches the pinned build's behaviour otherwise**: same compiles, same `.olean`/`.ir` layout, same
   message format, so the runtime and the mirrors need no special cases.

Then mirror it the usual way (`npm run assets` against the new host), re-run
`packages/lean-wasm/test/*` and `test/page.html`, and record the result in `FINDINGS.md` §9 — including
the parts that turned out to be wrong, which is how §0 and §6.1 got written.

## What the fork's own Docker recipe gets wrong

`docker-wasm/` in `cauli/lean4` is the obvious place to start and it is stale in four ways, all found by
building rather than reading. The Dockerfile and build.sh here are adapted from it with these fixed, and
each is worth knowing before trusting anything else in it:

1. **`cmake>=3.28` now installs CMake 4.x**, and under CMake 4 this build compiles *stage0* with the
   Emscripten toolchain instead of the native 32-bit clang that `-DSTAGE0_CMAKE_CXX_COMPILER=clang++`
   asks for. It fails a few seconds into `make stage1` with
   `em++: error: passing any of -msse2 ... requires passing -msimd128` — the stage0 flags are native-x86
   flags, and they are being handed to a wasm compiler. Pinned to `<4` here.
2. **`EMSDK_NODE` is pinned to a Node version that no longer exists.** The Dockerfile hardcodes
   `node/20.18.0_64bit/bin/node`; emsdk 4.0.22 now fetches 24.19.0, and `emcc` prefers `EMSDK_NODE` over
   `node` on `PATH` when it is set — so the pin points at nothing. Removed here; `emsdk_env.sh` sets it
   correctly and `build.sh` sources that.
3. **Its build.sh prints "single-threaded; no lean.worker.js"** while its README documents `-pthread`
   with `PTHREAD_POOL_SIZE=4` — and the deployed artifacts have the worker pool. The comment is wrong;
   the README is right. That is a small thing to be wrong about, but it is the one thing this directory
   is *about*, so it is worth not trusting.
4. **`-DUSE_MIMALLOC=OFF` is in the CI but not in that build.sh**, so it configures and builds mimalloc
   for wasm — which `src/CMakeLists.txt` says cannot work under Emscripten ("mimalloc's OS layer can't
   grow memory under Emscripten"). Passed here, matching the CI.

The authoritative reference is the CI, not `docker-wasm/`: `.github/workflows/ci.yml` has the wasm job's
`CMAKE_OPTIONS`, and `build-template.yml` has its emsdk version (4.0.22) and the `--preset release` the
job configures with. Where this harness and `docker-wasm/` disagree, the CI wins — and where the CI and
the two of them disagree about whether the result is pthread-linked, the artifact does.

## Files

```
Dockerfile                              emsdk 4.0.22, 32-bit stage0, cmake >= 3.28, < 4 — see above
build.sh                                clone the fork at the pinned commit, patch, configure, build, report
patches/0001-cmake-single-threaded.patch     the flags
patches/0002-sequential-task-manager.patch   the runtime change (unvalidated — see above)
verify-memory.mjs                       reads the memory import out of a built wasm, using the package's parser
```

Pinned: `cauli/lean4` @ `reinstate-wasm` `dfe49531687435bcb38516a73a7c7ff55e3ef25e` (2026-09-06). The
`.olean` files it produces are only compatible with this same build, which is the pairing `FINDINGS.md`
§5 records — do not mix them with the pthread artifacts.
