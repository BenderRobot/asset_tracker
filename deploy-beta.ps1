$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ERROR: $msg" -ForegroundColor Red }

Set-Location $PSScriptRoot

Write-Host "`n  DEPLOIEMENT BETA  " -ForegroundColor White -BackgroundColor DarkBlue

# --- COMMIT MESSAGE ---
$defaultMsg = "beta: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$userInput = Read-Host "Commit message [Enter = '$defaultMsg']"
$commitMsg = if ($userInput.Trim()) { $userInput.Trim() } else { $defaultMsg }

# ─────────────────────────────────────────────
# STEP 1 - GITHUB (branche beta)
# ─────────────────────────────────────────────
Write-Step "[1/2] Push GitHub -> beta"

$currentBranch = git rev-parse --abbrev-ref HEAD

# Creer la branche beta si elle n'existe pas
$betaExists = git branch --list beta
if (-not $betaExists) {
    Write-Warn "Branche 'beta' inexistante - creation depuis main..."
    git checkout main
    git checkout -b beta
} elseif ($currentBranch -ne "beta") {
    Write-Warn "Passage sur la branche beta..."
    git checkout beta
    if ($LASTEXITCODE -ne 0) { Write-Err "git checkout beta failed."; exit 1 }
    # Fusionner les changements de main dans beta
    Write-Warn "Merge main -> beta..."
    git merge main --no-edit
    if ($LASTEXITCODE -ne 0) { Write-Err "Merge failed. Resolvez les conflits manuellement."; exit 1 }
}

git add .

$changed = git status --porcelain
if (-not $changed) {
    Write-Warn "No changes to commit - skipping push."
} else {
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { Write-Err "git commit failed."; exit 1 }
}

git push origin beta --force-with-lease 2>$null
if ($LASTEXITCODE -ne 0) {
    git push --set-upstream origin beta
    if ($LASTEXITCODE -ne 0) { Write-Err "git push failed."; exit 1 }
}

Write-Ok "Pushed to GitHub (beta)."

# ─────────────────────────────────────────────
# STEP 2 - FIREBASE BETA
# ─────────────────────────────────────────────
Write-Step "[2/2] Firebase deploy -> BETA (asset-tracker-beta.web.app)"

if (-not (Test-Path ".\functions\node_modules")) {
    Write-Warn "functions/node_modules not found - running npm install..."
    npm --prefix .\functions install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
}

firebase deploy --only hosting:beta
if ($LASTEXITCODE -ne 0) { Write-Err "Firebase deploy failed."; exit 1 }

Write-Ok "Deploy BETA complete -> https://asset-tracker-beta.web.app"
Write-Warn "Rappel : repassez sur main pour continuer le dev (git checkout main)"
