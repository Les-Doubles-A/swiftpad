# Mesures de performance

Tous les chiffres de ce document ont été **mesurés** par les scripts du dépôt,
le 14 octobre 2026, dans l'environnement décrit ci-dessous. Aucun n'est estimé.
Les fichiers bruts sont dans `bench/results/` (`core-linux-x64.json`,
`ui-linux-x64.json`, et `ui-linux-x64-avant-refonte.json` pour la comparaison
avec la version précédente).

## Conditions de mesure — à lire avant les chiffres

| | |
|---|---|
| Machine | machine virtuelle Linux, Intel Xeon 2,10 GHz, **2 processeurs logiques partagés**, 7,8 Go |
| Système | Linux 6.18 (conteneur de développement) |
| Moteur web | Chromium 141.0.7390.37 *headless* (Playwright 1.56.1), rendu logiciel |
| Polices | celles de Windows (Constantia…) sont absentes : le texte est rendu en DejaVu Serif (police de repli « serif ») |
| Noyau Rust | profil `release`, rustc 1.97 |
| Disque | cache **chaud** : les fichiers venaient d'être écrits |
| Réglages | ceux par défaut (police de lecture 17 px, interligne 1,65, colonne moyenne, retour à la ligne), sauf mention contraire |
| Répétitions | 7 essais par mesure (médiane, min, max) ; latences : p95 sur ≥ 40 échantillons |

**Ce ne sont pas des mesures de l'application Windows.** L'environnement de
développement n'avait ni Windows, ni WebView2, ni accès à crates.io : la couche
Tauri n'a pas pu y être compilée (voir le README). Les mesures portent sur :

1. le **noyau Rust réel** (`swiftpad-core`), appelé par son interface RPC
   complète, sans le transport IPC de Tauri ;
2. l'**interface réelle** compilée (`dist/`), servie par le harnais de test
   (même noyau, même protocole binaire, même CSP) et affichée par Chromium,
   dont WebView2 est une variante (moteur Blink/V8 d'Edge).

Différences attendues sous Windows : IPC Tauri au lieu de HTTP local, NTFS et
antivirus (ouvertures plus lentes à froid), accélération graphique, polices
réelles, CPU de bureau généralement plus rapide qu'une VM à 2 vCPU partagés.
Pour mesurer l'exécutable réel : `scripts\bench-windows.ps1` (fin du
document). La VM est bruitée : un essai isolé d'ouverture de 1 Mo a pris
3,2 s au lieu d'environ 0,5 s lors d'un passage préparatoire, et la médiane
d'ouverture de 2 Mo a varié de 0,93 à 1,14 s d'un passage à l'autre ; d'où
les médianes et les écarts min – max.

Reproduire : `node bench/run.mjs` (tout), `node bench/run.mjs --quick`,
`node bench/run.mjs --only open,typing --no-core`.

## Démarrage

| Scénario | Médiane | Min – max |
|---|---:|---:|
| Lancement de Chromium + harnais → interface prête (profil vide) | **199 ms** | 176 – 209 |
| Idem, avec un fichier de 1 Mo passé en argument → texte affiché | 746 ms | 672 – 811 |
| Navigation → interface prête (moteur web déjà lancé) | 84 ms | 71 – 103 |
| Navigation → premier rendu (First Contentful Paint, 3 mesures) | 88 ms | 80 – 96 |

« Interface prête » = interface construite, session restaurée, fichiers
d'arguments ouverts (`performance.mark('swiftpad-ready')`). Le démarrage à
froid de Windows n'est **pas** couvert : voir `bench-windows.ps1`.

## Ouverture de fichiers (interface)

Du clic (appel `openPath`) à l'image suivante affichée, cache chaud. Le seuil
d'édition directe a été relevé à 4 Mo pendant ces mesures pour mesurer la
courbe complète (réglage par défaut : 1 Mo).

