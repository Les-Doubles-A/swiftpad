#!/usr/bin/env bash
# Vérification PARTIELLE de src-tauri/src/main.rs sans accès à crates.io :
# le code est vérifié (cargo check) contre des « stubs » écrits à la main qui
# reproduisent les signatures des API Tauri 2 utilisées.
#
# Ce que cela prouve : syntaxe, types, emprunts et appels au noyau swiftpad-core
# corrects, SI les stubs reflètent fidèlement les API réelles.
# Ce que cela NE prouve PAS : compilation avec le vrai Tauri, comportement à
# l'exécution, IPC réelle. La vraie compilation se fait sous Windows avec
# scripts/build-windows.ps1.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cp -r "$HERE/stubs" "$WORK/stubs"
mkdir -p "$WORK/app/src"
cp "$ROOT/src-tauri/src/main.rs" "$WORK/app/src/main.rs"
cp "$ROOT/src-tauri/build.rs" "$WORK/app/build.rs"
# Cargo.toml de l'application avec les dépendances redirigées vers les stubs.
sed -e 's#^tauri-build = .*#tauri-build = { path = "../stubs/tauri-build" }#' \
    -e 's#^tauri = .*#tauri = { path = "../stubs/tauri" }#' \
    -e 's#^tauri-plugin-dialog = .*#tauri-plugin-dialog = { path = "../stubs/dialog" }#' \
    -e 's#^tauri-plugin-opener = .*#tauri-plugin-opener = { path = "../stubs/opener" }#' \
    -e 's#^tauri-plugin-single-instance = .*#tauri-plugin-single-instance = { path = "../stubs/single" }#' \
    -e 's#^serde = .*#serde = { path = "../stubs/serde", features = ["derive"] }#' \
    -e "s#^swiftpad-core = .*#swiftpad-core = { path = \"$ROOT/crates/swiftpad-core\" }#" \
    "$ROOT/src-tauri/Cargo.toml" > "$WORK/app/Cargo.toml"
cd "$WORK/app"
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/target/stub-check}" cargo check --offline
echo "OK : main.rs est cohérent avec les stubs Tauri 2 (vérification partielle)."
