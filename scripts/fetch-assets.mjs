/**
 * Mirror the Lean WASM artifacts into public/lean-wasm/.
 *
 * These are the artifacts built by https://github.com/cauli/lean4-wasm-in-browser
 * (the `reinstate-wasm` fork of leanprover/lean4) and deployed to lean.cau.li.
 * We mirror rather than hotlink them for a measured reason: lean.js and lean.wasm
 * are served through a Cloudflare Function that sets
 * `Cross-Origin-Resource-Policy: same-origin` and sends no
 * `Access-Control-Allow-Origin`, so a page on another origin cannot fetch them.
 * (The static pack files under /lean-wasm/ *do* send `Access-Control-Allow-Origin: *`,
 * but pinning the whole set locally keeps one version story.)
 *
 *   node scripts/fetch-assets.mjs [--force]
 *
 * Nothing here is committed; public/lean-wasm/ is gitignored. Run this once
 * after cloning.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UPSTREAM = process.env.LEAN_UPSTREAM || 'https://lean.cau.li/lean-wasm';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'lean-wasm');
const force = process.argv.includes('--force');

/**
 * The binaries are served by a Cloudflare Function that routes on `?v=`, and the
 * *unversioned* URL is a different, much older build: lean.js 85 MiB and
 * lean.wasm 131 MiB, whose `.olean` files are incompatible with the packed core
 * layer (loading it fails with "incompatible header"). The versioned build is
 * lean.js 148 KB — the compact explicit export list that replaces Emscripten's
 * export-everything glue — and lean.wasm 96 MiB.
 *
 * So this must stay pinned, and must agree with the layer it is paired with. The
 * build script upstream enforces the same pairing and aborts on a mismatch; we
 * assert the version against the manifest's `leanCommit` below.
 */
const ASSET_VERSION =
  process.env.LEAN_ASSET_VERSION || '62b6a2291302d4bbeace37642a066b7510d0145c-dlsym1-compact1';

const BINARIES = ['lean.js', 'lean.wasm'];

const mb = (n) => (n / 1048576).toFixed(1) + ' MiB';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url, dest) {
  if (!force && (await exists(dest))) {
    const { size } = await stat(dest);
    console.log(`  skip   ${dest.replace(ROOT, '.')} (${mb(size)})`);
    return size;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let received = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
  }
  const body = Buffer.concat(chunks);
  await writeFile(dest, body);
  const label = dest.replace(ROOT, '.');
  console.log(`  fetch  ${label}  ${mb(body.length)}${total && total !== body.length ? ` (content-length said ${mb(total)})` : ''}`);
  return body.length;
}

async function main() {
  await mkdir(join(ROOT, 'core-lib'), { recursive: true });

  console.log(`Mirroring Lean artifacts from ${UPSTREAM} into public/lean-wasm/\n`);

  let total = 0;

  // The manifest names the packs, and carries the per-entry offsets used to
  // unpack them, so it has to come first.
  console.log('manifest:');
  await download(`${UPSTREAM}/core-layer.json`, join(ROOT, 'core-layer.json'));
  const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(ROOT, 'core-layer.json'), 'utf8'));
  total += (await stat(join(ROOT, 'core-layer.json'))).size;

  console.log('binaries:');
  // Refuse to pair a binary with a layer it was not built with — that mismatch
  // shows up only at runtime, as "failed to read file '/lib/lean/Init.olean',
  // incompatible header".
  if (!ASSET_VERSION.startsWith(manifest.leanCommit)) {
    throw new Error(
      `asset version "${ASSET_VERSION}" does not belong to the layer's Lean commit ` +
        `"${manifest.leanCommit}" — refusing to mix builds`,
    );
  }
  console.log(`  pinned build: ${ASSET_VERSION}`);
  for (const name of BINARIES) {
    total += await download(`${UPSTREAM}/${name}?v=${encodeURIComponent(ASSET_VERSION)}`, join(ROOT, name));
  }

  console.log(`packs (${manifest.modules} modules, ${manifest.packs.length} packs):`);
  for (const pack of manifest.packs) {
    total += await download(`${UPSTREAM}/core-lib/${pack.file}`, join(ROOT, 'core-lib', pack.file));
  }

  console.log(
    `\ntotal on disk: ${mb(total)}\n` +
      `manifest says: ${mb(manifest.bytes)} raw, ${mb(manifest.compressedBytes)} compressed, ` +
      `${manifest.files.length} files in ${manifest.modules} modules`,
  );
  console.log('\nRun `npm start` to serve the page.');
}

main().catch((err) => {
  console.error('\nfailed:', err.message);
  process.exit(1);
});
