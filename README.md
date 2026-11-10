# SwiftPad

Dépôt GitHub : **https://github.com/Les-Doubles-A/swiftpad**

Un écran pour écrire. Éditeur de texte sobre et léger pour Windows : une
colonne de texte centrée, une barre de menus discrète, des onglets qui
n'apparaissent qu'à partir de deux documents, et rien d'autre à l'écran.
**Local, hors ligne, sans compte, sans télémétrie, sans IA.**

Tauri 2 · noyau Rust sans dépendance · interface TypeScript sans framework.

---

## ⚠️ État de cette livraison — ce qui a été vérifié, et ce qui ne l'a pas été

Le développement a eu lieu dans un conteneur **Linux** sans accès à crates.io,
sans Windows et sans PowerShell. En conséquence :

| Élément | État |
|---|---|
| Noyau Rust (`swiftpad-core`) : compilation et tests | ✅ **vérifié** (Linux) — 83 tests unitaires, 6 d'intégration, erreurs système réelles |
| Interface : types, compilation de production, tests unitaires | ✅ **vérifié** |
| Application complète (interface réelle + noyau réel) | ✅ **vérifiée dans Chromium** via le harnais de test : 50 tests de bout en bout |
| Contrat interface ↔ couche native (12 commandes natives, 3 événements) et interface ↔ noyau (commandes RPC) | ✅ **vérifié** : contrôle statique (`npm run check:ipc`) et test de bout en bout avec Tauri simulé |
| Couche native Tauri (`src-tauri/src/main.rs`) | ⚠️ **partiellement vérifiée** : `cargo check` contre des *stubs* écrits à la main reproduisant les API Tauri 2 utilisées (`tools/tauri-stub-check`) — **jamais compilée avec le vrai Tauri** |
| Code du noyau propre à Windows (FFI Win32 : remplacement atomique, mesures du processus) | ⚠️ **partiellement vérifié** : vérification des types sous Linux (`tools/windows-cfg-check`), **sans édition des liens ni exécution** |
| Compilation Windows, installateurs MSI/NSIS | ❌ **non vérifiés** — aucun exécutable n'a pu être produit ici |
| Comportement dans WebView2, mesures sous Windows | ❌ **non vérifiés** — les mesures publiées viennent de Chromium sous Linux |
| Scripts PowerShell (`build-windows.ps1`, `bench-windows.ps1`) | ❌ **jamais exécutés** (pas de PowerShell ici) |

Pour produire l'exécutable : voir [Compilation](#compilation-et-installation-sous-windows).
Si une étape échoue, sa sortie permettra de corriger rapidement : c'est la
première compilation Windows de ce code.

---

## L'écran

```
 Fichier  Édition  Affichage  Aller  Aide                (barre de menus discrète)

                  Il pleuvait depuis l'aube sur les toits de la
                  ville, une pluie fine et obstinée qui effaçait
                  les contours des choses.
                           (colonne centrée, ≈ 74 caractères)
```

- **Pas d'explorateur de fichiers, pas de panneau, pas de barre d'outils.**
  Les fichiers s'ouvrent par Ctrl+O (boîte de dialogue de Windows), par
  glisser-déposer, par « Ouvrir avec », par les fichiers récents (menu
  Fichier ou Ctrl+E).
- **Onglets discrets** : invisibles avec un seul document ; à partir de deux,
  une ligne de noms sans icône, l'onglet actif souligné.
- **Barre d'état masquée** par défaut (Affichage → Barre d'état) ; les messages
  (« Enregistré », erreurs) apparaissent dans une bulle discrète en bas.
- Les fonctions avancées restent là, **sans encombrer l'écran** : aperçu
  Markdown (Ctrl+Maj+V), recherche et remplacement (Ctrl+F / Ctrl+H, barre qui
  disparaît avec Échap), lecteur de gros fichiers, palette de commandes
  (Ctrl+Maj+P).

## Personnalisation (Fichier → Préférences, Ctrl+,)

Tout s'applique immédiatement et se conserve au redémarrage.

