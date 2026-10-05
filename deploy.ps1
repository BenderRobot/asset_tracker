<#
.SYNOPSIS
Deploie tout ou seulement une partie de la production.

.EXAMPLE
.\deploy.ps1

.EXAMPLE
.\deploy.ps1 firebase

.EXAMPLE
.\deploy.ps1 -Target github,worker
#>
param(
    # Cibles a deployer. "All" conserve le comportement historique.
    [Parameter(Position = 0)]
    [ValidateSet('All', 'GitHub', 'Worker', 'Firebase')]
    [string[]]$Target = @('All'),
    # Opt-out explicite : aucun Worker Cloudflare n'est deploye.
    [switch]$SkipWorker,
    # Redeploie tous les Workers meme si leur code n'a pas change depuis le
    # dernier deploiement reussi (ex. apres un rollback dans le dashboard Cloudflare).
    [switch]$ForceWorkers,
    # Nombre de nouvelles tentatives apres un echec Firebase (2 = 3 essais au total).
    [ValidateRange(0, 5)]
    [int]$FirebaseRetries = 2
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

$allTargets = $Target -contains 'All'
$deployGitHub = $allTargets -or $Target -contains 'GitHub'
$deployWorkers = $allTargets -or $Target -contains 'Worker'
$deployFirebase = $allTargets -or $Target -contains 'Firebase'
$selectedTargets = @()
if ($deployGitHub) { $selectedTargets += 'GitHub' }
if ($deployWorkers -and -not $SkipWorker) { $selectedTargets += 'Workers' }
if ($deployFirebase) { $selectedTargets += 'Firebase' }

if ($selectedTargets.Count -eq 0) {
    Write-Err "Aucune cible a deployer. Retirez -SkipWorker ou choisissez une autre cible."
    exit 1
}

Write-Host "`n  DEPLOIEMENT PRODUCTION  " -ForegroundColor White -BackgroundColor DarkRed
Write-Host "  -> asset-tracker.fr UNIQUEMENT`n" -ForegroundColor DarkRed
Write-Host "  Cibles : $($selectedTargets -join ', ')`n" -ForegroundColor DarkGray

# S'assurer d'etre sur main
$currentBranch = git rev-parse --abbrev-ref HEAD
if ($currentBranch -ne "main") {
    Write-Warn "Branche '$currentBranch' detectee -> passage automatique sur main..."
    git checkout main
    if ($LASTEXITCODE -ne 0) { Write-Err "git checkout main failed."; exit 1 }
}

# Prepare le numero du prochain commit (ou resynchronise le build courant si
# aucun fichier n'a change). Le hook Git le verifiera de nouveau au commit.
$pendingChanges = git status --porcelain --untracked-files=all
if ($pendingChanges) {
    & (Join-Path $PSScriptRoot 'scripts\sync-version.ps1') -NextCommit | Out-Null
} else {
    & (Join-Path $PSScriptRoot 'scripts\sync-version.ps1') | Out-Null
}
if ($LASTEXITCODE -ne 0) { Write-Err "Mise a jour de version.json impossible."; exit 1 }

# Apres la bascule sur main : on teste le code qui sera reellement deploye
# (arbre de travail inclus, il est commite plus bas), avant toute ecriture.
Invoke-TestGate "code a deployer"

if ($deployGitHub) {
# --- COMMIT MESSAGE ---
$defaultMsg = "deploy: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
$userInput = Read-Host "Commit message [Enter = '$defaultMsg']"
$commitMsg = if ($userInput.Trim()) { $userInput.Trim() } else { $defaultMsg }

# ─────────────────────────────────────────────
# STEP 1 - GITHUB (branche main)
# ─────────────────────────────────────────────
Write-Step "[GitHub] Push -> main"

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
}

# ─────────────────────────────────────────────
# STEP 2 - CLOUDFLARE WORKERS (tous)
# ─────────────────────────────────────────────
if ($deployWorkers) {
Write-Step "[Workers] Cloudflare"

if ($SkipWorker) {
    Write-Warn "Workers non deployes (-SkipWorker explicite)."
} else {
    # Chaque sous-dossier de cloudflare-workers/ contenant un wrangler.toml est
    # pris en compte : un Worker ajoute plus tard ne peut pas etre oublie.
    #
    # Un Worker n'est redeploye que si son code differe de celui du DERNIER
    # DEPLOIEMENT REUSSI, et non d'origin/main : le push Git a lieu avant cette
    # etape, donc un diff avec origin/main serait vide apres un echec Wrangler
    # et le Worker ne serait jamais redeploye. L'empreinte n'est enregistree
    # qu'apres un `wrangler deploy` reussi, dans un fichier local ignore par Git.
    $workerConfigs = @(Get-ChildItem -Path .\cloudflare-workers -Directory |
        ForEach-Object { Join-Path $_.FullName 'wrangler.toml' } |
        Where-Object { Test-Path $_ })
    if ($workerConfigs.Count -eq 0) { Write-Err "Aucun wrangler.toml trouve dans cloudflare-workers/."; exit 1 }

    $stateFile = Join-Path $PSScriptRoot '.wrangler\deploy-state.json'
    $deployState = @{}
    if (Test-Path $stateFile) {
        try {
            (Get-Content $stateFile -Raw | ConvertFrom-Json).PSObject.Properties |
                ForEach-Object { $deployState[$_.Name] = $_.Value }
        } catch {
            Write-Warn "Etat de deploiement illisible - tous les Workers seront redeployes."
        }
    }

    # Empreinte du code d'un Worker : chemins relatifs + contenu de tous ses
    # fichiers, hors caches locaux de Wrangler et dependances.
    function Get-WorkerFingerprint($dir) {
        $entries = Get-ChildItem -Path $dir -Recurse -File |
            Where-Object { $_.FullName -notmatch '\\(\.wrangler|node_modules)\\' } |
            Sort-Object FullName |
            ForEach-Object { "$($_.FullName.Substring($dir.Length))|$((Get-FileHash $_.FullName -Algorithm SHA256).Hash)" }
        $bytes = [System.Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '') } finally { $sha.Dispose() }
    }

    $deployed = 0
    foreach ($config in $workerConfigs) {
        $workerDir = Split-Path $config -Parent
        $workerName = Split-Path $workerDir -Leaf
        $fingerprint = Get-WorkerFingerprint $workerDir

        if (-not $ForceWorkers -and $deployState[$workerName] -eq $fingerprint) {
            Write-Ok "$workerName inchange depuis le dernier deploiement - ignore."
            continue
        }

        Write-Warn "Deploying $workerName..."
        npm exec -- wrangler deploy --config $config
        if ($LASTEXITCODE -ne 0) { Write-Err "Deploiement du Worker $workerName echoue. Relancez le script : il sera retente."; exit 1 }

        # Enregistre apres CHAQUE succes : un echec sur un Worker suivant ne
        # fait pas redeployer ceux qui sont deja a jour.
        $deployState[$workerName] = $fingerprint
        New-Item -ItemType Directory -Force (Split-Path $stateFile -Parent) | Out-Null
        $deployState | ConvertTo-Json | Out-File -FilePath $stateFile -Encoding utf8
        Write-Ok "$workerName deployed."
        $deployed++
    }
    Write-Ok "$deployed Worker(s) Cloudflare deploye(s), $($workerConfigs.Count - $deployed) inchange(s)."
}
}

