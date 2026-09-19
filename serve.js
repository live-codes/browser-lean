/**
 * A static server for this demo.
 *
 * It exists because `file://` cannot run ES modules or fetch the wasm assets, and
 * because the Lean runtime is a pthread build whose memory is declared `shared`:
 * `WebAssembly.Memory({ shared: true })` can only be constructed in a
 * cross-origin isolated document, so this server sets COOP/COEP.
 *
 * That is a measured requirement, not a guess — `lean.wasm` imports a memory with
 * limits flags `3` (has-max | shared), min 256 pages, max 32768 pages. See
 * FINDINGS.md §2 for how that was read off the artifact.
 *
 *   node serve.js [port] [root] [--no-isolation] [--spa-fallback]
 *
 * `root` defaults to `public/` and is resolved against this file.
 * `--no-isolation` omits COOP/COEP, which is how the isolation failure is reproduced.
 * `--spa-fallback` answers a missing file with `index.html` and a `200`, the way
 * Cloudflare Pages does when it has a fallback configured. That is not an obscure
 * host quirk to tolerate: it is what made a broken import look like a successful
 * download, so it is worth being able to reproduce on demand.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const noIsolation = argv.includes('--no-isolation');
const spaFallback = argv.includes('--spa-fallback');
const positional = argv.filter((arg) => !arg.startsWith('-'));

const PORT = Number(positional[0] ?? 8129);
const ROOT = resolve(fileURLToPath(new URL('./', import.meta.url)), positional[1] ?? 'public');

// Nothing here maps URLs to files except the root itself, because a deployed static host cannot do
// that either: the page must work from the files alone. An earlier version mounted the package
// directory at `/vendor/lean-wasm/` so the page could import its ES module entry, which worked here
// and 404ed on Cloudflare Pages — where the SPA fallback answered with `index.html`, so the browser
// refused the module for having MIME type `text/html`. The build is vendored into `public/vendor/`
// by `npm run sync:vendor` instead, and this server is deliberately as dumb as the host.

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  const base = ROOT;
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = normalize(join(base, rel));

  if (!filePath.startsWith(normalize(base))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }

  let served = filePath;
  let body;
  try {
    body = await readFile(filePath);
  } catch {
    // Opt-in impersonation of a host with a fallback: the file is missing, so it answers with its
    // shell and a `200`. That is how a wrong URL comes to look like a successful download, and how a
    // module import ends up refused for having MIME type `text/html`.
    if (!spaFallback) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: /${rel}`);
      return;
    }
    served = join(base, 'index.html');
    body = await readFile(served);
  }

  const headers = {
    'Content-Type': TYPES[extname(served).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // The page itself is small and changes; the ~800 MB of Lean assets are
    // fetched once and cached by the browser, not here.
    'Cache-Control': 'no-store',
    // A CDN hosting the three asset directories needs both of these, and they are
    // not interchangeable:
    //   Access-Control-Allow-Origin  — for the fetch()ed binaries and layer packs
    //   Cross-Origin-Resource-Policy — for lean.js, which the worker pulls in with
    //                                  importScripts(), a no-cors request that
    //                                  COEP checks against CORP, not against CORS
    // Without the second, the boot fails with "Failed to execute 'importScripts'
    // ... failed to load" even though every other asset arrived fine.
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };

  if (!noIsolation) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
  }

  res.writeHead(200, headers).end(body);
});

server.listen(PORT, () => {
  console.log(`browser-lean: http://localhost:${PORT}/`);
  console.log(
    `serving ${ROOT} — cross-origin isolation ${noIsolation ? 'OFF (--no-isolation)' : 'ON (required)'}`,
  );
  if (noIsolation) {
    console.log('note: Lean cannot boot without COOP/COEP — this mode is only for showing the failure');
  }
  console.log('the Lean artifacts are mirrored locally — run `npm run assets` first (~127 MB)');
  console.log('press Ctrl+C to stop');
});