| Fichier | Mode | Médiane | Min – max |
|---|---|---:|---:|
| 1 Ko | édition | **17 ms** | 17 – 17 |
| 100 Ko | édition | 55 ms | 49 – 57 |
| 512 Ko | édition | 262 ms | 243 – 326 |
| 1 Mo | édition | 464 ms | 439 – 530 |
| 2 Mo | édition (seuil relevé) | 1 138 ms | 1 074 – 1 223 |
| 512 Ko / 1 Mo / 2 Mo | édition, **sans retour à la ligne** | 263 / 509 / 835 ms | 220 – 349 / 379 – 599 / 794 – 920 |
| 10 Mo | lecteur de gros fichiers | **35 ms** (premières lignes) | 35 – 66 |
| 100 Mo | lecteur de gros fichiers | **33 ms** (premières lignes) | 32 – 34 |

### Comparaison avec la version précédente (même machine, le même jour)

La version précédente (avec explorateur) a été recompilée et mesurée juste
avant cette version (deux passages consécutifs, mêmes scénarios ; les
chiffres « cette version » de ce tableau viennent de ce passage, pas de
l'exécution complète ci-dessus), avec ses propres réglages par défaut (Cascadia Mono 14 px,
sans retour à la ligne ; polices de repli DejaVu ici) :

| Scénario | Version précédente | Cette version | Écart |
|---|---:|---:|---:|
| Ouvrir 1 Ko | 18 ms | 17 ms | — |
| Ouvrir 100 Ko | 33 ms | 52 ms | +19 ms |
| Ouvrir 512 Ko | 136 ms | 278 ms | × 2,0 |
| Ouvrir 1 Mo | 271 ms | 537 ms | × 2,0 |
| Ouvrir 2 Mo | 499 ms | 927 ms | × 1,9 |
| Frappe, 1 Mo (médiane / p95) | 30 / 41 ms | 29 / 40 ms | — |
| Frappe, 2 Mo (médiane / p95) | 64 / 110 ms | 49 / 85 ms | — |
| Ctrl+F, 32 000 occurrences dans 2 Mo | 178 ms | 191 ms | + 7 % |

Cause, établie par profilage (trace Blink d'une ouverture de 1 Mo : 546 ms,
dont 414 ms de mise en page forcée, elle-même dominée par la mise en forme
du texte, 215 ms) : la police proportionnelle de lecture, plus coûteuse à
mettre en forme qu'une police à chasse fixe, et le retour à la ligne dans
une colonne de 74 caractères, qui multiplie les lignes à placer. Mesures
complémentaires (5 essais, texte de 1 Mo à lignes de ~85 caractères,
médianes) : réglages par défaut 426 ms ; sans retour à la ligne 309 ms ;
chasse fixe 14 px sans retour à la ligne 252 ms ; même chose en pleine
largeur 214 ms. Le code de SwiftPad ne pèse presque rien (JavaScript hors
mise en page : quelques millisecondes). C'est un choix assumé pour un écran
d'écriture : jusqu'à 100 Ko, l'écart reste de l'ordre de 20 ms, et la frappe
n'est pas ralentie. Pour ouvrir de gros textes plus vite : police à chasse
fixe, pleine largeur ou retour à la ligne désactivé (Alt+Z).

## Latence de frappe

De l'événement `keydown` à l'image suivante (requestAnimationFrame puis
tâche), 60 caractères tapés avec 40 ms d'intervalle.

| Taille du document | Médiane | p95 | Max |
|---|---:|---:|---:|
| 1 Ko | **9 ms** | 17 ms | 17 ms |
| 512 Ko | 16 ms | 24 ms | 26 ms |
| 1 Mo | 28 ms | 42 ms | 45 ms |
| 2 Mo | 58 ms | 117 ms | 285 ms |

