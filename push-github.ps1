$ErrorActionPreference = 'Stop'

$repoPath = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoPath

Write-Host "Initialisation du dépôt Git..."
if (-not (Test-Path .git)) {
    git init
}

Write-Host "Ajout des fichiers..."
git add .

Write-Host "Création du commit..."
git commit -m "chore: organize app structure and prepare GitHub push"

Write-Host ""
Write-Host "Configuration du dépôt distant..."
$remoteExists = git remote
if (-not $remoteExists) {
    $remoteUrl = Read-Host "Entrez l'URL GitHub de votre repo"
    if (-not $remoteUrl) {
        throw "URL GitHub manquante."
    }
    git remote add origin $remoteUrl
}

Write-Host ""
Write-Host "Branche principale : main"
git branch -M main

Write-Host "Push vers GitHub..."
git push -u origin main
