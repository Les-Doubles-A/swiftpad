<#
.SYNOPSIS
  Compile, teste et empaquette SwiftPad sous Windows (installateurs NSIS et MSI).

.DESCRIPTION
  À lancer depuis PowerShell, dans le dossier du projet :

      powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1

  Étapes :
    1. vérification des prérequis (Node.js, Rust MSVC, outils C++, WebView2) ;
    2. dépendances npm ;
    3. tests du noyau Rust, vérification des types, tests unitaires ;
    4. interface compilée et vérification « hors ligne » ;
    5. compilation de l'application Tauri (release) et des installateurs ;
    6. (option -Bench) banc d'essai de l'exécutable réel (scripts\bench-windows.ps1).

  Options :
    -SkipTests  ne lance pas les tests (compilation seule)
    -NoBundle   compile l'exécutable sans produire d'installateur
    -Bench      lance le banc d'essai après la compilation

  Remarque : l'empaquetage (NSIS, WiX pour le MSI) télécharge ses outils au
  premier lancement : une connexion Internet est nécessaire pour la
  compilation, pas pour l'application.
#>
param(
  [switch]$SkipTests,
  [switch]$NoBundle,
  [switch]$Bench
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Step([string]$name, [scriptblock]$block) {
  Write-Host ""
  Write-Host "== $name ==" -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  & $block
  if ($LASTEXITCODE -ne 0) { throw "Échec de l'étape « $name » (code $LASTEXITCODE)." }
}

# Étape de test : un échec est signalé mais n'empêche pas la compilation
# (les tests du noyau n'ont jamais été exécutés sous Windows avant cette
# version : un test propre à Linux pourrait échouer). Résumé à la fin.
$script:testFailures = @()
function TestStep([string]$name, [scriptblock]$block) {
  Write-Host ""
  Write-Host "== $name ==" -ForegroundColor Cyan
  $global:LASTEXITCODE = 0
  & $block
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "Échec : $name (code $LASTEXITCODE). La compilation continue ; voir le résumé final."
    $script:testFailures += $name
  }
}

function Need([string]$cmd, [string]$hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "« $cmd » introuvable. $hint" }
}

# --- 1. Prérequis -----------------------------------------------------------------
Write-Host "== Prérequis ==" -ForegroundColor Cyan
Need 'node' 'Installer Node.js 20 ou plus récent : https://nodejs.org'
Need 'npm' 'npm est installé avec Node.js.'
Need 'cargo' 'Installer Rust avec la chaîne MSVC (rustup) : https://rustup.rs'
$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js $((node --version)) trop ancien : version 20 ou plus récente requise." }
Write-Host "Node.js $(node --version) · $(cargo --version) · $(rustc --version)"
$hostTriple = (rustc -vV | Select-String '^host:').ToString().Split(' ')[1]
if ($hostTriple -notlike '*-pc-windows-msvc') {
  Write-Warning "Chaîne Rust « $hostTriple » : Tauri requiert la chaîne MSVC (rustup default stable-msvc)."
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$vc = $null
if (Test-Path $vswhere) { $vc = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath }
if (-not $vc) {
  Write-Warning "Outils de compilation C++ (MSVC) non détectés. Installer « Build Tools for Visual Studio » avec la charge « Développement Desktop en C++ » : https://visualstudio.microsoft.com/visual-cpp-build-tools/"
} else { Write-Host "Outils MSVC : $vc" }
$wvKey = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$wv = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$wvKey" -ErrorAction SilentlyContinue
if (-not $wv) { $wv = Get-ItemProperty "HKCU:\Software\Microsoft\EdgeUpdate\Clients\$wvKey" -ErrorAction SilentlyContinue }
if ($wv) { Write-Host "WebView2 Runtime $($wv.pv)" }
else { Write-Warning "WebView2 Runtime non détecté (préinstallé sur Windows 11 et Windows 10 à jour). L'installateur NSIS le propose si nécessaire." }

# --- 2. Dépendances ---------------------------------------------------------------
Step 'Dépendances npm' { if (Test-Path 'package-lock.json') { npm ci } else { npm install } }

# --- 3. Tests ---------------------------------------------------------------------
if (-not $SkipTests) {
  TestStep 'Tests du noyau Rust' { cargo test --release --manifest-path crates/swiftpad-core/Cargo.toml }
  TestStep 'Vérification des types (TypeScript)' { npm run typecheck }
  TestStep 'Tests unitaires de l''interface' { npm run test:unit }
}

# --- 4. Interface -----------------------------------------------------------------
Step 'Interface compilée' { npm run build:web }
Step 'Vérification hors ligne' { npm run check:offline }
Step 'Contrat interface / couche native' { npm run check:ipc }

# --- 5. Application ---------------------------------------------------------------
if ($NoBundle) { Step 'Application Tauri (sans installateur)' { npx tauri build --no-bundle } }
else { Step 'Application Tauri et installateurs' { npx tauri build } }

$exe = Join-Path $root 'src-tauri\target\release\swiftpad.exe'
Write-Host ""
Write-Host "== Résultat ==" -ForegroundColor Green
if (Test-Path $exe) { Write-Host ("Exécutable : {0} ({1:N1} Mo)" -f $exe, ((Get-Item $exe).Length / 1MB)) }
foreach ($pattern in @('src-tauri\target\release\bundle\nsis\*.exe', 'src-tauri\target\release\bundle\msi\*.msi')) {
  Get-ChildItem $pattern -ErrorAction SilentlyContinue | ForEach-Object { Write-Host ("Installateur : {0} ({1:N1} Mo)" -f $_.FullName, ($_.Length / 1MB)) }
}

# --- 6. Banc d'essai (facultatif) ---------------------------------------------------
if ($Bench) { & (Join-Path $PSScriptRoot 'bench-windows.ps1') -Exe $exe }

if ($script:testFailures.Count -gt 0) {
  Write-Host ""
  Write-Warning ("Compilation terminée, mais des tests ont échoué : " + ($script:testFailures -join ', ') + '. Merci de conserver leur sortie : ils n''avaient jamais été exécutés sous Windows.')
  exit 1
}