# ─────────────────────────────────────────────
# STEP 3 - FIREBASE PROD
# ─────────────────────────────────────────────
if ($deployFirebase) {
Write-Step "[Firebase] Deploy -> PROD (asset-tracker.fr)"

if (-not (Test-Path ".\functions\node_modules")) {
    Write-Warn "functions/node_modules not found - running npm install..."
    npm --prefix .\functions install
    if ($LASTEXITCODE -ne 0) { Write-Err "npm install failed."; exit 1 }
}

# Utilise la version de firebase-tools verrouillee dans package-lock.json au
# lieu d'une installation globale qui peut varier d'une machine a l'autre.
$firebaseCli = Join-Path $PSScriptRoot 'node_modules\.bin\firebase.cmd'
if (-not (Test-Path $firebaseCli)) {
    Write-Warn "Firebase CLI locale introuvable - running npm install..."
    npm install
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $firebaseCli)) {
        Write-Err "Installation de Firebase CLI impossible."
        exit 1
    }
}

# Evite le faux message d'erreur "firebase-tools update check failed" cause
# par le cache update-notifier sous Windows. Cela ne desactive pas le deploy.
$env:NO_UPDATE_NOTIFIER = '1'

$firebaseProject = 'asset-tracker-479809-b80f1'
$maxAttempts = $FirebaseRetries + 1
$firebaseSucceeded = $false
$lastDebugLog = $null

for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    if ($attempt -gt 1) {
        Write-Warn "Nouvelle tentative Firebase ($attempt/$maxAttempts)..."
    }

    & $firebaseCli deploy --project $firebaseProject --only "hosting:prod,firestore,functions"
    if ($LASTEXITCODE -eq 0) {
        $firebaseSucceeded = $true
        break
    }

    # Firebase cree ce fichier lors d'un vrai echec. On en garde une copie
    # datee dans un dossier local ignore par Git pour faciliter le diagnostic.
    $debugLog = Join-Path $PSScriptRoot 'firebase-debug.log'
    if (Test-Path $debugLog) {
        try {
            $logDir = Join-Path $PSScriptRoot '.firebase\deploy-logs'
            New-Item -ItemType Directory -Force -Path $logDir | Out-Null
            $logName = "firebase-deploy-{0}-attempt-{1}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $attempt
            $lastDebugLog = Join-Path $logDir $logName
            Copy-Item -LiteralPath $debugLog -Destination $lastDebugLog -Force
            Write-Warn "Journal Firebase conserve : $lastDebugLog"
        } catch {
            Write-Warn "Impossible de conserver firebase-debug.log : $($_.Exception.Message)"
        }
    }

    if ($attempt -lt $maxAttempts) {
        $delay = [Math]::Min(30, 5 * [Math]::Pow(2, $attempt - 1))
        Write-Warn "Echec Firebase. Nouvel essai dans $delay secondes."
        Start-Sleep -Seconds $delay
    }
}

if (-not $firebaseSucceeded) {
    Write-Err "Firebase deploy failed after $maxAttempts attempt(s)."
    Write-Warn "Relancez uniquement Firebase avec : .\deploy.ps1 firebase"
    if ($lastDebugLog) { Write-Warn "Dernier journal : $lastDebugLog" }
    exit 1
}

Write-Ok "Deploy PROD complete -> https://asset-tracker.fr"
}
