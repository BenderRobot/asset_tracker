param(
    [string]$Url = 'https://asset-tracker.fr'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$local = Get-Content (Join-Path $projectRoot 'version.json') -Raw | ConvertFrom-Json
$endpoint = "{0}/version.json?t={1}" -f $Url.TrimEnd('/'), [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()

try {
    $live = Invoke-RestMethod -Uri $endpoint -Headers @{ 'Cache-Control' = 'no-cache' }
} catch {
    Write-Error "Version en ligne indisponible sur $Url. Le systeme doit d'abord etre deploye."
    exit 1
}

if (-not $live.version -or $null -eq $live.build) {
    Write-Error "La reponse de $Url ne contient pas un manifeste de version valide."
    exit 1
}

Write-Host "En ligne : v$($live.version)" -ForegroundColor Cyan
Write-Host "Locale   : v$($local.version)" -ForegroundColor Cyan

if ([int]$live.build -eq [int]$local.build) {
    Write-Host 'La production et le depot local sont sur le meme build.' -ForegroundColor Green
} elseif ([int]$live.build -lt [int]$local.build) {
    Write-Host "La production a $([int]$local.build - [int]$live.build) build(s) de retard." -ForegroundColor Yellow
} else {
    Write-Host "La production a $([int]$live.build - [int]$local.build) build(s) d'avance sur ce clone." -ForegroundColor Yellow
}
