$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
    git config core.hooksPath .githooks
    if ($LASTEXITCODE -ne 0) { throw "Impossible d'activer le hook Git de version." }

    & (Join-Path $PSScriptRoot 'sync-version.ps1') | Out-Null
    Write-Host 'Suivi de version active pour ce clone.' -ForegroundColor Green
    Write-Host 'feat: augmente la mineure ; fix: augmente le patch ; BREAKING CHANGE augmente la majeure.' -ForegroundColor DarkGray
} finally {
    Pop-Location
}
