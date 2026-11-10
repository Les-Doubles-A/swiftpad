#!/usr/bin/env node
// Contrat entre l'interface et la couche native Tauri, vérifié statiquement :
//   node scripts/check-ipc.mjs
//
// La couche Tauri ne peut pas être compilée sans crates.io ; ce script
// vérifie au moins que chaque appel `invoke('commande', { … })` de
// l'interface correspond à une commande Rust enregistrée dans
// `generate_handler!`, avec exactement les paramètres attendus (Tauri
// convertit les clés camelCase de JavaScript en snake_case de Rust) ; que les
// paramètres obligatoires (non `Option`) sont fournis ; que chaque commande
// Rust est utilisée ; que les commandes du noyau demandées par l'interface
// existent et qu'aucune commande du noyau ne reste sans usage (moindre
// privilège) ; et que les événements émis par Rust sont bien écoutés.
// Le comportement de l'interface face à ces commandes est testé à part
// (tests/e2e, « contrat avec la couche native »).

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rust = readFileSync(join(ROOT, 'src-tauri', 'src', 'main.rs'), 'utf8');
let failures = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const ko = (m) => {
  failures++;
  console.log(`  ✘ ${m}`);
};

/** Découpe `s` aux virgules de premier niveau (hors (), <>, [], {}). */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('(<[{'.includes(ch)) depth++;
    else if (')>]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Contenu entre la parenthèse ouvrante à `start` et sa fermante. */
function balanced(s, start, open = '(', close = ')') {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return s.slice(start + 1, i);
  }
  throw new Error('parenthèses non équilibrées');
}

// --- commandes Rust ------------------------------------------------------------
const INJECTED = /^(tauri::)?(Window|WebviewWindow|AppHandle|State|Webview)\b|^Request</;
const commands = new Map();
for (const m of rust.matchAll(/#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g)) {
  const params = splitTop(balanced(rust, m.index + m[0].length - 1));
  const args = [];
  for (const p of params) {
    const [name, ...ty] = p.split(':');
    const type = ty.join(':').trim();
    if (INJECTED.test(type)) continue;
    args.push({ name: name.trim(), type, optional: /^Option</.test(type) });
  }
  commands.set(m[1], args);
}
const handlerList = /generate_handler!\[([^\]]*)\]/.exec(rust);
const registered = new Set(handlerList ? splitTop(handlerList[1]) : []);

console.log('Commandes natives (src-tauri/src/main.rs)');
for (const name of commands.keys()) if (!registered.has(name)) ko(`« ${name} » est déclarée mais absente de generate_handler!`);
for (const name of registered) if (!commands.has(name)) ko(`« ${name} » figure dans generate_handler! sans #[tauri::command]`);
ok(`${commands.size} commandes déclarées et enregistrées`);

