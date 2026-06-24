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
Write-Step "[1/2] Push GitHub -> main"

git add .

$changed = git status --porcelain
if (-not $changed) {
    Write-Warn "No changes to commit - skipping push."
} else {
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { Write-Err "git commit failed."; exit 1 }

    git push --force-with-lease origin main
    if ($LASTEXITCODE -ne 0) { Write-Err "git push failed."; exit 1 }

    Write-Ok "Pushed to GitHub (main)."
}

# ─────────────────────────────────────────────
# STEP 2 - FIREBASE PROD
# ─────────────────────────────────────────────
Write-Step "[2/2] Firebase deploy -> PROD (asset-tracker.fr)"

if (-not (Test-Path ".\functions\node_modules")) {
    Write-Warn "functions/node_modules not found - running npm install..."
    npm --prefix .\functions install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
}

firebase deploy --only hosting:prod,firestore,functions
if ($LASTEXITCODE -ne 0) { Write-Err "Firebase deploy failed."; exit 1 }

Write-Ok "Deploy PROD complete -> https://asset-tracker.fr"
