// Lanceur des tests de bout en bout.
//   node tests/e2e/run.mjs              → tous les tests
//   node tests/e2e/run.mjs motif        → tests dont le nom contient « motif »
// Prérequis : `npm run build:web` et le harnais compilé
// (`cargo build --release --manifest-path crates/swiftpad-core/Cargo.toml --bin swiftpad-harness`).
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { closeBrowser, HARNESS, DIST, ROOT } from './lib.mjs';

const files = ['editing', 'writing', 'files', 'markdown', 'robustness', 'native'];
const TEST_TIMEOUT_MS = 120_000;
const filter = process.argv[2]?.toLowerCase();
if (!existsSync(HARNESS)) {
  console.error(`Harnais introuvable : ${HARNESS}`);
  process.exit(2);
}
if (!existsSync(join(DIST, 'index.html'))) {
  console.error('Interface non compilée : npm run build:web');
  process.exit(2);
}
const all = [];
for (const f of files) {
  const p = new URL(`./${f}.test.mjs`, import.meta.url);
  if (!existsSync(p)) continue;
  const mod = await import(p);
  for (const t of mod.tests) all.push({ ...t, file: f });
}
const selected = all.filter((t) => !filter || t.name.toLowerCase().includes(filter) || t.file === filter);
const results = [];
const t0 = Date.now();
for (const t of selected) {
  const start = Date.now();
  try {
    // Délai maximal par test : un test bloqué (boîte de dialogue inattendue…)
    // échoue au lieu de bloquer toute la suite.
    let timer;
    await Promise.race([t.fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`délai de ${TEST_TIMEOUT_MS / 1000} s dépassé`)), TEST_TIMEOUT_MS)))]).finally(() => clearTimeout(timer));
    results.push({ name: t.name, file: t.file, ok: true, ms: Date.now() - start });
    console.log(`  ✔ ${t.name} (${Date.now() - start} ms)`);
  } catch (e) {
    results.push({ name: t.name, file: t.file, ok: false, ms: Date.now() - start, error: String(e?.stack ?? e) });
    const where = String(e?.stack ?? '').split('\n').find((l) => l.includes('.test.mjs')) ?? '';
    console.log(`  ✘ ${t.name}\n      ${String(e?.message ?? e).split('\n').join('\n      ')}\n      ${where.trim()}`);
  }
}
await closeBrowser();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} réussis en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
mkdirSync(join(ROOT, 'target-web'), { recursive: true });
writeFileSync(join(ROOT, 'target-web', 'e2e-results.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
process.exit(failed.length ? 1 : 0);