// --- appels de l'interface -----------------------------------------------------
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const snake = (k) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const used = new Set();
console.log('Appels de l’interface (src/)');
for (const file of walk(join(ROOT, 'src'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\binvoke(?:<[^>(]*(?:<[^>]*>[^>(]*)*>)?\(\s*'([a-z_]+)'\s*(,\s*)?/g)) {
    const name = m[1];
    const where = `${relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length}`;
    used.add(name);
    const expected = commands.get(name);
    if (!expected || !registered.has(name)) {
      ko(`${where} : commande « ${name} » inconnue de la couche native`);
      continue;
    }
    if (name === 'rpc') {
      // Corps binaire brut (Request), pas d'objet d'arguments.
      if (expected.length) ko(`${where} : « rpc » ne doit recevoir que le corps binaire`);
      continue;
    }
    let keys = [];
    if (m[2]) {
      const rest = src.slice(m.index + m[0].length);
      if (!rest.startsWith('{')) {
        ko(`${where} : arguments de « ${name} » non littéraux, vérification impossible`);
        continue;
      }
      keys = splitTop(balanced(rest, 0, '{', '}')).map((e) => e.split(':')[0].trim());
    }
    const got = new Set(keys.map(snake));
    const want = new Set(expected.map((a) => a.name));
    const missing = expected.filter((a) => !a.optional && !got.has(a.name)).map((a) => a.name);
    const extra = [...got].filter((k) => !want.has(k));
    if (missing.length || extra.length) ko(`${where} : « ${name} » ${missing.length ? `paramètres manquants : ${missing.join(', ')}` : ''}${extra.length ? ` inconnus : ${extra.join(', ')}` : ''}`);
    else ok(`${name}(${[...got].join(', ')})`);
  }
}
for (const name of registered) if (!used.has(name)) ko(`commande « ${name} » jamais appelée par l’interface (surface inutile)`);

// --- commandes du noyau (rpc) ----------------------------------------------------
// Toute commande demandée par l'interface doit exister dans le noyau, et
// toute commande du noyau doit servir à l'interface (moindre privilège),
// sauf les quelques commandes en lecture seule listées ci-dessous.
console.log('Commandes du noyau (crates/swiftpad-core/src/rpc.rs)');
const ALLOWED_UNUSED = {
  'recovery.list': 'lecture seule : liste des copies de récupération (diagnostic)',
  'big.info': 'lecture seule : état de l’index d’un gros fichier (banc d’essai)',
  cancel: 'interrompt une lecture en cours, ne modifie aucun fichier',
};
const core = readFileSync(join(ROOT, 'crates', 'swiftpad-core', 'src', 'rpc.rs'), 'utf8');
const dispatch = core.slice(core.indexOf('match req.cmd.as_str()'), core.indexOf('fn doc_open'));
const coreCmds = new Set([...dispatch.matchAll(/^\s*"([a-zA-Z.]+)"\s*=>/gm)].map((m) => m[1]));
const uiSrc = walk(join(ROOT, 'src')).map((f) => [f, readFileSync(f, 'utf8')]);
const uiCmds = new Set();
for (const [file, src] of uiSrc) {
  for (const m of src.matchAll(/\b(?:rpc|call)(?:<[^>(]*(?:<[^>]*>[^>(]*)*>)?\(\s*'([a-zA-Z.]+)'/g)) {
    uiCmds.add(m[1]);
    if (!coreCmds.has(m[1])) ko(`${relative(ROOT, file)}:${src.slice(0, m.index).split('\n').length} : commande « ${m[1]} » inconnue du noyau`);
  }
}
for (const c of coreCmds) {
  if (uiCmds.has(c)) continue;
  if (ALLOWED_UNUSED[c]) ok(`${c} : non appelée par l’interface (${ALLOWED_UNUSED[c]})`);
  else ko(`commande « ${c} » du noyau jamais appelée par l’interface (surface inutile)`);
}
ok(`${uiCmds.size} commandes appelées par l’interface, toutes présentes dans le noyau (${coreCmds.size} au total)`);

// --- événements ------------------------------------------------------------------
console.log('Événements natifs');
const emitted = new Set([...rust.matchAll(/\.emit\(\s*"swiftpad:\/\/([a-z-]+)"/g)].map((m) => m[1]));
const native = readFileSync(join(ROOT, 'src', 'core', 'native.ts'), 'utf8');
const union = /onNativeEvent<T>\(name:\s*([^,]+),/.exec(native);
const listened = new Set(union ? [...union[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]) : []);
const app = walk(join(ROOT, 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
for (const e of emitted) {
  if (!listened.has(e)) ko(`événement « swiftpad://${e} » émis mais non écoutable`);
  else if (!new RegExp(`onNativeEvent[^(]*\\(\\s*'${e}'`).test(app)) ko(`événement « swiftpad://${e} » jamais écouté`);
  else ok(`swiftpad://${e} émis par Rust et écouté par l’interface`);
}
for (const e of listened) if (!emitted.has(e)) ko(`événement « ${e} » attendu par l’interface mais jamais émis`);

console.log(failures ? `\n${failures} incohérence(s).` : '\nContrat interface ↔ couche native cohérent.');
process.exit(failures ? 1 : 0);
