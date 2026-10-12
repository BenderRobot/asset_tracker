param(
    [string]$Url = 'https://asset-tracker.fr',
    [switch]$Exact,
    [ValidateRange(1, 10)][int]$Attempts = 5
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$local = Get-Content (Join-Path $projectRoot 'version.json') -Raw | ConvertFrom-Json
$live = $null
$maxAttempts = if ($Exact) { $Attempts } else { 1 }
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $endpoint = "{0}/version.json?t={1}" -f $Url.TrimEnd('/'), [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    try {
        $live = Invoke-RestMethod -Uri $endpoint -TimeoutSec 15 -Headers @{ 'Cache-Control' = 'no-cache' }
        if ($live.version -and $null -ne $live.build -and
            (-not $Exact -or ($live.version -eq $local.version -and [int]$live.build -eq [int]$local.build))) { break }
    } catch {
        if ($attempt -eq $maxAttempts) {
            Write-Error "Version en ligne indisponible sur $Url : $($_.Exception.Message)"
            exit 1
        }
    }
    if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds 3 }
}

if (-not $live.version -or $null -eq $live.build) {
    Write-Error "La reponse de $Url ne contient pas un manifeste de version valide."
    exit 1
}

if ($Exact -and ($live.version -ne $local.version -or [int]$live.build -ne [int]$local.build)) {
    Write-Error "Version en ligne v$($live.version) (build $($live.build)) differente du commit deploye v$($local.version) (build $($local.build))."
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
