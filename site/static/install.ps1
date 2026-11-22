# Install Crewreview on Windows:
#   irm https://crewreview.pururucos.com.br/install.ps1 | iex
# Options: $env:CREWREVIEW_VERSION = "0.2.0" (default: latest)
$ErrorActionPreference = "Stop"
$repo = "Quost/crewreview"
$version = if ($env:CREWREVIEW_VERSION) { $env:CREWREVIEW_VERSION } else { "latest" }
$asset = "crewreview-windows-x64.exe"
if ($version -eq "latest") { $base = "https://github.com/$repo/releases/latest/download" }
else { $base = "https://github.com/$repo/releases/download/v$($version.TrimStart('v'))" }

$dir = Join-Path $env:LOCALAPPDATA "Crewreview\bin"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("crewreview-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "Downloading $asset ($version)..."
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile (Join-Path $tmp "SHA256SUMS")
  $line = Get-Content (Join-Path $tmp "SHA256SUMS") | Where-Object { ($_ -split '\s+')[1] -eq $asset }
  if (-not $line) { throw "$asset is not listed in SHA256SUMS" }
  $expected = ($line -split '\s+')[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLower()
  if ($expected -ne $actual) { throw "checksum mismatch for $asset" }
  Move-Item -Force (Join-Path $tmp $asset) (Join-Path $dir "crewreview.exe")
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ';' | Where-Object { $_ -eq $dir })) {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$dir", "User")
  Write-Host "Added $dir to your PATH (open a new terminal)."
}
Write-Host "Installed $(& (Join-Path $dir 'crewreview.exe') --version) to $dir\crewreview.exe"
Write-Host "Next: crewreview doctor"
