param(
    [ValidateSet('none', 'major', 'minor', 'patch')]
    [string]$Bump = 'none',
    [switch]$NextCommit
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$versionFile = Join-Path $projectRoot 'version.json'

Push-Location $projectRoot
try {
    git rev-parse --is-inside-work-tree 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Le projet ne se trouve pas dans un depot Git.' }

    # Toujours calculer un bump depuis la version du commit HEAD. Si un commit
    # echoue puis est relance, la meme version est produite au lieu de rebondir.
    $savedErrorPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $headVersionLines = git show HEAD:version.json 2>$null
    $headVersionExit = $LASTEXITCODE
    $ErrorActionPreference = $savedErrorPreference
    if ($headVersionExit -eq 0) {
        $release = (($headVersionLines -join "`n") | ConvertFrom-Json)
    } elseif (Test-Path $versionFile) {
        $release = Get-Content $versionFile -Raw | ConvertFrom-Json
    } else {
        throw 'version.json est introuvable.'
    }

    $major = [int]$release.major
    $minor = [int]$release.minor
    $patch = if ($null -ne $release.patch) { [int]$release.patch } else { 0 }

    switch ($Bump) {
        'major' { $major++; $minor = 0; $patch = 0 }
        'minor' { $minor++; $patch = 0 }
        'patch' { $patch++ }
    }

    $build = [int](git rev-list --count HEAD)
    if ($LASTEXITCODE -ne 0) { throw 'Impossible de compter les commits Git.' }
    if ($NextCommit) { $build++ }

    $version = "$major.$minor.$patch"
    $content = [ordered]@{
        version = $version
        major   = $major
        minor   = $minor
        patch   = $patch
        build   = $build
        source  = 'feature-semver'
    } | ConvertTo-Json
    $content += "`n"

    $current = if (Test-Path $versionFile) { [IO.File]::ReadAllText($versionFile) } else { '' }
    if ($current -ne $content) {
        [IO.File]::WriteAllText($versionFile, $content, [Text.UTF8Encoding]::new($false))
        Write-Host "Version synchronisee : v$version (build $build)" -ForegroundColor Green
    } else {
        Write-Host "Version deja a jour : v$version (build $build)" -ForegroundColor DarkGray
    }

    $version
} finally {
    Pop-Location
}
