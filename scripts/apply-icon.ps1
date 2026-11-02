param(
    [ValidateSet("1", "2", "3")]
    [string]$Concept = "1"
)

$ErrorActionPreference = 'Stop'
$rootDir = (Resolve-Path "$PSScriptRoot\..").Path
$sourceDir = Join-Path $rootDir "wuf-src\icons\proposals\concept$Concept"
$targetDir = Join-Path $rootDir "wuf-src\icons"
$distDir = Join-Path $rootDir "dist\wuf\icons"

if (-not (Test-Path $sourceDir)) {
    throw "Concept directory not found: $sourceDir"
}

Write-Host "Applying Icon Concept $Concept to WUF Translate..."

foreach ($size in @(16, 32, 48, 128)) {
    $src = Join-Path $sourceDir "icon-$size.png"
    Copy-Item -Path $src -Destination (Join-Path $targetDir "icon-$size.png") -Force
    if (Test-Path $distDir) {
        Copy-Item -Path $src -Destination (Join-Path $distDir "icon-$size.png") -Force
    }
}

Copy-Item -Path (Join-Path $sourceDir "icon.svg") -Destination (Join-Path $targetDir "wuf-translate.svg") -Force
if (Test-Path $distDir) {
    Copy-Item -Path (Join-Path $sourceDir "icon.svg") -Destination (Join-Path $distDir "wuf-translate.svg") -Force
}

Write-Host "Successfully applied Concept $Concept! Reload the extension in Chrome/Edge (chrome://extensions) to see the update."
