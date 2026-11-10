#!/usr/bin/env node
// Vérification statique « hors ligne et moindre privilège » :
//   node scripts/check-offline.mjs
//
// Complète le test de bout en bout « aucune requête réseau », qui observe
// les requêtes réelles pendant un scénario complet. Ici, on vérifie le code et
// la configuration : aucune URL distante dans l'interface compilée, aucune API
// réseau dans le code TypeScript (hors appel local /rpc du harnais), CSP sans
// origine distante, noyau Rust sans dépendance ni accès réseau, permissions
// Tauri minimales. Code de sortie 1 si une vérification échoue.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (msg) => console.log(`  ✔ ${msg}`);
const ko = (msg, details = []) => {
  failures++;
  console.log(`  ✘ ${msg}`);
  for (const d of details.slice(0, 20)) console.log(`      ${d}`);
};

/** Lignes d'une section TOML (jusqu'à la section suivante). */
function tomlSection(toml, name) {
  const lines = toml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s*\[/.test(l)) break;
    if (l.trim() && !l.trim().startsWith('#')) out.push(l.trim());
  }
  return out;
}

function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}
const rel = (p) => relative(ROOT, p);

// 1. Interface compilée : aucune URL distante.
console.log('Interface compilée (dist/)');
const dist = join(ROOT, 'dist');
if (!existsSync(join(dist, 'index.html'))) ko('dist/ absent : lancer « npm run build:web » avant cette vérification');
else {
  // Espaces de noms XML (identifiants, jamais chargés).
  const allowed = new Set(['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xhtml', 'http://www.w3.org/1999/xlink']);
  const found = [];
  for (const f of walk(dist, (p) => /\.(js|css|html|json)$/.test(p) && !p.endsWith('meta.json'))) {
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\b(?:https?|wss?|ftp):\/\/[^\s"'`)<>\\]+/g)) {
      // « http://${…} » : préfixe ajouté par markdown-it (linkify) pour écrire
      // un lien « www.… » ; ce n'est pas une ressource, et les liens du rendu
      // sont neutralisés (jamais suivis sans confirmation).
      if (allowed.has(m[0]) || m[0].includes('${')) continue;
      found.push(`${rel(f)} : ${m[0]}`);
    }
    // URL relative au protocole (//exemple.com/…) dans un attribut src/href ou url().
    for (const m of text.matchAll(/(?:src|href)\s*=\s*["']\/\/[^"']+|url\(\s*["']?\/\/[^)]+/g)) found.push(`${rel(f)} : ${m[0]}`);
  }
  if (found.length) ko('URL distantes dans l’interface compilée', found);
  else ok('aucune URL distante (seuls des espaces de noms XML, jamais chargés)');
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const ext = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]).filter((u) => !u.startsWith('assets/') && !u.startsWith('./assets/'));
  if (ext.length) ko('index.html référence des ressources hors de assets/', ext);
  else ok('index.html ne charge que des fichiers locaux (assets/)');
}

// 2. Code TypeScript : aucune API réseau hors du transport local du harnais.
console.log('Code de l’interface (src/)');
{
  const bad = [];
  const apis = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|importScripts)\b\s*\(?/g;
  for (const f of walk(join(ROOT, 'src'), (p) => p.endsWith('.ts'))) {
    const lines = readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const m of line.matchAll(apis)) {
        // Seule exception : fetch('/rpc') du harnais de test (chemin relatif, même origine).
        if (m[1] === 'fetch' && rel(f) === join('src', 'core', 'rpc.ts') && /fetch\(\s*'\/rpc'/.test(line)) continue;
        bad.push(`${rel(f)}:${i + 1} : ${line.trim()}`);
      }
      if (/\beval\s*\(|new\s+Function\s*\(/.test(line)) bad.push(`${rel(f)}:${i + 1} (eval) : ${line.trim()}`);
    });
  }
  if (bad.length) ko('API réseau ou eval dans le code de l’interface', bad);
  else ok('aucun fetch/XHR/WebSocket/eval (hors appel local « /rpc » du harnais de test)');
}

