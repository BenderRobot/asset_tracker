$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ERROR: $msg" -ForegroundColor Red }

Set-Location $PSScriptRoot

# --- COMMIT MESSAGE ---
$defaultMsg = "deploy: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$userInput = Read-Host "Commit message [Enter = '$defaultMsg']"
$commitMsg = if ($userInput.Trim()) { $userInput.Trim() } else { $defaultMsg }

# ─────────────────────────────────────────────
# STEP 1 - GITHUB
# ─────────────────────────────────────────────
Write-Step "[1/2] Push GitHub"

git add .

$changed = git status --porcelain
if (-not $changed) {
    Write-Warn "No changes to commit - skipping push."
} else {
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { Write-Err "git commit failed."; exit 1 }

    git push --force-with-lease origin main
    if ($LASTEXITCODE -ne 0) { Write-Err "git push failed."; exit 1 }

    Write-Ok "Pushed to GitHub."
}

# ─────────────────────────────────────────────
# STEP 2 - FIREBASE
# ─────────────────────────────────────────────
Write-Step "[2/2] Firebase deploy"

# Install functions dependencies if node_modules is missing
if (-not (Test-Path ".\functions\node_modules")) {
    Write-Warn "functions/node_modules not found - running npm install..."
    npm --prefix .\functions install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
}

firebase deploy
if ($LASTEXITCODE -ne 0) { Write-Err "Firebase deploy failed."; exit 1 }

Write-Ok "Deploy complete."
