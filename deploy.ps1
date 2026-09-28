param(
    # Opt-out explicite. Par defaut le Worker prix est redeploye a chaque execution.
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
# STEP 2 - CLOUDFLARE WORKER PRIX
# ─────────────────────────────────────────────
Write-Step "[2/3] Cloudflare Worker prix"

if ($SkipWorker) {
    Write-Warn "Worker non deploye (-SkipWorker explicite)."
} else {
    # Deploiement systematique et idempotent : il ne depend plus d'un diff avec
    # origin/main, vide des qu'un push a reussi avant un echec Wrangler.
    Write-Warn "Deploying asset-tracker-prices..."
    npm exec -- wrangler deploy --config .\cloudflare-workers\prices-worker\wrangler.toml
    if ($LASTEXITCODE -ne 0) { Write-Err "Cloudflare Worker deploy failed. Relancez le script : le Worker sera redeploye."; exit 1 }
    Write-Ok "Cloudflare Worker deployed."
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