| Réglage | Choix | Défaut |
|---|---|---|
| Thème | suivre Windows, clair, sombre, **sépia** (barre de titre comprise) | suivre Windows |
| Police | Constantia, Georgia, Cambria, Palatino, Segoe UI, Calibri, Cascadia Mono, Consolas, ou toute autre police installée | Constantia (serif de lecture) |
| Taille du texte | 6 à 72 px (+ zoom Ctrl+Plus / Ctrl+Moins / Ctrl+0) | 17 px |
| Interligne | 1,00 à 2,50 | 1,65 |
| Largeur du texte | colonne étroite (≈ 58 caractères), moyenne (≈ 74), pleine largeur | moyenne |
| Couleurs libres | fond, texte, curseur (sélecteur de couleur) ; « Revenir aux couleurs du thème » | couleurs du thème |
| Affichage | retour automatique à la ligne, numéros de ligne, espaces et tabulations, espaces en fin de ligne, barre d'état, animations | retour à la ligne seul |

Les valeurs lues dans le fichier de paramètres sont validées par le noyau :
une couleur qui n'est pas de la forme `#rrggbb`, une largeur inconnue ou un
interligne hors bornes sont ignorés ou ramenés dans l'intervalle (testé).

## Fonctionnalités

### Écrire et modifier
- Nouveau, ouvrir, enregistrer, enregistrer sous, tout enregistrer, fermer,
  rouvrir l'onglet fermé, recharger, renommer le fichier, imprimer, afficher
  dans l'Explorateur Windows, copier le chemin.
- Annuler / rétablir **par document** (historique propre, regroupement de la
  frappe), couper, copier, coller, tout sélectionner.
- Dupliquer (Ctrl+D), supprimer (Ctrl+Maj+K), déplacer (Alt+↑/↓), sélectionner
  (Ctrl+L) des lignes ; retrait (Tab / Maj+Tab sur une sélection), indentation
  automatique ; Ctrl+M pour que Tab déplace le focus (accessibilité).
- Date et heure (F5) au format du Bloc-notes.
- Rechercher (Ctrl+F), remplacer (Ctrl+H), suivant / précédent (F3 / Maj+F3) :
  casse, mot entier, expressions régulières validées (groupes `$1`, `$<nom>`),
  « x sur N », toutes les correspondances surlignées, remplacement global en
  une seule étape d'annulation.
- Atteindre la ligne (Ctrl+G), aller au titre (Ctrl+Maj+O).

### Documents, onglets, session
- Ctrl+Tab / Ctrl+Maj+Tab, Ctrl+1…9, réorganisation au glisser ; un onglet
  vierge inutilisé est remplacé ; plusieurs fichiers ouverts d'un coup gardent
  leur ordre.
