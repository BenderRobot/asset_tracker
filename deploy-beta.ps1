$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "`n$msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "  ERROR: $msg" -ForegroundColor Red }

Set-Location $PSScriptRoot

Write-Host "`n  DEPLOIEMENT BETA  " -ForegroundColor White -BackgroundColor DarkBlue
Write-Host "  -> asset-tracker-beta.web.app UNIQUEMENT`n" -ForegroundColor DarkCyan

# S'assurer d'etre sur main
$currentBranch = git rev-parse --abbrev-ref HEAD
if ($currentBranch -ne "main") {
    Write-Warn "Branche '$currentBranch' detectee -> passage automatique sur main..."
    git checkout main
    if ($LASTEXITCODE -ne 0) { Write-Err "git checkout main failed."; exit 1 }
}

# --- COMMIT MESSAGE ---
$defaultMsg = "beta: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$userInput = Read-Host "Commit message [Enter = '$defaultMsg']"
$commitMsg = if ($userInput.Trim()) { $userInput.Trim() } else { $defaultMsg }

# ─────────────────────────────────────────────
# STEP 1 - Commiter sur main + sync branche beta
# ─────────────────────────────────────────────
Write-Step "[1/2] Git : main -> beta"

git add .
$changed = git status --porcelain
if ($changed) {
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { Write-Err "git commit failed."; exit 1 }
    Write-Ok "Commit cree sur main."
} else {
    Write-Warn "Aucun changement a commiter sur main."
}

# Synchroniser la branche beta avec main
$betaExists = git branch --list beta
if (-not $betaExists) {
    Write-Warn "Creation de la branche beta depuis main..."
    git checkout -b beta
} else {
    git checkout beta
    if ($LASTEXITCODE -ne 0) { Write-Err "git checkout beta failed."; exit 1 }
    git merge main --no-edit
    if ($LASTEXITCODE -ne 0) { Write-Err "Merge main->beta failed. Resolvez les conflits."; exit 1 }
}

$remoteBeta = git ls-remote --heads origin beta
if ($remoteBeta) {
    git push origin beta --force-with-lease
} else {
    git push --set-upstream origin beta
}
if ($LASTEXITCODE -ne 0) { Write-Err "git push beta failed."; exit 1 }

# Retour immediat sur main
git checkout main
if ($LASTEXITCODE -ne 0) { Write-Err "git checkout main failed."; exit 1 }
Write-Ok "GitHub beta mis a jour. Retour sur main."

# ─────────────────────────────────────────────
# STEP 2 - Firebase : BETA SEULEMENT
# On passe le site ID direct (asset-tracker-beta)
# pour eviter tout risque de deployer prod
# ─────────────────────────────────────────────
Write-Step "[2/2] Firebase deploy -> BETA (asset-tracker-beta.web.app)"

if (-not (Test-Path ".\functions\node_modules")) {
    Write-Warn "functions/node_modules introuvable - npm install..."
    npm --prefix .\functions install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
}

firebase deploy --only hosting:beta
if ($LASTEXITCODE -ne 0) { Write-Err "Firebase beta deploy failed."; exit 1 }

Write-Host ""
Write-Ok "====================================="
Write-Ok " BETA deploye : https://asset-tracker-beta.web.app"
Write-Ok " Branche actuelle : $(git rev-parse --abbrev-ref HEAD)"
Write-Ok "====================================="