Le temps est dominé par l'édition native de la zone de texte et la mise en
page (trace Blink de la version précédente : ~20 ms d'insertion et ~15 ms de
mise en page par frappe à 1 Mo, moins de 2 ms pour SwiftPad). **Seuil
d'édition directe : 1 Mo** (réglable de 1 à 64 Mo) ; au-delà, lecture rapide
et « Modifier quand même » jusqu'à 16 Mo.

## Recherche et onglets (interface)

| Scénario | Médiane | Min – max |
|---|---:|---:|
| Ctrl+F dans 2 Mo : saisie de « cible » → 32 000 occurrences comptées (dont 150 ms d'anti-rebond volontaire au-delà de 1 Mo) | 197 ms | 194 – 217 |
| Lecteur de gros fichier, 100 Mo : rechercher un mot absent (parcours complet) → « 0 résultat » affiché | 433 ms | 416 – 550 |
| Ouvrir 100 fichiers de 10 Ko → 100 onglets affichés (5 essais) | 400 ms | 342 – 527 |
| Changer d'onglet (Ctrl+Tab) → image suivante (40 essais, p95 26 ms) | 18 ms | 11 – 27 |

## Mémoire

Chaque scénario dans un navigateur neuf, après ramasse-miettes forcé et 1 s
de repos. « Chromium » = somme de la PSS des 6 processus de Chromium.
« Noyau » = RSS du processus Rust (harnais).

| Scénario | Tas JS | Nœuds DOM | Chromium (PSS) | Noyau (RSS) |
|---|---:|---:|---:|---:|
| Au repos, document vide | 1,4 Mo | 191 | 175 Mo | 2,7 Mo |
| 10 documents de 100 Ko ouverts | 1,5 Mo | 4 141 | 198 Mo | 3,0 Mo |
| 1 document de 1 Mo en édition | 1,5 Mo | 39 520 | 243 Mo | 2,8 Mo |
| 100 onglets de 10 Ko | 1,7 Mo | 1 267 | 199 Mo | 3,0 Mo |
| Lecteur de gros fichier, 100 Mo | 2,1 Mo | 398 | 182 Mo | 7,4 Mo |

L'application elle-même est légère (tas JavaScript ≈ 2 Mo, noyau < 8 Mo même
avec un fichier de 100 Mo), mais **le moteur web représente l'essentiel de la
mémoire** (≈ 175–240 Mo ici). Sans explorateur ni panneaux, l'interface au
repos compte 191 nœuds DOM (410 dans la version précédente). Les nœuds du
cas « 1 Mo » sont internes à Blink (une zone de texte stocke chaque ligne
comme un nœud texte suivi d'un `<br>`).

## Noyau Rust (sans IPC)

`cargo run --release --example bench`, chemin RPC complet (encodage de la
requête, traitement, décodage de la réponse), 7 essais (5 pour le lecteur),
cache chaud.

| Opération | Taille | Médiane | Min – max |
|---|---|---:|---:|
| `doc.open` UTF-8 | 1 Ko | 0,01 ms | 0,01 – 0,02 |
| `doc.open` UTF-8 | 100 Ko | 0,38 ms | 0,37 – 0,59 |
| `doc.open` UTF-8 | 1 Mo | 4,1 ms | 3,9 – 4,2 |
| `doc.open` UTF-8 | 2 Mo | 8,2 ms | 8,0 – 8,6 |
| `doc.open` UTF-8 | 10 Mo | 43,7 ms | 40,6 – 52,6 |
| `doc.open` UTF-8, fins de ligne CRLF | 1 Mo | 3,5 ms | 3,1 – 3,7 |
| `doc.open` UTF-16 LE avec BOM | 2 Mo sur disque | 3,3 ms | 3,1 – 3,9 |
| `doc.open` Windows-1252 (détecté) | ≈ 1 Mo | 3,2 ms | 2,9 – 4,1 |
| `doc.save` atomique (fichier temporaire, fsync, remplacement), CRLF | 1 Mo | 5,5 ms | 5,0 – 13,3 |
| Lecteur de gros fichier : 200 premières lignes | 100 Mo | 2,3 ms | 2,0 – 3,6 |
| Lecteur de gros fichier : index complet des lignes | 100 Mo, 1 963 101 lignes | 90 ms | 83 – 104 |
| Lecteur de gros fichier : recherche d'un texte simple (20 300 correspondances) | 100 Mo | 513 ms | 481 – 701 |

Les mesures de listage de dossier et de recherche dans un dossier de la
version précédente ont disparu avec ces fonctions.

## Optimisations issues des mesures (avant / après)

Historique : mesures faites pendant le développement de la version
précédente (13 octobre 2026) ; les corrections sont toujours en place.

| Problème trouvé par la mesure | Correction | Avant | Après |
|---|---|---:|---:|
| `read_limited` initialisait un tampon de 8 Mo (deux fois) pour chaque fichier, quelle que soit sa taille | blocs dimensionnés d'après la taille du fichier, croissance géométrique s'il grandit ; test de non-régression `read_limited_is_exact_whatever_the_size_hint` | `doc.open` 1 Ko : 0,80 ms | 0,02 ms |
| Recherche sans casse : chaque ligne contenant un accent passait par un chemin lent (allocation de deux tableaux de caractères) | chemin rapide sur octets pour tout motif ASCII (seule exception Unicode : le signe kelvin U+212A, vérifié sur tout Unicode) ; test différentiel contre l'implémentation de référence | recherche dans un dossier de 2 000 fichiers / 31 Mo : 254 ms | 219 ms (gain modeste, dans le bruit de la VM). La recherche dans un dossier a été retirée avec l'explorateur ; ce chemin rapide sert toujours au lecteur de gros fichiers |
| Barre d'état : comptage des caractères de tout le document à chaque frappe | total mémorisé par version du texte ; au-delà de 256 Ko, recalcul après 300 ms de repos | profil CPU, 20 frappes dans 1 Mo : 154 ms de JS dans `updateStatus` | 0,8 ms |
| Frappe à 2 Mo : médiane 77 ms, p95 191 ms | seuil d'édition directe abaissé de 2 Mo à 1 Mo (réglable) | — | — |

Contrôle après la dernière correction (le lecteur de gros fichiers refuse
désormais un contenu binaire sans confirmation, en analysant l'échantillon de
1 Mo déjà lu) : 200 premières lignes de 100 Mo en 2,4 ms et index complet en
94 ms (5 essais) — inchangé aux variations près.

Les mesures ont aussi révélé deux défauts fonctionnels, corrigés avec tests
de non-régression :

* une frappe faite pendant le chargement d'un document était perdue ; elle
  est maintenant mise de côté puis rejouée (texte, Entrée, Retour arrière,
  Ctrl+Début/Fin), sauf si le focus est parti ailleurs ;
* à la fin d'un chargement, le focus était repris par l'éditeur même si
  l'utilisateur avait ouvert la palette entre-temps (sa frappe partait dans
  le document).

## Mesurer l'exécutable réel sous Windows

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1 -Bench
# ou, l'exécutable déjà compilé :
powershell -ExecutionPolicy Bypass -File scripts\bench-windows.ps1 -Runs 10 [-File C:\chemin\fichier.txt] [-Core]
```

Chaque essai lance `swiftpad.exe` avec un profil vide séparé
(`SWIFTPAD_PROFILE_DIR`) et `SWIFTPAD_PERF_LOG` : l'application écrit une
ligne de mesures (lancement → fenêtre affichée, lancement → interface prête,
tas JS) ; le script ajoute la mémoire privée et l'ensemble de travail de
SwiftPad **et de ses processus WebView2**, ferme la fenêtre normalement, et
écrit `bench\results\windows-tauri.json`. Le premier essai (caches froids) est
donné à part. **Ce script n'a pas pu être exécuté ici** (pas de Windows).

Dans l'application, *Aide → À propos* affiche les mêmes mesures pour la
session en cours (calculées localement, jamais transmises).