// 3. Politique de sécurité du contenu (Tauri et harnais identiques).
console.log('Politique de sécurité du contenu (CSP)');
{
  const conf = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const csp = conf.app?.security?.csp ?? '';
  const harness = readFileSync(join(ROOT, 'crates', 'swiftpad-core', 'src', 'bin', 'harness.rs'), 'utf8');
  const remote = [...csp.matchAll(/(https?:\/\/[^\s;]+)/g)].map((m) => m[1]).filter((u) => u !== 'http://ipc.localhost');
  if (!csp) ko('CSP absente de tauri.conf.json');
  else if (remote.length) ko('origines distantes dans la CSP', remote);
  else ok('CSP sans origine distante (connect-src limité à self et à l’IPC locale)');
  if (/unsafe-inline|unsafe-eval|\*/.test(csp)) ko('CSP trop permissive (unsafe-inline, unsafe-eval ou joker)', [csp]);
  else ok('CSP sans unsafe-inline, unsafe-eval ni joker');
  if (!harness.includes(csp)) ko('la CSP du harnais diffère de celle de Tauri (les tests ne vérifieraient pas la même politique)');
  else ok('même CSP dans le harnais de test et dans Tauri');
  if (conf.app?.security?.assetProtocol?.enable !== false) ko('protocole asset: actif (accès disque direct depuis la page)');
  else ok('protocole asset: désactivé (fichiers lus uniquement via le noyau)');
}

// 4. Noyau Rust : aucune dépendance externe, aucun accès réseau.
console.log('Noyau Rust (crates/swiftpad-core)');
{
  const toml = readFileSync(join(ROOT, 'crates', 'swiftpad-core', 'Cargo.toml'), 'utf8');
  const deps = tomlSection(toml, 'dependencies');
  if (deps.length) ko('dépendances externes dans le noyau', deps);
  else ok('aucune dépendance externe');
  const net = [];
  for (const f of walk(join(ROOT, 'crates', 'swiftpad-core', 'src'), (p) => p.endsWith('.rs') && !p.includes(join('src', 'bin')))) {
    readFileSync(f, 'utf8')
      .split('\n')
      .forEach((l, i) => {
        if (/std::net|TcpStream|TcpListener|UdpSocket|std::process::Command/.test(l) && !/^\s*\/\//.test(l)) net.push(`${rel(f)}:${i + 1} : ${l.trim()}`);
      });
  }
  if (net.length) ko('accès réseau ou lancement de processus dans le noyau', net);
  else ok('ni réseau ni lancement de processus (le harnais de test, binaire séparé, écoute sur 127.0.0.1 uniquement)');
}

// 5. Couche Tauri : dépendances et permissions minimales.
console.log('Couche native (src-tauri)');
{
  const toml = readFileSync(join(ROOT, 'src-tauri', 'Cargo.toml'), 'utf8');
  const deps = tomlSection(toml, 'dependencies').map((l) => l.split(/\s*=/)[0]);
  const expected = ['tauri', 'tauri-plugin-dialog', 'tauri-plugin-opener', 'tauri-plugin-single-instance', 'serde', 'swiftpad-core'];
  const extra = deps.filter((d) => !expected.includes(d));
  if (extra.length) ko('dépendances non prévues', extra);
  else ok(`dépendances : ${deps.join(', ')}`);
  const cap = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'capabilities', 'default.json'), 'utf8'));
  const perms = cap.permissions ?? [];
  const allowedPerms = ['core:event:allow-listen', 'core:event:allow-unlisten'];
  const extraPerms = perms.filter((p) => !allowedPerms.includes(typeof p === 'string' ? p : p.identifier));
  if (extraPerms.length) ko('permissions supplémentaires accordées à la page', extraPerms.map(String));
  else ok('page limitée à l’écoute d’événements ; aucun accès direct des greffons (dialogues, ouverture) depuis la page');
  const main = readFileSync(join(ROOT, 'src-tauri', 'src', 'main.rs'), 'utf8');
  if (/http|reqwest|ureq|TcpStream/.test(main.replace(/"http", "https", "mailto"|http\(s\)|https?:\/\/|"https?"/g, ''))) {
    // Tolère les mentions des schémas autorisés pour open_url.
    const lines = main.split('\n').filter((l) => /reqwest|ureq|TcpStream/.test(l));
    if (lines.length) ko('client réseau dans la couche native', lines);
    else ok('aucun client réseau dans la couche native');
  } else ok('aucun client réseau dans la couche native');
}

console.log(failures ? `\n${failures} vérification(s) en échec.` : '\nToutes les vérifications hors ligne sont satisfaites.');
process.exit(failures ? 1 : 0);
