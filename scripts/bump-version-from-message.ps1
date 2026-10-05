param(
    [Parameter(Mandatory = $true)]
    [string]$CommitMessageFile
)

$ErrorActionPreference = 'Stop'
$message = Get-Content -LiteralPath $CommitMessageFile -Raw
$subject = ($message -split "`r?`n", 2)[0].Trim()

$bump = if ($message -match '(?im)^BREAKING CHANGE\s*:' -or $subject -match '^[a-z]+(?:\([^)]*\))?!:') {
    'major'
} elseif ($subject -match '(?i)^(feat|feature)(?:\([^)]*\))?\s*:' -or
          $subject -match '(?i)^new features?\b') {
    'minor'
} else {
    # fix:, audit, docs, refactor et tout autre changement livrable avancent
    # le patch : aucun commit publie ne conserve exactement la meme version.
    'patch'
}

& (Join-Path $PSScriptRoot 'sync-version.ps1') -Bump $bump -NextCommit | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$release = Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) 'version.json') -Raw | ConvertFrom-Json
Write-Host "Commit '$subject' -> $bump -> v$($release.version) (build $($release.build))" -ForegroundColor Green
