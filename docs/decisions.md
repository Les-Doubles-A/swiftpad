# Architecture et décisions techniques

Ce document explique les choix faits pour SwiftPad, avec les mesures qui les
fondent et les alternatives écartées. Les mesures sont celles de
`docs/benchmarks.md` et des expériences de `bench/experiments/` (même machine :
VM Linux 2 vCPU, Chromium 141 headless).

## Un écran pour écrire (refonte du 14 octobre 2026)

Demande : « pas d'explorateur de fichiers, le plus sobre possible, un écran
pour écrire, quelques réglages ». Choix retenus avec l'utilisateur : onglets
discrets et barre de menus visibles ; thèmes, police / taille / interligne,
largeur de colonne et couleurs libres réglables ; fonctions avancées
conservées mais invisibles tant qu'on ne les appelle pas.

* **Supprimés** : panneau de fichiers (arborescence, opérations sur les
  fichiers, Corbeille), panneau de recherche dans les fichiers, barre
  d'outils, panneau latéral. Ouvrir passe par la boîte de dialogue de
  Windows, le glisser-déposer, « Ouvrir avec » et les fichiers récents.
* **Masqués par défaut** : barre d'état (ses messages restent visibles dans
  une bulle), onglets avec un seul document, numéros de ligne.
* **Colonne centrée** : la zone de texte occupe toute la fenêtre (la barre de
  défilement reste au bord, la molette fonctionne partout) ; seules ses marges
  intérieures changent, calculées à partir de la largeur moyenne d'un
  caractère de la police choisie (58 ou 74 caractères, ou pleine largeur ;
  marge minimale de 24 px). Calque, gouttière et miroir de mesure utilisent
  les mêmes marges.
* **Typographie par défaut** : Constantia 17 px, interligne 1,65, retour à la
  ligne. Coût mesuré : ouverture des documents de 0,5 à 2 Mo environ deux
  fois plus lente qu'avec une police à chasse fixe sans retour à la ligne
  (mise en page par le moteur web ; voir benchmarks.md) ; frappe inchangée.
  Choix assumé pour la lecture ; une police à chasse fixe reste proposée.
* **Thème sépia** : jeu complet de couleurs ; la barre de titre de Windows
  passe en clair (`set_theme("sepia")` → `Theme::Light`).
* **Couleurs libres** : appliquées par trois propriétés CSS (`--paper`,
  `--ink`, `--caret`) sur la racine de l'application ; seules des valeurs
  `#rrggbb` passent la validation du noyau (règle `OptColor`), ce qui exclut
  toute injection CSS par le fichier de paramètres.
* **Surface réduite** : sans explorateur, le noyau n'avait plus à exposer le
  listage de dossiers, la création, la copie, le déplacement, la duplication,
  la suppression (Corbeille), la recherche dans un dossier ni la liste des
  lecteurs. Ces commandes ont été **retirées du noyau** (et leur code, dont
  la FFI Windows correspondante : `SHFileOperationW`, `GetLogicalDrives`,
  `GetDriveTypeW`, `GetVolumeInformationW`), ainsi que les commandes natives
  `dialog_pick_folder` et `open_folder`. Moins de code jamais compilé sous
  Windows, et une page compromise ne pourrait plus supprimer ni déplacer de
  fichiers. `scripts/check-ipc.mjs` échoue désormais si une commande du noyau
  n'est pas utilisée par l'interface (trois commandes en lecture seule
  tolérées et justifiées).

## Vue d'ensemble

