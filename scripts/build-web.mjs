// Compilation de l'interface avec esbuild (une seule dépendance d'outillage).
//   node scripts/build-web.mjs          → dist/ minifié (production)
//   node scripts/build-web.mjs --dev    → dist/ non minifié avec sourcemaps
//   node scripts/build-web.mjs --serve  → serveur de développement sur
//                                         http://127.0.0.1:1420 (tauri dev)
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const serve = process.argv.includes('--serve');
const dev = serve || process.argv.includes('--dev');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'assets'), { recursive: true });
cpSync(join(root, 'index.html'), join(dist, 'index.html'));

/** @type {esbuild.BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir: 'dist/assets',
  entryNames: '[name]',
  chunkNames: '[name]-[hash]',
  target: ['chrome110'],
  minify: !dev,
  sourcemap: dev ? 'linked' : false,
  legalComments: 'none',
  charset: 'utf8',
  metafile: true,
  logLevel: 'warning',
  define: { 'import.meta.env.DEV': dev ? 'true' : 'false' },
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, host: '127.0.0.1', port: 1420 });
  console.log(`SwiftPad (dev) : http://127.0.0.1:${port}/`);
} else {
  const result = await esbuild.build(options);
  writeFileSync(join(root, 'dist', 'meta.json'), JSON.stringify(result.metafile));
  // Résumé des tailles (suivi de la légèreté).
  const sizes = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (!p.endsWith('meta.json')) sizes.push([p.slice(dist.length + 1), statSync(p).size]);
    }
  };
  walk(dist);
  const total = sizes.reduce((a, [, s]) => a + s, 0);
  for (const [f, s] of sizes.sort()) console.log(`${(s / 1024).toFixed(1).padStart(8)} Ko  ${f}`);
  console.log(`${(total / 1024).toFixed(1).padStart(8)} Ko  total dist/`);
  // Licences des dépendances intégrées.
  const mdit = JSON.parse(readFileSync(join(root, 'node_modules/markdown-it/package.json'), 'utf8'));
  writeFileSync(
    join(dist, 'assets', 'LICENSES.txt'),
    `SwiftPad intègre :\n- markdown-it ${mdit.version} (MIT) et ses dépendances : entities (BSD-2-Clause), linkify-it (MIT), mdurl (MIT), punycode.js (MIT), uc.micro (MIT).\nTextes complets : voir le dépôt (THIRD_PARTY_LICENSES.md).\n`,
  );
}
