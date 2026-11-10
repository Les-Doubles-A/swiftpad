<#
.SYNOPSIS
  Banc d'essai de l'exécutable SwiftPad réel sous Windows (Tauri + WebView2).

.DESCRIPTION
      powershell -ExecutionPolicy Bypass -File scripts\bench-windows.ps1 [-Runs 10] [-File chemin\fichier.txt]

  Pour chaque essai, SwiftPad est lancé avec un profil vide et séparé
  (SWIFTPAD_PROFILE_DIR : vos paramètres et votre session ne sont ni lus ni
  modifiés) et la variable SWIFTPAD_PERF_LOG : une fois l'interface prête,
  l'application écrit une ligne de mesures dans ce fichier (rien n'est écrit
  sans cette variable, rien n'est jamais transmis). Le script mesure ensuite
  la mémoire de SwiftPad et de ses processus WebView2, puis ferme la fenêtre.

  Mesures :
    * lancement → fenêtre affichée (première image) ;
    * lancement → interface prête (session restaurée, fichier ouvert) ;
    * mémoire : ensemble de travail et mémoire privée, processus natif et
      ensemble SwiftPad + WebView2 (somme des processus descendants) ;
    * tas JavaScript et nombre d'éléments DOM.
  Le premier essai est donné à part (caches froids : WebView2, disque) ; les
  suivants sont « à chaud ». Résultats : bench\results\windows-tauri.json.

  Facultatif : -Core lance aussi le banc d'essai du noyau
  (cargo run --release --example bench).
#>
param(
  [string]$Exe = '',
  [int]$Runs = 10,
  [string]$File = '',
  [switch]$Core
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Exe) { $Exe = Join-Path $root 'src-tauri\target\release\swiftpad.exe' }
if (-not (Test-Path $Exe)) { throw "Exécutable introuvable : $Exe (compiler d'abord : scripts\build-windows.ps1)" }
$Exe = (Resolve-Path $Exe).Path
if ($File) { $File = (Resolve-Path $File).Path }

function Median([double[]]$a) {
  if (-not $a -or $a.Count -eq 0) { return $null }
  $s = $a | Sort-Object
  $n = $s.Count
  if ($n % 2) { return [math]::Round($s[($n - 1) / 2], 1) }
  return [math]::Round(($s[$n / 2 - 1] + $s[$n / 2]) / 2, 1)
}

