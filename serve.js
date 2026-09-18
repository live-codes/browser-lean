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
 *   node serve.js [port] [root] [--no-isolation]
 *
 * `root` defaults to `public/` and is resolved against this file. Pass
 * `--no-isolation` to omit COOP/COEP, which is how the failure is reproduced.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const noIsolation = argv.includes('--no-isolation');
const positional = argv.filter((arg) => !arg.startsWith('-'));

const PORT = Number(positional[0] ?? 8129);
const ROOT = resolve(fileURLToPath(new URL('./', import.meta.url)), positional[1] ?? 'public');

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
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = normalize(join(ROOT, rel));

  if (!filePath.startsWith(normalize(ROOT))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }

  let body;
  try {
    body = await readFile(filePath);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: /${rel}`);
    return;
  }

  const headers = {
    'Content-Type': TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    // The page itself is small and changes; the ~310 MB of Lean assets are
    // fetched from the CDN and cached by the browser, not here.
    'Cache-Control': 'no-store',
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
