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

# Prepare la beta depuis le main le plus recent, en conservant les changements
# locaux et leur etat staged avant le calcul de version.
$stashed = [bool](git status --porcelain)
if ($stashed) {
    git stash -u
    if ($LASTEXITCODE -ne 0) { Write-Err 'Sauvegarde temporaire des changements impossible.'; exit 1 }
}
git pull origin main --rebase
if ($LASTEXITCODE -ne 0) {
    if ($stashed) { git stash pop --index }
    Write-Err 'Synchronisation de main impossible.'
    exit 1
}
if ($stashed) {
    git stash pop --index
    if ($LASTEXITCODE -ne 0) { Write-Err 'Restauration des changements locaux impossible.'; exit 1 }
}

# --- COMMIT MESSAGE ---
$defaultMsg = "beta: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$userInput = Read-Host "Commit message [Enter = '$defaultMsg']"
$commitMsg = if ($userInput.Trim()) { $userInput.Trim() } else { $defaultMsg }

# Toute publication beta recoit son propre correctif, meme sans autre fichier
# modifie. Une beta deja en ligne est prise en compte avant la preparation.
$releaseArgs = @('scripts/prepare-release.mjs', '--message', $commitMsg)
try {
    $betaUrl = "https://asset-tracker-beta.web.app/version.json?t=$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    $liveBeta = Invoke-RestMethod -Uri $betaUrl -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-cache' }
    if (-not $liveBeta.version -or $null -eq $liveBeta.build) { throw 'Manifeste beta invalide.' }
    $releaseArgs += @('--published-version', [string]$liveBeta.version, '--published-build', [string]$liveBeta.build)
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -ne 404) { Write-Err "Version beta illisible : $($_.Exception.Message)"; exit 1 }
}
node @releaseArgs
if ($LASTEXITCODE -ne 0) { Write-Err 'Preparation de version impossible.'; exit 1 }
npm test
if ($LASTEXITCODE -ne 0) { Write-Err 'Tests en echec avant deploy beta.'; exit 1 }

# ─────────────────────────────────────────────
# STEP 1 - Commiter sur main + sync branche beta
# ─────────────────────────────────────────────
Write-Step "[1/2] Git : main -> beta"

git add .
$changed = git status --porcelain
if ($changed) {
    git commit -m $commitMsg
    if ($LASTEXITCODE -ne 0) { Write-Err "git commit failed."; exit 1 }
    node scripts/prepare-release.mjs --check --committed
    if ($LASTEXITCODE -ne 0) { Write-Err 'Version du commit incoherente.'; exit 1 }
    npm test
    if ($LASTEXITCODE -ne 0) { Write-Err 'Tests en echec apres commit beta.'; exit 1 }
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

$releaseForDeploy = Get-Content (Join-Path $PSScriptRoot 'version.json') -Raw | ConvertFrom-Json
$env:ASSET_TRACKER_RELEASE_ID = "$($releaseForDeploy.version):$($releaseForDeploy.build)"
firebase deploy --only hosting:beta
if ($LASTEXITCODE -ne 0) { Write-Err "Firebase beta deploy failed."; exit 1 }
& (Join-Path $PSScriptRoot 'scripts\check-live-version.ps1') -Url 'https://asset-tracker-beta.web.app' -Exact
if ($LASTEXITCODE -ne 0) { Write-Err 'La beta ne sert pas la version du commit deploye.'; exit 1 }

Write-Host ""
Write-Ok "====================================="
Write-Ok " BETA deploye : https://asset-tracker-beta.web.app"
Write-Ok " Branche actuelle : $(git rev-parse --abbrev-ref HEAD)"
Write-Ok "====================================="
