// Tests unitaires TypeScript : chaque tests/unit/*.test.ts est compilé par
// esbuild puis exécuté par le lanceur de tests intégré à Node (node --test).
import * as esbuild from 'esbuild';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'target-web', 'unit');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const files = readdirSync(join(root, 'tests', 'unit')).filter((f) => f.endsWith('.test.ts'));
await esbuild.build({
  absWorkingDir: root,
  entryPoints: files.map((f) => join('tests', 'unit', f)),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: out,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});
const r = spawnSync(process.execPath, ['--test', ...files.map((f) => join(out, f.replace(/\.ts$/, '.mjs')))], { stdio: 'inherit' });
process.exit(r.status ?? 1);
