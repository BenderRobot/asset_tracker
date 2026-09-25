$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ERROR: $msg" -ForegroundColor Red }

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

git add .

$changed = git status --porcelain
if ($changed) {
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { Write-Err "git commit failed."; exit 1 }
} else {
    Write-Warn "No changes to commit."
}

# Déterminer avant le push si les commits à publier modifient le Worker prix.
# Après le push, origin/main pointerait déjà sur HEAD et cette information serait perdue.
$workerChanges = git diff --name-only origin/main..HEAD -- cloudflare-workers/prices-worker
if ($LASTEXITCODE -ne 0) { Write-Err "Unable to inspect Worker changes."; exit 1 }
$workerChanged = [bool]$workerChanges

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

if ($workerChanged) {
    Write-Warn "Worker changes detected - deploying asset-tracker-prices..."
    npm exec -- wrangler deploy --config .\cloudflare-workers\prices-worker\wrangler.toml
    if ($LASTEXITCODE -ne 0) { Write-Err "Cloudflare Worker deploy failed."; exit 1 }
    Write-Ok "Cloudflare Worker deployed."
} else {
    Write-Ok "No Worker changes - deployment skipped."
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
