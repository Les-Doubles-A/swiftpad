# Expériences du choix de l'éditeur

Scripts exécutés le 12 octobre 2026 (Chromium 141 headless, VM Linux 2 vCPU)
pour choisir le composant d'édition ; synthèse et chiffres dans
`docs/decisions.md` (section « Éditeur »).

| Script | Question |
|---|---|
| `1-textarea-tailles.mjs` | coût d'une zone de texte native selon la taille (1 à 100 Mo) : affectation, première image, insertion, annulation, lecture de `value` |
| `2-textarea-vs-contenteditable.mjs` | zone de texte (avec/sans retour à la ligne) contre contenteditable par blocs |
| `3-contenteditable-anomalies.mjs` | comportements de contenteditable qui perdent ou déforment le texte |
| `4-annulation-native.mjs` | l'historique d'annulation de Chromium est-il propre à chaque zone de texte ? (non : il est global à la page) ; `beforeinput` annulable, `setRangeText`, IME |

Lancement depuis la racine du dépôt : `node bench/experiments/<script>`
(Playwright et Chromium installés). Ce sont des expériences ponctuelles,
pas des tests : leurs sorties sont des journaux à lire.
