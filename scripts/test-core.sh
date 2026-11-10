#!/usr/bin/env bash
# Tests du noyau Rust (Linux/macOS) : unitaires + intégration, y compris
# les erreurs système réelles quand l'environnement le permet :
#   * disque plein : petit tmpfs (nécessite les droits root pour monter) ;
#   * accès refusé : exécution des tests sous l'utilisateur « nobody ».
# Sous Windows, utiliser scripts/build-windows.ps1 (cargo test natif).
set -euo pipefail
cd "$(dirname "$0")/../crates/swiftpad-core"

echo "== cargo test (unitaires + intégration)"
cargo test --offline --quiet 2>&1 | grep -E "test result|FAILED|panicked|error" || true
cargo test --offline --quiet >/dev/null 2>&1 || { echo "ÉCHEC des tests"; exit 1; }

FULL=""
if [ "$(id -u)" = "0" ]; then
  FULL=$(mktemp -d)
  if mount -t tmpfs -o size=64k tmpfs "$FULL" 2>/dev/null; then
    echo "== disque plein simulé (tmpfs 64 Ko dans $FULL)"
    SWIFTPAD_FULL_DISK_DIR="$FULL" cargo test --offline --quiet --test system_errors disk_full -- --nocapture 2>&1 | grep -E "test result|FAILED|panicked|ignoré" || true
    SWIFTPAD_FULL_DISK_DIR="$FULL" cargo test --offline --quiet --test system_errors disk_full >/dev/null 2>&1 || { umount "$FULL"; echo "ÉCHEC disque plein"; exit 1; }
    umount "$FULL"
  else
    echo "== disque plein : non testé (montage tmpfs impossible)"
  fi
  rmdir "$FULL" 2>/dev/null || true

  echo "== accès refusés réels (utilisateur nobody)"
  BIN=$(cargo test --offline --no-run --test system_errors 2>&1 | grep -oE 'target/debug/deps/system_errors-[a-f0-9]+' | tail -1)
  TMPU=$(mktemp -d)
  chmod 1777 "$TMPU"
  if setpriv --reuid=65534 --regid=65534 --clear-groups env SWIFTPAD_UNPRIVILEGED=1 SWIFTPAD_TEST_TMP="$TMPU" "./$BIN" unprivileged 2>&1 | grep -E "test result|FAILED|panicked"; then :; fi
  setpriv --reuid=65534 --regid=65534 --clear-groups env SWIFTPAD_UNPRIVILEGED=1 SWIFTPAD_TEST_TMP="$TMPU" "./$BIN" unprivileged >/dev/null 2>&1 || { echo "ÉCHEC accès refusés"; exit 1; }
  rm -rf "$TMPU"
else
  echo "== exécution sans root : tests d'accès refusés réels"
  SWIFTPAD_UNPRIVILEGED=1 cargo test --offline --quiet --test system_errors unprivileged 2>&1 | grep -E "test result|FAILED" || true
fi
echo "OK"