function Get-Tree([int]$rootPid) {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name
  $ids = New-Object System.Collections.Generic.List[int]
  $ids.Add($rootPid)
  $i = 0
  while ($i -lt $ids.Count) {
    $p = $ids[$i]
    foreach ($c in $all | Where-Object { $_.ParentProcessId -eq $p }) { if (-not $ids.Contains([int]$c.ProcessId)) { $ids.Add([int]$c.ProcessId) } }
    $i++
  }
  return $ids
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("swiftpad-bench-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $work | Out-Null
$rows = @()
Write-Host "SwiftPad — banc d'essai Windows : $Runs essais$(if ($File) { ", fichier $File" })"
Write-Host "Exécutable : $Exe"
try {
  for ($i = 1; $i -le $Runs; $i++) {
    $profDir = Join-Path $work "profil-$i"
    $log = Join-Path $work "perf-$i.jsonl"
    New-Item -ItemType Directory -Path $profDir | Out-Null
    $env:SWIFTPAD_PROFILE_DIR = $profDir
    $env:SWIFTPAD_PERF_LOG = $log
    try {
      if ($File) { $p = Start-Process -FilePath $Exe -ArgumentList ('"' + $File + '"') -PassThru }
      else { $p = Start-Process -FilePath $Exe -PassThru }
    } finally {
      Remove-Item Env:\SWIFTPAD_PROFILE_DIR, Env:\SWIFTPAD_PERF_LOG -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Path $log) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path $log)) { Write-Warning "Essai $i : aucune mesure reçue en 60 s."; Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue; continue }
    Start-Sleep -Milliseconds 300
    $m = (Get-Content $log -Raw).Trim().Split("`n")[0] | ConvertFrom-Json
    # Mémoire de l'arborescence de processus (SwiftPad + WebView2).
    $ws = 0; $priv = 0; $count = 0
    foreach ($id in Get-Tree $p.Id) {
      $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
      if ($proc) { $ws += $proc.WorkingSet64; $priv += $proc.PrivateMemorySize64; $count++ }
    }
    $self = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
    $row = [ordered]@{
      run = $i
      processToShownMs = $m.ui.processToShownMs
      processToReadyMs = $m.ui.processToReadyMs
      scriptToReadyMs = [math]::Round($m.ui.scriptToReadyMs, 1)
      nativeWorkingSetMB = if ($self) { [math]::Round($self.WorkingSet64 / 1MB, 1) } else { $null }
      nativePrivateMB = if ($self) { [math]::Round($self.PrivateMemorySize64 / 1MB, 1) } else { $null }
      totalWorkingSetMB = [math]::Round($ws / 1MB, 1)
      totalPrivateMB = [math]::Round($priv / 1MB, 1)
      processes = $count
      jsHeapUsedMB = if ($m.ui.jsHeapUsedBytes) { [math]::Round($m.ui.jsHeapUsedBytes / 1MB, 1) } else { $null }
      domNodes = $m.ui.domNodes
    }
    $rows += [pscustomobject]$row
    Write-Host ("  essai {0,2} : fenêtre {1,6} ms · prête {2,6} ms · mémoire privée totale {3,6} Mo ({4} processus) · natif {5} Mo" -f $i, [math]::Round($row.processToShownMs), [math]::Round($row.processToReadyMs), $row.totalPrivateMB, $count, $row.nativePrivateMB)
    # Fermeture normale (aucun document modifié), sinon forcée après 10 s.
    $null = $p.CloseMainWindow()
    if (-not $p.WaitForExit(10000)) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($rows.Count -eq 0) { throw 'Aucune mesure.' }
$warm = @($rows | Where-Object { $_.run -gt 1 })
if ($warm.Count -eq 0) { $warm = $rows }
$summary = [ordered]@{
  firstRun = $rows[0]
  warmMedian = [ordered]@{
    processToShownMs = Median ($warm | ForEach-Object { [double]$_.processToShownMs })
    processToReadyMs = Median ($warm | ForEach-Object { [double]$_.processToReadyMs })
    totalPrivateMB = Median ($warm | ForEach-Object { [double]$_.totalPrivateMB })
    totalWorkingSetMB = Median ($warm | ForEach-Object { [double]$_.totalWorkingSetMB })
    nativePrivateMB = Median ($warm | ForEach-Object { [double]$_.nativePrivateMB })
    jsHeapUsedMB = Median ($warm | ForEach-Object { [double]$_.jsHeapUsedMB })
  }
}
Write-Host ""
Write-Host "Premier essai (caches froids) : fenêtre $([math]::Round($rows[0].processToShownMs)) ms, interface prête $([math]::Round($rows[0].processToReadyMs)) ms"
Write-Host "Médiane des essais suivants   : fenêtre $($summary.warmMedian.processToShownMs) ms, interface prête $($summary.warmMedian.processToReadyMs) ms"
Write-Host "Mémoire (médiane)             : privée totale $($summary.warmMedian.totalPrivateMB) Mo, ensemble de travail total $($summary.warmMedian.totalWorkingSetMB) Mo, processus natif $($summary.warmMedian.nativePrivateMB) Mo"

$os = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1)
$out = [ordered]@{
  tool = 'scripts/bench-windows.ps1'
  date = (Get-Date).ToString('o')
  machine = [ordered]@{ os = "$($os.Caption) $($os.Version)"; cpu = $cpu.Name.Trim(); logicalCpus = $cpu.NumberOfLogicalProcessors; memoryGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1) }
  file = $File
  runs = $rows
  summary = $summary
}
$dir = Join-Path $root 'bench\results'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$json = Join-Path $dir 'windows-tauri.json'
$out | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $json
Write-Host "Résultats écrits dans $json"

if ($Core) {
  Push-Location (Join-Path $root 'crates\swiftpad-core')
  try { cargo run --release --example bench -- --out (Join-Path $dir 'core-windows.json') } finally { Pop-Location }
}
