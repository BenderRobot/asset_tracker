param(
    [Parameter(Mandatory = $true)]
    [string]$CommitMessageFile
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    node scripts/prepare-release.mjs --message-file $CommitMessageFile
    if ($LASTEXITCODE -ne 0) { throw 'Impossible de preparer la version du commit.' }
} finally {
    Pop-Location
}
