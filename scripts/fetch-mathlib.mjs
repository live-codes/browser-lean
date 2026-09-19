/**
 * Mirror the Mathlib layer into public/lean-mathlib/.
 *
 * Upstream publishes Mathlib only as a *packed layer* — the 4,303-module closure
 * its Real Analysis game needs, compiled against the same Lean commit as the
 * binaries we pin (`62b6a229`). There is no per-file Mathlib tree to fetch
 * lazily, and no all-of-Mathlib layer either: upstream says a full Mathlib
 * environment snapshot was tested and deliberately not shipped because
 * compaction exceeded the practical wasm heap.
 *
 *   node scripts/fetch-mathlib.mjs [--force]
 *
 * ~316 MiB compressed. Resumable: existing packs are skipped.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UPSTREAM = process.env.LEAN_UPSTREAM || 'https://lean.cau.li/lean-wasm';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'lean-mathlib');
const MANIFEST = 'real-analysis-layer.json';
const force = process.argv.includes('--force');

const mb = (n) => (n / 1048576).toFixed(1) + ' MiB';

async function fetchRetry(url, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  return null;
}

async function main() {
  await mkdir(ROOT, { recursive: true });

  const manifestPath = join(ROOT, MANIFEST);
  if (!existsSync(manifestPath) || force) {
    const body = await fetchRetry(`${UPSTREAM}/${MANIFEST}`);
    if (!body) throw new Error(`could not fetch ${MANIFEST}`);
    await writeFile(manifestPath, body);
    console.log(`manifest: ${mb(body.length)}`);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  console.log(
    `layer: ${manifest.modules} modules, ${manifest.files.length} files, ` +
      `${mb(manifest.bytes)} raw / ${mb(manifest.compressedBytes)} compressed, ${manifest.packs.length} packs`,
  );
  console.log(`leanCommit: ${manifest.leanCommit} (binaries are pinned to the same build)\n`);

  let bytes = 0;
  let skipped = 0;
  for (const [index, pack] of manifest.packs.entries()) {
    const dest = join(ROOT, pack.file);
    if (!force && existsSync(dest)) {
      bytes += (await stat(dest)).size;
      skipped += 1;
      continue;
    }
    const body = await fetchRetry(`${UPSTREAM}/real-analysis-lib/${pack.file}`);
    if (!body) throw new Error(`${pack.file} is missing upstream`);
    await writeFile(dest, body);
    bytes += body.length;
    console.log(`  ${index + 1}/${manifest.packs.length}  ${pack.file}  ${mb(body.length)}  (total ${mb(bytes)})`);
  }

  console.log(
    `\ndone: ${manifest.packs.length} packs, ${mb(bytes)}` +
      (skipped ? ` (${skipped} already present)` : ''),
  );
  console.log('mirrored into public/lean-mathlib/');
}

main().catch((err) => {
  console.error('\nfailed:', err.message);
  process.exit(1);
});
