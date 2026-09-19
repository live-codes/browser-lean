/**
 * Mirror the optional Lean libraries (Std, Lean, Batteries) into public/lean-lib/.
 *
 * The core layer only covers the Init closure. Everything else lives as
 * individual files in upstream's static `lean-lib/` tree, indexed by
 * `lean-lib-files.json`, and is fetched on demand (see FINDINGS.md §5). This
 * script mirrors that tree for the libraries we want to support, so the page can
 * load them lazily from our own origin.
 *
 *   node scripts/fetch-libs.mjs [roots...] [--force]
 *
 * Roots default to Std Lean Batteries. Resumable: existing files are skipped.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UPSTREAM = process.env.LEAN_UPSTREAM || 'https://lean.cau.li/lean-wasm';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'lean-lib');
// The index sits inside the library root so the worker needs exactly one base URL
// for it and the files.
const INDEX_PATH = join(ROOT, 'lean-lib-files.json');
const force = process.argv.includes('--force');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ROOTS = positional.length ? positional : ['Std', 'Lean', 'Batteries'];
const CONCURRENCY = 16;

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
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  return null;
}

async function main() {
  await mkdir(ROOT, { recursive: true });

  // The index of every module file upstream publishes. Small, and the worker
  // needs it too, so it is mirrored alongside the files.
  let index;
  if (existsSync(INDEX_PATH) && !force) {
    index = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
    console.log(`index: reusing lean-lib-files.json (${index.length} modules)`);
  } else {
    const body = await fetchRetry(`${UPSTREAM}/lean-lib-files.json`);
    if (!body) throw new Error('could not fetch lean-lib-files.json');
    index = JSON.parse(body.toString('utf8'));
    await writeFile(INDEX_PATH, body);
    console.log(`index: fetched lean-lib-files.json (${index.length} modules)`);
  }

  const selected = index.filter((p) => ROOTS.some((r) => p === `${r}.olean` || p.startsWith(`${r}/`)));
  console.log(`roots: ${ROOTS.join(', ')} → ${selected.length} modules\n`);

  // Each module ships three files; the runtime only uses an .ir when its
  // .ir.sig is present, so all three must arrive.
  const targets = [];
  for (const module of selected) {
    targets.push(module);
    targets.push(module.replace(/\.olean$/, '.ir'));
    targets.push(module.replace(/\.olean$/, '.ir.sig'));
  }

  let done = 0;
  let bytes = 0;
  let skipped = 0;
  let missing = 0;
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      const rel = targets[i];
      const dest = join(ROOT, rel);

      if (!force && existsSync(dest)) {
        const { size } = await stat(dest);
        bytes += size;
        skipped += 1;
        done += 1;
        continue;
      }

      const body = await fetchRetry(`${UPSTREAM}/lean-lib/${rel}`);
      if (!body) {
        missing += 1;
      } else {
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, body);
        bytes += body.length;
      }
      done += 1;

      if (done % 500 === 0) {
        console.log(`  ${done}/${targets.length} files, ${mb(bytes)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(
    `\ndone: ${done} files, ${mb(bytes)} written` +
      (skipped ? `, ${skipped} already present` : '') +
      (missing ? `, ${missing} not published upstream` : ''),
  );
  console.log(`mirrored into public/lean-lib/ — run \`npm start\` to use it`);
}

main().catch((err) => {
  console.error('\nfailed:', err.message);
  process.exit(1);
});
