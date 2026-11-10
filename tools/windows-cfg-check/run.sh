#!/usr/bin/env bash
# Vérification PARTIELLE, sous Linux, du code du noyau réservé à Windows
# (#[cfg(windows)] : FFI Win32 — remplacement atomique, mesures du
# processus —, chemins longs, codes d'erreur), sans la bibliothèque standard
# Windows (cible non installable hors ligne).
#
# Méthode : copie du noyau dans un dossier temporaire, puis dans platform.rs
# et error.rs : cfg(windows) → toujours vrai, variantes non Windows → jamais ;
# le trait std::os::windows utilisé (OsStrExt::encode_wide) est remplacé par
# un équivalent de même forme. `cargo check` (sans édition des liens) vérifie alors syntaxe, types,
# signatures FFI et blocs unsafe de ce code.
#
# Ne prouve PAS : l'édition des liens avec kernel32, le comportement
# à l'exécution, ni la conformité des structures C aux en-têtes Windows
# (vérifiée à la main contre la documentation Win32).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -r "$ROOT/crates/swiftpad-core" "$WORK/core"
rm -rf "$WORK/core/target"
python3 - "$WORK/core/src" << 'PY'
import sys, re, pathlib
src = pathlib.Path(sys.argv[1])
def sub(name, pairs):
    p = src / name
    s = p.read_text()
    for a, b in pairs:
        if a not in s:
            raise SystemExit(f"motif absent de {name} : {a}")
        s = s.replace(a, b)
    p.write_text(s)
sub("platform.rs", [
    ("#[cfg(not(windows))]", "#[cfg(any())]"),
    ("#[cfg(windows)]", "#[cfg(all())]"),
    ('#[cfg(target_os = "linux")]', "#[cfg(any())]"),
    ('#[cfg(not(any(windows, target_os = "linux")))]', "#[cfg(any())]"),
    ("cfg!(windows)", "true"),
    ("use std::os::windows::ffi::OsStrExt;", "use crate::winshim::OsStrExt;"),
])
sub("error.rs", [
    ("#[cfg(not(any(windows, unix)))]", "#[cfg(any())]"),
    ("#[cfg(windows)]", "#[cfg(all())]"),
    ("#[cfg(unix)]", "#[cfg(any())]"),
])
lib = src / "lib.rs"
lib.write_text(lib.read_text() + "\n/// Équivalents des traits std::os::windows (vérification sous Linux).\npub mod winshim {\n    pub trait OsStrExt { fn encode_wide(&self) -> std::vec::IntoIter<u16>; }\n    impl OsStrExt for std::ffi::OsStr { fn encode_wide(&self) -> std::vec::IntoIter<u16> { self.to_string_lossy().encode_utf16().collect::<Vec<u16>>().into_iter() } }\n}\n")
PY
cd "$WORK/core"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/windows-cfg-check}" cargo check --offline --lib
echo "OK : le code #[cfg(windows)] du noyau est cohérent (vérification partielle, sans édition des liens)."
