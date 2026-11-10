#requires -Version 7.0
<#
.SYNOPSIS
  Packs ScriptGo.Escrow and ScriptGo.Host into sdk/dotnet/artifacts/ (gitignored).

.DESCRIPTION
  ScriptGo.Escrow carries the native escrow loader under runtimes/<rid>/native/. This script
  refuses to pack when sdk/native/dist/win-x64/scriptgo.dll is missing (run sdk/native/build.ps1
  first), because a package without it would fail closed on every host. It then checks that the
  library really is inside the package and prints its SHA-256.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File sdk/dotnet/pack.ps1
#>
[CmdletBinding()]
param([string]$Configuration = 'Release')

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = $PSScriptRoot
$Artifacts = Join-Path $Root 'artifacts'
$NativeDll = Join-Path $Root '..\native\dist\win-x64\scriptgo.dll'

if (-not (Test-Path -LiteralPath $NativeDll)) {
    throw 'sdk/native/dist/win-x64/scriptgo.dll is missing: build it first with sdk/native/build.ps1.'
}
$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue)?.Source
if (-not $dotnet) { $dotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe' }
if (-not (Test-Path -LiteralPath $dotnet)) { throw 'the .NET SDK (dotnet) was not found.' }

if (Test-Path -LiteralPath $Artifacts) { Remove-Item -LiteralPath $Artifacts -Recurse -Force }
foreach ($project in 'ScriptGo.Escrow', 'ScriptGo.Host') {
    Write-Host "==> pack $project" -ForegroundColor Cyan
    & $dotnet pack (Join-Path $Root $project) -c $Configuration -o $Artifacts --nologo -v quiet
    if ($LASTEXITCODE -ne 0) { throw "dotnet pack $project failed ($LASTEXITCODE)" }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$expected = (Get-FileHash -LiteralPath $NativeDll -Algorithm SHA256).Hash.ToLowerInvariant()
foreach ($package in Get-ChildItem -LiteralPath $Artifacts -Filter '*.nupkg') {
    $zip = [IO.Compression.ZipFile]::OpenRead($package.FullName)
    try {
        Write-Host ''
        Write-Host "$($package.Name)  $($package.Length) bytes"
        $zip.Entries | Where-Object { $_.FullName -notmatch '^(_rels|package)/|\[Content_Types\]' } |
            ForEach-Object { Write-Host ('  {0,9}  {1}' -f $_.Length, $_.FullName) }
        if ($package.Name -like 'ScriptGo.Escrow.*') {
            $entry = $zip.GetEntry('runtimes/win-x64/native/scriptgo.dll')
            if (-not $entry) { throw 'ScriptGo.Escrow was packed without runtimes/win-x64/native/scriptgo.dll.' }
            $stream = $entry.Open()
            try { $actual = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
            finally { $stream.Dispose() }
            if ($actual -ne $expected) { throw "the packed scriptgo.dll ($actual) is not the built one ($expected)." }
            Write-Host "  native library SHA-256 $actual (matches sdk/native/dist/win-x64)"
        }
    } finally { $zip.Dispose() }
}