```
┌──────────────────────── fenêtre Windows (Tauri 2 + WebView2) ────────────────────────┐
│  Interface (TypeScript, sans framework, 147 Ko JS + 21 Ko CSS minifiés)             │
│   app.ts (menus, commandes, raccourcis) · workspace/ (onglets, documents, sessions)  │
│   editor/ (zone de texte native + historique propre, colonne centrée)                │
│   markdown/ (chargé à la demande, 126 Ko) · viewers/ (gros fichiers, images)         │
│                      │ une seule commande IPC « rpc » (requête binaire)              │
├──────────────────────┼───────────────────────────────────────────────────────────────┤
│  src-tauri/main.rs   │ couche native mince : boîtes de dialogue, « Afficher dans     │
│  (≈ 390 lignes)      │ l'Explorateur », fenêtre (géométrie, thème, fermeture         │
│                      │ protégée), instance unique,                                   │
│                      │ glisser-déposer de fichiers Windows                           │
├──────────────────────┴───────────────────────────────────────────────────────────────┤
│  swiftpad-core (Rust, AUCUNE dépendance) : fichiers texte, encodages, fins de ligne, │
│  écriture atomique, conflits, renommage, gros fichiers (index clairsemé, recherche   │
│  annulable), paramètres validés, session, récupération                               │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Séparation des responsabilités demandée → modules :

| Responsabilité | Interface | Noyau Rust |
|---|---|---|
| Ouverture, renommage | `app.ts` (boîte Ouvrir), `workspace.ts` | `paths.rs`, `fsops.rs` (renommage seul), `names.rs` |
| Moteur d'édition, colonne | `editor/textview.ts`, `history.ts`, `ops.ts`, `text.ts` | — |
| Onglets et sessions | `workspace/tabs.ts`, `workspace.ts` | `store.rs` (session) |
| Préférences, thèmes, couleurs | `core/settings.ts`, `ui/prefs.ts`, `styles/app.css` | `settings.rs` (validation, versions) |
| Recherche | `editor/find.ts`, `findbar.ts`, `viewers/bigview.ts` | `search.rs` (motif littéral), `bigfile.rs`, `jobs.rs` |
| Aperçu Markdown | `markdown/` | `file.readBinary` (images locales) |
| Enregistrement et récupération | `workspace.ts` | `textfile.rs`, `encoding.rs`, `eol.rs`, `store.rs` |
| Commandes et raccourcis | `ui/commands.ts`, `menu.ts`, `palette.ts` | — |

### Pourquoi un protocole binaire unique (`rpc`)

L'interface et le noyau échangent des requêtes `{cmd, args}` + charge utile
brute (le texte d'un document n'est jamais encodé en JSON ni en base64). Une
seule commande Tauri est exposée pour le noyau, plus onze commandes natives
fines (dialogues, « Afficher dans l'Explorateur », fenêtre). Le **même protocole** est servi par
le harnais de test (`crates/swiftpad-core/src/bin/harness.rs`, HTTP sur
127.0.0.1 avec jeton aléatoire, même CSP) : les tests de bout en bout et les
bancs d'essai exercent le vrai noyau et la vraie interface, sans Windows.
Le harnais n'est **pas** livré dans l'application (pas de serveur local).

Comme la couche Tauri n'a pas pu être compilée ici, son contrat avec
l'interface est vérifié de deux façons : `scripts/check-ipc.mjs` compare chaque
`invoke('commande', {…})` de l'interface aux signatures Rust enregistrées
(noms, paramètres après conversion camelCase → snake_case, paramètres
obligatoires, commandes inutilisées, événements émis et écoutés), ainsi que
chaque commande du noyau demandée par l'interface ; un test de
bout en bout simule `window.__TAURI__` pour faire passer l'interface par ses
chemins « Tauri » (transport binaire, dialogues, titre, thème, fichiers
transmis par Windows, fermeture protégée).

## Dépendances (chacune justifiée)

| Dépendance | Où | Pourquoi | Alternative écartée |
|---|---|---|---|
| Tauri 2 | natif | fenêtre + WebView2 déjà présent dans Windows, installateurs MSI/NSIS | Electron (chaque application embarque son propre Chromium) |
| tauri-plugin-dialog | natif | boîtes Ouvrir/Enregistrer sous natives de Windows | boîtes HTML (moins familières, pas d'accès aux emplacements Windows) |
| tauri-plugin-opener | natif | « Afficher dans l'Explorateur », ouverture d'un lien http(s) confirmé | `std::process::Command("explorer")` : plus de cas particuliers à gérer |
| tauri-plugin-single-instance | natif | « Ouvrir avec SwiftPad » depuis l'Explorateur : un onglet dans la fenêtre existante | une fenêtre par fichier |
| serde | natif | arguments des commandes ; déjà requis par Tauri (aucun poids ajouté) | — |
| markdown-it 14 | interface (chargé à la demande) | analyseur CommonMark éprouvé, HTML brut désactivable (`html: false`) | écrire un analyseur (risque de failles) ; marked + DOMPurify (deux dépendances) |
| esbuild | outil | compilation, découpage du code (Markdown à part), minification, serveur de dev | Vite (voir plus bas) |
| TypeScript, Playwright | outils | vérification des types ; tests de bout en bout et mesures | — |

Le noyau Rust n'a **aucune** dépendance : JSON (≈ 750 lignes, tests compris), détection
d'encodage, recherche d'octets (SWAR), FFI Win32 (quatre fonctions
documentées déclarées à la main au lieu de la caisse `windows-sys`). Il compile et se teste
hors ligne, et sa surface d'audit est entièrement dans ce dépôt.

### Vite → esbuild

Le cahier des charges proposait Vite. Vite n'était pas installable dans
l'environnement de développement (pas d'accès au registre npm) ; esbuild, déjà
présent, couvre tous les besoins d'une interface sans framework : un seul
`index.html`, un point d'entrée TypeScript, un découpage pour le module
Markdown chargé à la demande, et un serveur de développement local
(`npm run dev:web`). Vite utilise lui-même esbuild en développement ; passer à
Vite plus tard ne demanderait que sa configuration (la structure
`index.html` + `src/main.ts` est celle de Vite).

## Éditeur : zone de texte native plutôt que CodeMirror 6

Besoins : édition de texte brut type Bloc-notes, fichiers de toutes tailles,
recherche/remplacement avec expressions régulières, numéros de ligne,
caractères invisibles, retour à la ligne, accessibilité (lecteurs d'écran),
saisie IME, correcteur désactivé, aucune coloration syntaxique exigée.

Mesures de la zone de texte native (`bench/experiments/1-textarea-tailles.mjs`,
`2-textarea-vs-contenteditable.mjs` ; temps d'insertion synchrone, mise en
page forcée comprise) :

| Taille | 1re image (sans retour à la ligne) | Insertion d'un caractère |
|---|---:|---:|
| 1 Mo | 221 ms | ≈ 6,5 ms |
| 2 Mo | 431 ms | ≈ 10 ms |
| 5 Mo | 1 014 ms | ≈ 18 ms |
| 10 Mo | 2 100 ms | ≈ 90 ms |
| 50 Mo | 10 057 ms | ≈ 450 ms |

Mesurée dans l'application complète (événement → image affichée,
`docs/benchmarks.md`), la latence de frappe est plus élevée : 33 ms à 1 Mo,
77 ms à 2 Mo (p95 191 ms). D'où le **seuil d'édition directe de 1 Mo**, le
**lecteur de gros fichiers** au-delà et l'édition « Modifier quand même »
jusqu'à 16 Mo.

Écartés :

* **contenteditable par blocs** (`3-contenteditable-anomalies.mjs`) : très
  rapide (≈ 20 ms la 1re image, ≈ 2 ms par frappe) mais pertes de données
  observées (Suppr en fin de bloc a supprimé « l4\n »), curseur incorrect
  après un saut de ligne final, insertion multiligne créant des `<div>`.
  Inacceptable pour un éditeur dont la priorité est de ne rien perdre.
* **CodeMirror 6** : il virtualise l'affichage et resterait fluide sur de plus
  gros fichiers. Il **n'a pas pu être mesuré** ici : ses paquets n'étaient pas
  disponibles hors ligne, et aucun chiffre n'est donc avancé sur sa taille ou
  sa vitesse. Pour les besoins du cahier des charges (texte brut, sans
  coloration), la zone native suffit jusqu'à 1 Mo, offre gratuitement
  l'accessibilité, l'IME, le glisser-déposer de texte, le menu contextuel et
  le comportement Windows attendu ; le lecteur dédié couvre les gros fichiers.
  Critère pour revenir sur ce choix : besoin de coloration syntaxique, ou
  d'édition fluide au-delà de quelques Mo — CodeMirror serait alors chargé à
  la demande pour ces seuls documents, après mesure.

### Découverte : l'historique d'annulation de Chromium est global

`bench/experiments/4-annulation-native.mjs` : avec deux zones de texte A et B,
Ctrl+Z dans B annule d'abord B puis **déplace le focus dans A et annule A**.
Une zone de texte unique réutilisée par tous les onglets aurait mélangé les
historiques. SwiftPad a donc son propre historique par document
(`editor/history.ts`) : l'annulation native est bloquée (`beforeinput`
`historyUndo`/`historyRedo`, annulable pour le clavier), chaque saisie est
déduite des sélections avant/après (vérification complète jusqu'à 256 Ko, diff
de secours sinon), les éditions programmées passent par `setRangeText`.
Regroupement des frappes (1 s, 64 caractères), plafond de 2 000 étapes et
48 millions de caractères conservés par document.

### Autres choix de l'éditeur

* Une seule zone de texte pour tous les onglets ; chaque document garde son
  texte, sa sélection, son défilement et son historique (100 onglets : 400 ms,
  changement d'onglet 18 ms).
* Gouttière de numéros et calque (invisibles, espaces de fin, correspondances)
  limités aux lignes visibles. En retour à la ligne, la hauteur de chaque ligne
  est mesurée par un miroir hors écran jusqu'à 20 000 lignes ; au-delà, pas de
  numéros (comme le Bloc-notes).
* Fins de ligne : la zone de texte normalise tout en LF ; le noyau mémorise le
  style d'origine (LF, CRLF, CR, ou mixte signalé) et le réapplique à
  l'enregistrement, ou celui choisi dans la barre d'état (Affichage → Barre
  d'état).
* Frappe pendant un chargement : mise de côté puis rejouée (voir
  benchmarks.md, défauts trouvés par la mesure).

## Gros fichiers

| Taille | Comportement par défaut |
|---|---|
| ≤ 1 Mo | édition directe |
| 1 – 16 Mo | lecteur rapide (lecture seule) + « Modifier quand même » (avertissement, mode allégé) |
| > 16 Mo | lecteur rapide uniquement (seuil réglable jusqu'à 512 Mo) |

Le lecteur ne charge jamais tout le fichier : un fil du noyau construit un
index clairsemé (une position toutes les 256 lignes ; 100 Mo / 1,96 million de
lignes indexés en 90 ms), l'interface demande des pages de 200 lignes, la
recherche s'exécute dans le noyau et peut être annulée. Mémoire du noyau avec
un fichier de 100 Mo ouvert : 7,4 Mo. Aller à la ligne et rechercher
fonctionnent ; l'édition de fichiers de plusieurs Go n'est pas proposée. Un
gros fichier binaire n'est jamais affiché sans confirmation (même détection
que pour un petit fichier, sur un échantillon de 1 Mo).

## Encodages

Détection, dans l'ordre : BOM (UTF-8, UTF-16 LE/BE) → UTF-8 valide → UTF-16
sans BOM si le motif des octets nuls est net (**signalé incertain**) →
Windows-1252 (**signalé incertain**). Un fichier ASCII se terminant par un
octet accentué n'est pas pris pour de l'UTF-8 tronqué (test de non-régression
`ansi_ending_with_accent_is_not_truncated_utf8`). Les octets invalides
remplacés par « � » sont comptés et signalés ; l'enregistrement demande
confirmation. Un texte non représentable dans l'encodage choisi (ex. emoji en
Windows-1252) bloque l'enregistrement : le message donne le caractère, sa
ligne et sa colonne, et propose d'enregistrer en UTF-8 ; rien n'est remplacé.
Encodage et fins de ligne se choisissent dans la barre d'état ; « Rouvrir avec
l'encodage… » relit le fichier.

## Enregistrement et protection des données

* Écriture atomique : fichier temporaire dans le même dossier, `fsync`, puis
  `ReplaceFileW` sous Windows (conserve attributs, date de création, ACL ;
  copie de secours restaurée en cas d'échec) ou `rename` ailleurs. Si le
  dossier n'est pas modifiable, écriture sur place, signalée.
* Conflits : empreinte (taille et date de modification à la nanoseconde)
  vérifiée avant d'écrire ; modification externe → choix explicite
  (Enregistrer sous…, Écraser, Recharger en perdant mes modifications,
  Annuler) ; jamais d'écrasement silencieux. Fichier supprimé ou déplacé →
  signalé dans l'onglet, puis à l'enregistrement « Recréer le fichier » ou
  « Enregistrer sous… ».
* Lecture seule, accès refusé, disque plein, fichier verrouillé, chemin trop
  long : message précis, original intact (tests réels : utilisateur sans
  privilèges, tmpfs de 64 Ko plein).
* Liens symboliques : un document ouvert via un lien affiche sa cible, et
  l'enregistrement remplace la cible en gardant le lien.
* SwiftPad ne supprime, ne copie et ne déplace aucun fichier (voir « Surface
  réduite » plus haut) ; le renommage refuse un nom déjà pris.
* Récupération (désactivable) : copie locale du texte non enregistré 2 s après
  la dernière frappe, effacée dès l'enregistrement ou la fermeture ;
  notification unique la première fois. Désactiver l'option supprime les
  copies existantes.

## Sécurité

* CSP stricte, identique dans Tauri et le harnais : `default-src 'self'`,
  pas d'`unsafe-inline` ni d'`unsafe-eval`, `connect-src` limité à l'IPC
  locale, `object-src` et `frame-src` à `none`. Protocole `asset:` désactivé.
* Aucun `eval`, aucune `new Function` (vérifié par `npm run check:offline`).
* Permissions de la page : écoute d'événements uniquement. Liste fermée de
  commandes du noyau, réduite à ce que l'interface utilise. Les greffons
  (dialogues, ouverture) ne sont appelés que depuis Rust, après validation :
  chemins absolus existants, schémas `http`, `https`, `mailto` seulement pour
  les liens, application par défaut limitée à une liste de types inertes
  (PDF, images, documents bureautiques, médias, archives — jamais
  d'exécutable, de script ni de raccourci).
* Markdown : `html: false` (le HTML du document est affiché comme texte),
  liens neutralisés (aucun lien actif dans le DOM ; clic → ouverture locale
  dans SwiftPad ou confirmation pour http(s)), images distantes jamais
  chargées, images locales lues par le noyau puis affichées en `blob:`,
  identifiants de titres préfixés (`md-h-`) contre le DOM clobbering, aucun
  style en ligne. Un jeu de vecteurs XSS est testé.
* SVG affiché comme image (`<img>`) : ses scripts ne s'exécutent pas.
* Noms de fichiers validés (caractères interdits, noms réservés `CON`, `NUL`…,
  espaces et points finaux), chemins de périphériques refusés.

## Prévisualisations

Images courantes et SVG : oui (lecture par le noyau, 50 Mo max).
**PDF : non intégré** : pdf.js (pdfjs-dist 6.2.108, présent localement) pèse
445 Ko (`pdf.min.mjs`) + 1 233 Ko (`pdf.worker.min.mjs`) minifiés, soit environ
plus de cinq fois toute l'interface de SwiftPad (296 Ko) ; l'afficheur PDF intégré de
WebView2 demanderait d'assouplir la CSP (`frame-src`/`object-src`) et
d'ouvrir un accès aux fichiers depuis la page. Un PDF s'ouvre dans l'application par défaut de Windows (bouton dans la
vue d'information).

## Fenêtre et démarrage

* Fenêtre créée masquée et affichée à la première image dessinée : pas d'écran
  blanc ni de fenêtre de chargement (sécurité : affichage forcé après 4 s).
* Données de démarrage (paramètres, session, fichiers à ouvrir) injectées avant
  le premier script : aucun aller-retour avant le premier rendu.
* Fermeture : la demande de Windows est interceptée, l'interface traite les
  documents modifiés, puis confirme ; si l'interface ne répond plus, une
  seconde demande après 3 s ferme quand même.
* Session restaurée paresseusement : seuls les onglets affichés sont lus.
* Thème : fixé à la création de la fenêtre, puis appliqué à la barre de titre
  à chaque changement (`set_theme`, qui renvoie le thème effectif) ; en mode
  « système », un changement de thème de Windows est transmis à l'interface
  (`swiftpad://theme-changed`). L'interface applique le thème explicitement,
  sans dépendre de la propagation à `prefers-color-scheme` dans WebView2.

## Limites connues et choix assumés

* Aucune association de fichiers n'est créée par l'installateur (pour ne pas
  modifier les choix de l'utilisateur) : « Ouvrir avec → SwiftPad » ou
  glisser-déposer.
* Pas de coloration syntaxique (hors cahier des charges ; voir CodeMirror).
* Impression : `window.print()` de WebView2 (boîte d'impression de Windows),
  texte du document seul, sans en-têtes personnalisés.
