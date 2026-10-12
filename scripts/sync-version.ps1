param(
    [ValidateSet('none', 'major', 'minor', 'patch')]
    [string]$Bump = 'none',
    [switch]$NextCommit
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    if ($Bump -eq 'none') {
        # A read-only check must never reset a release already staged or live.
        node scripts/prepare-release.mjs --check
    } else {
        $message = switch ($Bump) {
            'major' { 'feat!: manual release' }
            'minor' { 'feat: manual release' }
            'patch' { 'fix: manual release' }
        }
        node scripts/prepare-release.mjs --message $message
    }
    if ($LASTEXITCODE -ne 0) { throw 'Impossible de verifier ou preparer la version.' }
} finally {
    Pop-Location
}