- Avertissement avant toute perte (fermeture d'onglet, de la fenêtre).
- Fichiers récents ; restauration de la session (désactivable) ; option
  « fermeture rapide » qui conserve les modifications pour le lancement
  suivant ; récupération après arrêt inattendu.
- Fichier modifié, supprimé ou déplacé par un autre programme : signalé, jamais
  écrasé sans choix explicite.

### Encodages et fins de ligne
- UTF-8 (± BOM), UTF-16 LE/BE, Windows-1252 (signalé incertain) ; encodage
  d'origine conservé.
- LF, CRLF, CR conservés ; mélange signalé ; conversion explicite (barre
  d'état) ; CRLF par défaut pour les nouveaux documents (réglable).
- Rien n'est détruit en silence : octets invalides signalés et confirmation
  avant d'enregistrer ; caractère non représentable → enregistrement bloqué
  avec sa position, proposition d'UTF-8.

### Markdown (sur demande)
- Aperçu **désactivé par défaut**, moteur chargé à la première demande ;
  modes source, partagé, aperçu ; table des matières facultative.
- Rendu sécurisé : HTML du document affiché comme texte, aucun script, aucune
  iframe, aucune image distante (jeu de vecteurs XSS testé).

### Autres fichiers
- Images et SVG (sans script) : aperçu. Binaires : fiche d'information et
  confirmation avant tout affichage comme texte. PDF : application par
  défaut de Windows.
- Gros fichiers : ≤ 1 Mo, édition directe ; au-delà, **lecteur rapide**
  (premières lignes en ~33 ms même pour 100 Mo), aller à la ligne,
  recherche ; « Modifier quand même » jusqu'à 16 Mo. Seuils réglables.

### Sécurité des données
- Écriture atomique (fichier temporaire + `ReplaceFileW`) ; écriture sur place
  signalée si le dossier l'interdit.
- Accès refusé, disque plein, lecture seule : message précis, original intact
  (testés en conditions réelles sous Linux).
- **Moindre privilège** : l'interface ne peut ni parcourir un dossier, ni
  copier, déplacer, supprimer ou créer un fichier autrement qu'en
  l'enregistrant ; ces commandes n'existent pas dans le noyau (test
  `file_management_commands_do_not_exist`, et `check:ipc` refuse toute
  commande du noyau inutilisée par l'interface).

---

## Raccourcis clavier

Liste complète dans l'application : **Aide → Raccourcis clavier (F1)**.

| Fichiers | | Édition | |
|---|---|---|---|
| Ctrl+N | nouveau document | Ctrl+Z / Ctrl+Y | annuler / rétablir |
| Ctrl+O | ouvrir | Ctrl+F / Ctrl+H | rechercher / remplacer |
| Ctrl+E | documents ouverts et récents | F3 / Maj+F3 | suivant / précédent |
| Ctrl+S / Ctrl+Maj+S | enregistrer / sous | Ctrl+G | atteindre la ligne |
| Ctrl+W, Ctrl+F4 | fermer l'onglet | Ctrl+D | dupliquer la ligne |
| Ctrl+Maj+T | rouvrir l'onglet fermé | Ctrl+Maj+K | supprimer la ligne |
| Ctrl+P | imprimer | Alt+↑ / Alt+↓ | déplacer la ligne |
| F2 | renommer le fichier | Ctrl+L | sélectionner la ligne |
| Ctrl+, | préférences | F5 | date et heure |
| **Affichage** | | Ctrl+M | Tab déplace le focus |
| Alt+Z | retour à la ligne | **Navigation** | |
| Ctrl+Plus / Moins / 0 | zoom | Ctrl+Tab / Ctrl+Maj+Tab | document suivant / précédent |
| Ctrl+Maj+V | aperçu Markdown | Ctrl+1…9 | onglet n (9 : dernier) |
| F6 / Maj+F6 | zone suivante / précédente | Ctrl+Maj+O | aller au titre |
| F1 | liste des raccourcis | Ctrl+Maj+P | palette de commandes |

Les raccourcis propres au navigateur intégré (F5 recharger, Ctrl+R, Alt+←…)
sont neutralisés.

---

## Technologies et architecture

- **Tauri 2** (fenêtre native, WebView2 fourni par Windows) ; couche native
  mince : `src-tauri/src/main.rs`.
- **Rust** : `crates/swiftpad-core`, **aucune dépendance externe** (fichiers,
  encodages, fins de ligne, écriture atomique, gros fichiers, paramètres,
  session, récupération).
- **TypeScript** sans framework, **esbuild**, **markdown-it** chargé à la demande.
- Éditeur : zone de texte native + historique propre ; colonne centrée par
  les marges intérieures de la zone de texte (la barre de défilement reste au
  bord de la fenêtre).

Détails, mesures et alternatives écartées : [docs/decisions.md](docs/decisions.md).

```
src/                interface (app, workspace, editor, markdown, viewers, ui)
crates/swiftpad-core/   noyau Rust + harnais de test (src/bin/harness.rs, non livré)
src-tauri/          couche native Tauri, configuration, icônes, permissions
tests/unit/         tests unitaires de l'interface (node --test)
tests/e2e/          tests de bout en bout (Playwright + harnais)
bench/              bancs d'essai (run.mjs), résultats (results/), expériences du choix d'éditeur
scripts/            compilation web, vérifications, scripts Windows (PowerShell)
tools/              vérifications partielles de la couche native (stubs Tauri, code Windows)
docs/               décisions techniques, mesures, journal de vérification
```

---

## Prérequis de compilation (Windows 10/11 x64)

- **Node.js 20+** et npm.
- **Rust** stable, chaîne **MSVC** (`rustup default stable-msvc`).
- **Build Tools for Visual Studio** avec « Développement Desktop en C++ ».
- **WebView2 Runtime** (déjà présent sur Windows 11 et Windows 10 à jour).
- Connexion Internet **pour compiler** (crates, paquets npm, outils
  NSIS/WiX téléchargés par Tauri) — l'application, elle, n'en a jamais besoin.

## Compilation et installation sous Windows

Dans une invite de commandes, **dans le dossier qui contient `package.json`** :

```bat
npm install
npx tauri build --no-bundle
```

Résultat : `src-tauri\target\release\swiftpad.exe`. Sans `--no-bundle`, les
installateurs sont aussi produits. Script complet (prérequis, tests,
installateurs) :

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1          # tests + installateurs
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Bench   # + banc d'essai réel
```

- `src-tauri\target\release\bundle\nsis\SwiftPad_0.1.0_x64-setup.exe`
  (installation par utilisateur, sans droits administrateur) ;
- `src-tauri\target\release\bundle\msi\SwiftPad_0.1.0_x64_fr-FR.msi`.

(Noms de fichiers selon les conventions de Tauri 2, à confirmer à la première
compilation.) **Sans PC de compilation** : le workflow
`.github/workflows/ci.yml` compile sur une machine Windows de GitHub et
publie l'exécutable et les installateurs ; il n'a pas pu être exécuté avant
la livraison. Aucune association de fichiers n'est créée : « Ouvrir avec →
SwiftPad » ou glisser-déposer.

## Développement

```bash
npm install
npm run tauri dev          # application avec rechargement de l'interface (Windows)
```

Sans Windows, l'interface et le noyau réels tournent dans un navigateur grâce
au harnais de test :

```bash
npm run build:web && npm run build:harness
crates/swiftpad-core/target/release/swiftpad-harness --dist dist --data /tmp/sp-data
# puis ouvrir l'URL affichée (http://127.0.0.1:PORT/index.html?token=…)
```

Vérifications : `npm run typecheck`, `npm run test:unit`, `npm run test:core`,
`npm run test:e2e`, `npm run check:offline`, `npm run check:ipc`,
`npm run bench`, et tout d'un coup sous Linux : `bash scripts/verify-all.sh`.

---

## Données stockées sur l'ordinateur (et nulle part ailleurs)

| Donnée | Emplacement (Windows) | Désactiver / effacer |
|---|---|---|
| Paramètres (`settings.json`), dont fichiers récents et dernier dossier utilisé | `%APPDATA%\fr.swiftpad.editor\` | Préférences → Session et confidentialité → « Effacer les fichiers récents » |
| Session (`session.json`) : **chemins** des onglets, position du curseur et défilement, sans leur contenu | `%APPDATA%\fr.swiftpad.editor\` | Préférences → décocher « Rouvrir les onglets de la dernière session », ou « Oublier la session » |
| Copies de récupération : texte **non enregistré** | `%LOCALAPPDATA%\fr.swiftpad.editor\recovery\` | Préférences → décocher « Copies de récupération… » (copies supprimées) ; supprimées aussi à l'enregistrement ou à la fermeture |
| Données de WebView2 (cache du moteur web) | `%LOCALAPPDATA%\fr.swiftpad.editor\EBWebView\` (emplacement par défaut de Tauri, à confirmer) | supprimer le dossier, application fermée |

**Aide → Données stockées localement** affiche les chemins exacts. Aucune
donnée n'est transmise : pas de réseau, pas de télémétrie, pas de compte, pas
d'IA (vérifié statiquement par `npm run check:offline` et dynamiquement par un
test qui enregistre toutes les requêtes, préférences comprises).

---

## Résultats des tests

Exécutés le **14 octobre 2026** par `bash scripts/verify-all.sh` (dépôt
nettoyé au préalable), VM Linux x86-64, rustc 1.97.0, Node 22.22.0,
TypeScript 6.0.3, Chromium 141 (Playwright 1.56.1). Journal complet :
[docs/verification/](docs/verification/) (`verify-all.log`, `e2e-results.json`).

| Étape | Résultat |
|---|---|
| Noyau Rust — tests unitaires | **83 / 83** |
| Noyau Rust — tests d'intégration | **6 / 6** (dont 5 qui ne vérifient réellement que dans l'étape suivante) |
| Erreurs système réelles (`scripts/test-core.sh`) | disque plein sur tmpfs de 64 Ko : **1 / 1** ; accès refusés sous l'utilisateur `nobody` : **4 / 4** |
| Couche Tauri contre stubs (`tools/tauri-stub-check`) | OK — vérification **partielle** |
| Code Windows du noyau (`tools/windows-cfg-check`) | OK — vérification **partielle** (sans édition des liens) |
| Interface — vérification des types | OK (0 erreur) |
| Interface — tests unitaires | **16 / 16** |
| Compilation de production de l'interface | OK — 147,1 Ko JS + 20,8 Ko CSS (+ 126 Ko pour le Markdown, à la demande) |
| Vérification hors ligne statique | OK (aucune URL distante, aucun `eval`, CSP stricte, permissions minimales) |
| Contrats (`scripts/check-ipc.mjs`) | OK : 12 commandes natives, 3 événements ; 25 commandes du noyau utilisées, 3 en lecture seule tolérées, aucune autre |
| Tests de bout en bout (Chromium + noyau réel) | **50 / 50** en 42,8 s (dont le contrat avec Tauri simulé) |

Les tests de bout en bout couvrent notamment, pour cette version : l'écran
réduit au texte (ni panneau, ni barre d'outils, ni barre d'état ; éditeur
sur toute la fenêtre sous les menus), les onglets masqués avec un seul
document, la colonne centrée (étroite / moyenne / pleine largeur, fenêtre
étroite sans débordement), l'interligne, les thèmes clair / sombre / sépia,
les couleurs libres (appliquées, conservées au redémarrage, réinitialisées),
le rejet des valeurs invalides du fichier de paramètres, la palette des
documents récents, les noms Unicode — en plus de tout ce qui existait :
encodages, fins de ligne, recherche, annulation, conflits, lecture seule,
accès refusés et disque plein réels, gros fichiers, Markdown sécurisé,
absence de réseau.

**Non testé** : tout ce qui exige Windows (voir le tableau en tête).

## Résultats des mesures

Détail, conditions et méthode : **[docs/benchmarks.md](docs/benchmarks.md)**.
VM Linux à 2 vCPU partagés, Chromium headless (**pas Windows/WebView2**),
cache disque chaud, réglages par défaut, médiane de 7 essais :

| Scénario | Médiane |
|---|---:|
| Lancement du moteur web + harnais → interface prête | 199 ms |
| Ouvrir 1 Ko / 100 Ko / 1 Mo → texte affiché | 17 / 55 / 464 ms |
| Ouvrir 100 Mo (lecteur) → premières lignes | 33 ms |
| Latence de frappe : 1 Ko / 1 Mo (p95) | 9 ms / 28 ms (42 ms) |
| Rechercher 32 000 occurrences dans 2 Mo (Ctrl+F) | 197 ms |
| Rechercher un mot absent dans 100 Mo (lecteur) | 433 ms |
| Ouvrir 100 onglets / changer d'onglet | 400 ms / 18 ms |
| Mémoire au repos : tas JS / noyau / moteur web (6 processus) | 1,4 Mo / 2,7 Mo / 175 Mo |

**À noter** : la police de lecture proportionnelle et le retour à la ligne
actifs par défaut rendent l'ouverture des documents de 0,5 à 2 Mo environ
deux fois plus lente que dans la version précédente (police à chasse fixe,
sans retour à la ligne), mesuré côte à côte sur la même machine. Le temps
est passé dans la mise en page du texte par le moteur web, pas dans le code
de SwiftPad. Jusqu'à 100 Ko (cas courant d'un texte que l'on écrit), l'écart
est de l'ordre de 20 ms. La frappe n'est pas ralentie.

---

## Limites connues

- **Non compilé ni testé sous Windows** (voir l'état de la livraison).
  Aucun `Cargo.lock` ni `package-lock.json` : créés à la première compilation.
- Édition directe fluide jusqu'à ~1 Mo ; au-delà, lecture rapide et édition sur
  demande jusqu'à 16 Mo.
- Pas de coloration syntaxique ; pas d'aperçu PDF intégré ; pas de gestion de
  fichiers (volontaire : on passe par l'Explorateur Windows).
- Encodages : UTF-8 (± BOM), UTF-16 LE/BE, Windows-1252 ; les autres pages de
  code s'ouvrent en Windows-1252 « incertain ».
- Mémoire : ~175–240 Mo pour le moteur web mesurés sous Linux (Chromium) ; la
  valeur réelle avec WebView2 reste à mesurer.

## Critères d'acceptation

| Critère | État |
|---|---|
| Se compile en mode production sur l'environnement cible (Windows) | ❌ **non vérifié** ici ; noyau et interface compilés en production sous Linux ; couche Tauri vérifiée seulement contre des stubs |
| Fonctionne sans connexion Internet | ✅ vérifié (harnais) : test « aucune requête réseau » + `check:offline` |
| Aucun compte, aucun appel à une IA ou à une API distante | ✅ vérifié (statique + dynamique) |
| Un TXT peut être ouvert, modifié, enregistré | ✅ vérifié (E2E, CRLF conservé) |
| Un Markdown peut être édité | ✅ vérifié (E2E, aperçu inclus) |
| Plusieurs onglets | ✅ vérifié (E2E, 120 onglets) |
| Modifications non enregistrées signalées | ✅ vérifié (onglet, titre, fermeture) |
| Annuler / rétablir, recherche et remplacement | ✅ vérifiés |
| Écran sobre, sans explorateur, personnalisable | ✅ vérifié (E2E : écran, colonne, interligne, thèmes, couleurs) |
| Paramètres conservés après redémarrage | ✅ vérifié (E2E avec redémarrage du noyau) |
| Erreurs d'encodage non ignorées | ✅ vérifié |
| Fichiers volumineux sans blocage injustifié | ✅ vérifié : 23 Mo (test) et 100 Mo (mesure) en lecteur rapide |
| Pas de perte silencieuse de données | ✅ vérifié pour les cas testés |
| Benchmarks accompagnés des conditions de mesure | ✅ `docs/benchmarks.md` |

---

## Dépendances et licences

| Dépendance | Version | Licence | Livrée ? |
|---|---|---|---|
| tauri, tauri-plugin-dialog, tauri-plugin-opener, tauri-plugin-single-instance | 2.x | MIT OR Apache-2.0 | oui (exécutable) |
| serde | 1.x | MIT OR Apache-2.0 | oui (exécutable) |
| markdown-it (+ entities BSD-2-Clause, linkify-it, mdurl, punycode.js, uc.micro : MIT) | 14.2.0 | MIT | oui (module Markdown) |
| WebView2 Runtime | système | Microsoft | non (fourni par Windows) |
| esbuild · TypeScript · Playwright · @tauri-apps/cli | 0.28.2 · 6.0.3 · 1.56.1 · 2.x | MIT · Apache-2.0 · Apache-2.0 · MIT OR Apache-2.0 | non (outils) |

Textes complets : [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
SwiftPad est distribué sous licence MIT ([LICENSE](LICENSE)).

<!-- installeur-release -->
## Installation

Téléchargez **`SwiftPad_0.1.0_x64-setup.exe`** depuis la [dernière release](https://github.com/Les-Doubles-A/swiftpad/releases/latest), puis lancez-le.

L'installation se fait pour l'utilisateur courant, sans droits administrateur (par défaut dans `%LOCALAPPDATA%\Programs\swiftpad`), avec un raccourci dans le menu Démarrer et une désinstallation depuis les Paramètres Windows.

L'installeur n'est pas signé : si Windows SmartScreen l'affiche, cliquez sur « Informations complémentaires » puis « Exécuter quand même ».

### Recréer l'installeur

`npm run tauri build` produit l'installeur NSIS dans `src-tauri\target\release\bundle\nsis\`.
