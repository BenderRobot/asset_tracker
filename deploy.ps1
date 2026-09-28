param(
    # Opt-out explicite. Par defaut TOUS les Workers Cloudflare sont redeployes a chaque execution.
    [switch]$SkipWorker
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ERROR: $msg" -ForegroundColor Red }

# Barriere bloquante : aucun push ni deploiement si la suite de tests echoue.
function Invoke-TestGate($label) {
    Write-Step "[Tests] npm test ($label)"
    npm test
    if ($LASTEXITCODE -ne 0) { Write-Err "Tests en echec - deploiement annule, rien n'a ete publie."; exit 1 }
    Write-Ok "Tests OK."
}

Set-Location $PSScriptRoot

Write-Host "`n  DEPLOIEMENT PRODUCTION  " -ForegroundColor White -BackgroundColor DarkRed
Write-Host "  -> asset-tracker.fr UNIQUEMENT`n" -ForegroundColor DarkRed

# S'assurer d'etre sur main
$currentBranch = git rev-parse --abbrev-ref HEAD
if ($currentBranch -ne "main") {
    Write-Warn "Branche '$currentBranch' detectee -> passage automatique sur main..."
    git checkout main
    if ($LASTEXITCODE -ne 0) { Write-Err "git checkout main failed."; exit 1 }
}

# Apres la bascule sur main : on teste le code qui sera reellement deploye
# (arbre de travail inclus, il est commite plus bas), avant toute ecriture.
Invoke-TestGate "code a deployer"

# --- COMMIT MESSAGE ---
$defaultMsg = "deploy: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$userInput = Read-Host "Commit message [Enter = '$defaultMsg']"
$commitMsg = if ($userInput.Trim()) { $userInput.Trim() } else { $defaultMsg }

# ─────────────────────────────────────────────
# STEP 1 - GITHUB (branche main)
# ─────────────────────────────────────────────
Write-Step "[1/3] Push GitHub -> main"

# Mettre de côté les modifications en cours pour éviter les blocages du pull
$stashed = $false
$status = git status --porcelain
if ($status) {
    git stash -u
    $stashed = $true
}

# Récupérer les dernières modifications du serveur
$headBeforePull = git rev-parse HEAD
git pull origin main --rebase
if ($LASTEXITCODE -ne 0) { 
    if ($stashed) { git stash pop }
    Write-Err "git pull failed. Conflits potentiels à résoudre manuellement."; exit 1 
}

# Restaurer les modifications mises de côté
if ($stashed) {
    git stash pop
    if ($LASTEXITCODE -ne 0) { 
        Write-Err "Conflit lors du stash pop. Veuillez résoudre les conflits manuellement."; exit 1 
    }
}

# Des commits distants recuperes par le pull n'ont pas encore ete testes.
if ((git rev-parse HEAD) -ne $headBeforePull) { Invoke-TestGate "apres synchronisation avec origin/main" }

git add .

$changed = git status --porcelain
if ($changed) {
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { Write-Err "git commit failed."; exit 1 }
} else {
    Write-Warn "No changes to commit."
}

$commitsAhead = [int](git rev-list --count origin/main..HEAD)
if ($LASTEXITCODE -ne 0) { Write-Err "Unable to compare main with origin/main."; exit 1 }

if ($commitsAhead -gt 0) {
    git push origin main
    if ($LASTEXITCODE -ne 0) { Write-Err "git push failed."; exit 1 }
    Write-Ok "Pushed to GitHub (main)."
} else {
    Write-Warn "GitHub main is already up to date."
}

# ─────────────────────────────────────────────
# STEP 2 - CLOUDFLARE WORKERS (tous)
# ─────────────────────────────────────────────
Write-Step "[2/3] Cloudflare Workers"

if ($SkipWorker) {
    Write-Warn "Workers non deployes (-SkipWorker explicite)."
} else {
    # Chaque sous-dossier de cloudflare-workers/ contenant un wrangler.toml est
    # deploye : un Worker ajoute plus tard ne peut pas etre oublie (seul le
    # Worker prix l'etait auparavant, Gemini et Enable Banking divergeaient du
    # depot). Deploiement systematique et idempotent, sans diff avec origin/main.
    $workerConfigs = @(Get-ChildItem -Path .\cloudflare-workers -Directory |
        ForEach-Object { Join-Path $_.FullName 'wrangler.toml' } |
        Where-Object { Test-Path $_ })
    if ($workerConfigs.Count -eq 0) { Write-Err "Aucun wrangler.toml trouve dans cloudflare-workers/."; exit 1 }

    foreach ($config in $workerConfigs) {
        $workerName = Split-Path (Split-Path $config -Parent) -Leaf
        Write-Warn "Deploying $workerName..."
        npm exec -- wrangler deploy --config $config
        if ($LASTEXITCODE -ne 0) { Write-Err "Deploiement du Worker $workerName echoue. Relancez le script : tous les Workers seront redeployes."; exit 1 }
        Write-Ok "$workerName deployed."
    }
    Write-Ok "$($workerConfigs.Count) Worker(s) Cloudflare deployes."
}

# ─────────────────────────────────────────────
# STEP 3 - FIREBASE PROD
# ─────────────────────────────────────────────
Write-Step "[3/3] Firebase deploy -> PROD (asset-tracker.fr)"

if (-not (Test-Path ".\functions\node_modules")) {
    Write-Warn "functions/node_modules not found - running npm install..."
    npm --prefix .\functions install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
}

firebase deploy --only hosting:prod,firestore,functions
if ($LASTEXITCODE -ne 0) { Write-Err "Firebase deploy failed."; exit 1 }

Write-Ok "Deploy PROD complete -> https://asset-tracker.fr"
