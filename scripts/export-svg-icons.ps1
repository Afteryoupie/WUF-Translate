$ErrorActionPreference = 'Stop'
$edgePath = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path $edgePath)) {
    throw "Edge executable not found at $edgePath"
}

$proposalsDir = "C:\LLM_Project\WUF-Translate\wuf-src\icons\proposals"
$concepts = @(
    @{ Name = "concept1"; SvgFile = "$proposalsDir\concept1-speech-collie.svg"; OutDir = "$proposalsDir\concept1" },
    @{ Name = "concept2"; SvgFile = "$proposalsDir\concept2-audio-collie.svg"; OutDir = "$proposalsDir\concept2" },
    @{ Name = "concept3"; SvgFile = "$proposalsDir\concept3-monogram-w.svg"; OutDir = "$proposalsDir\concept3" }
)

$sizes = @(16, 32, 48, 128, 256)

foreach ($c in $concepts) {
    Write-Host "Rendering $($c.Name)..."
    $svgContent = [System.IO.File]::ReadAllText($c.SvgFile)
    
    # Copy SVG directly to the concept folder for clean distribution
    Copy-Item -Path $c.SvgFile -Destination "$($c.OutDir)\icon.svg" -Force

    foreach ($s in $sizes) {
        $htmlFile = "$($c.OutDir)\temp_$s.html"
        $outFile = "$($c.OutDir)\icon-$s.png"
        
        $html = @"
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${s}px; height: ${s}px; overflow: hidden; background: transparent; }
  svg { width: ${s}px; height: ${s}px; display: block; }
</style>
</head>
<body>
$svgContent
</body>
</html>
"@
        [System.IO.File]::WriteAllText($htmlFile, $html, [System.Text.Encoding]::UTF8)

        $args = @(
            "--headless=new",
            "--disable-gpu",
            "--force-device-scale-factor=1",
            "--window-size=$s,$s",
            "--default-background-color=00000000",
            "--screenshot=$outFile",
            "file:///$($htmlFile.Replace('\', '/'))"
        )

        Start-Process -FilePath $edgePath -ArgumentList $args -Wait
        Remove-Item $htmlFile -Force
    }
}

Write-Host "All icons exported successfully!"
