# Third-party notices

`@live-codes/lean-wasm` is MIT. It **bundles no third-party JavaScript** — `dist/lean-wasm.global.js`
contains only this package's own code — and it **redistributes no compiler artifacts**. What follows
is what the runtime is made of and who owns it.

## What the package fetches at runtime

The assets are downloaded by `lean-wasm-fetch-assets` or fetched from the `baseUrl` you pass. They are
not included in this package, so their licences attach to their own files and not to this one.

| component | licence | source |
| --- | --- | --- |
| Lean 4 compiler and standard libraries (`Init`, `Std`, `Lean`, `Batteries`) | Apache-2.0 | [leanprover/lean4](https://github.com/leanprover/lean4) |
| The `lean.wasm` / `lean.js` build and its wasm entry points (`lean_wasm_compile`, `lean_wasm_reset`, `lean_wasm_load_snapshot`) | Apache-2.0 | [cauli/lean4](https://github.com/cauli/lean4), a fork of leanprover/lean4, on its `wasm-*` branches |
| The packed core layer, the per-file library tree and the Mathlib layer | Apache-2.0 | [cauli/lean4-wasm-in-browser](https://github.com/cauli/lean4-wasm-in-browser) |
| Mathlib (the 4,303-module closure the layer carries) | Apache-2.0 | [leanprover-community/mathlib4](https://github.com/leanprover-community/mathlib4) |

## What this package's code is derived from

One file is adapted rather than written from scratch, and the notice belongs with it:

- **`src/runtime-worker.js`** (generated from `worker/lean-worker.js`) is derived from
  `lean-worker-persistent.worker.js` in
  [cauli/lean4-wasm-in-browser](https://github.com/cauli/lean4-wasm-in-browser) (Apache-2.0). The
  init sequence, the export names it calls, and its reading of the fork's IO result tags come from
  there. What differs is documented in the file: the library is fetched and unpacked inside the
  worker instead of being handed over from the page, `lean.js` is bootstrapped from a same-origin blob
  so a cross-origin asset host works, and the syntax probe is this project's own.

Everything else — the asset resolution, the library and layer loading, the message classification,
the syntax probe and the IIFE build — is original to this project and MIT.

## Tooling

`esbuild` is a **devDependency** used only to produce `dist/lean-wasm.global.js`. It is not a runtime
dependency and nothing it bundles ends up in the published artifact beyond a sidecar comment.
