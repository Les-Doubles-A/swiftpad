#!/usr/bin/env bash
# Vérification complète, depuis un état propre, de tout ce qui est vérifiable
# sous Linux (environnement de développement et d'intégration continue) :
#   bash scripts/verify-all.sh [--keep]     (--keep : sans nettoyage préalable)
# Journal : target-web/verify-all.log
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p target-web
LOG="$ROOT/target-web/verify-all.log"
: > "$LOG"
FAILED=()

if [ "${1:-}" != "--keep" ]; then
  rm -rf dist target crates/swiftpad-core/target target-web/e2e-results.json
fi

step() {
  local name="$1"; shift
  echo "== $name" | tee -a "$LOG"
  local t0=$SECONDS
  if "$@" >>"$LOG" 2>&1; then
    echo "   OK ($((SECONDS - t0)) s)" | tee -a "$LOG"
  else
    echo "   ÉCHEC ($((SECONDS - t0)) s) — voir $LOG" | tee -a "$LOG"
    FAILED+=("$name")
  fi
}

{
  echo "Date : $(date -Iseconds)"
  echo "Système : $(uname -srm)"
  echo "rustc : $(rustc --version)  ·  node : $(node --version)  ·  tsc : $(npx tsc --version)"
} | tee -a "$LOG"

step "Noyau Rust : tests unitaires et d'intégration (release)" cargo test --release --manifest-path crates/swiftpad-core/Cargo.toml
step "Noyau Rust : erreurs système réelles (disque plein, accès refusés)" bash scripts/test-core.sh
step "Couche Tauri : vérification contre les stubs (partielle)" bash tools/tauri-stub-check/run.sh
step "Noyau : code #[cfg(windows)] (partielle, sans édition des liens)" bash tools/windows-cfg-check/run.sh
step "Interface : vérification des types" npx tsc --noEmit -p .
step "Interface : tests unitaires" node scripts/test-unit.mjs
step "Interface : compilation de production" node scripts/build-web.mjs
step "Vérification hors ligne (statique)" node scripts/check-offline.mjs
step "Contrat interface ↔ couche native (statique)" node scripts/check-ipc.mjs
step "Harnais de test (release)" cargo build --release --manifest-path crates/swiftpad-core/Cargo.toml --bin swiftpad-harness
step "Tests de bout en bout (Chromium + noyau réel)" node tests/e2e/run.mjs

echo | tee -a "$LOG"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "Toutes les étapes ont réussi." | tee -a "$LOG"
else
  echo "Étapes en échec : ${FAILED[*]}" | tee -a "$LOG"
  exit 1
fi
