#requires -Version 7.0
<#
.SYNOPSIS
  Builds libscriptgo for Windows x64 and runs its tests.

.DESCRIPTION
  1. Fetches the official prebuilt libsodium MSVC package into .deps/ (gitignored) and refuses it
     unless its SHA-256 is the pinned one.
  2. Configures and builds with CMake and Visual Studio 2022 (MSVC v143), Release, static C runtime,
     static libsodium.
  3. Runs the CTest suite, including the Lua load test against the lua54.dll of the KeraLua NuGet
     package when it is in the NuGet cache.
  4. Checks the DLL: only sg_* exports, ASLR / DEP / CFG flags set, no debug symbols next to it.
  5. Copies scriptgo.dll, scriptgo.lib, the header and the third-party notices to dist/win-x64/
     (gitignored) and prints the DLL's size and SHA-256.

.PARAMETER SkipTests
  Build and package without running CTest.

.PARAMETER LuaLibrary
  A Lua 5.4 shared library for the Lua load test. Default: KeraLua 1.4.9's lua54.dll from the NuGet cache.

.PARAMETER AgentShell
  Apply the MSBuild workarounds a non-interactive shell needs (no node reuse, no file tracker).
  Applied automatically when SystemDrive is missing from the environment.

.PARAMETER Clean
  Delete the build tree first.

.EXAMPLE
  pwsh -ExecutionPolicy Bypass -File sdk/native/build.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipTests,
    [string]$LuaLibrary,
    [switch]$AgentShell,
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Pinned dependency. Change the version and the hash together, after checking the new archive
# against the digest GitHub publishes for the release asset (and the minisign signature).
$SodiumVersion = '1.0.22'
$SodiumArchive = "libsodium-$SodiumVersion-msvc.zip"
$SodiumUrl = "https://github.com/jedisct1/libsodium/releases/download/$SodiumVersion-RELEASE/$SodiumArchive"
$SodiumSha256 = '3e03a726fac4bc09cb61d8f29d658ef7a5eca0811de59082130414f7ca2e4279'

$Root = $PSScriptRoot
$Deps = Join-Path $Root '.deps'
$BuildDir = Join-Path $Root 'build\vs2022-x64'
$DistDir = Join-Path $Root 'dist\win-x64'

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Find-VsTool([string]$Pattern) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { return $null }
    $found = & $vswhere -latest -products * -find $Pattern 2>$null | Select-Object -First 1
    if ($found -and (Test-Path -LiteralPath $found)) { return $found }
    return $null
}

# ------------------------------------------------------------------------------------------ libsodium
Write-Step "libsodium $SodiumVersion (prebuilt MSVC package, static library)"
New-Item -ItemType Directory -Force -Path $Deps | Out-Null
$archivePath = Join-Path $Deps $SodiumArchive
if (-not (Test-Path -LiteralPath $archivePath)) {
    Write-Host "    downloading $SodiumUrl"
    $previous = $ProgressPreference
    $ProgressPreference = 'SilentlyContinue'
    try { Invoke-WebRequest -Uri $SodiumUrl -OutFile $archivePath -UserAgent 'libscriptgo-build' }
    finally { $ProgressPreference = $previous }
}
$actual = Get-Sha256 $archivePath
if ($actual -ne $SodiumSha256) {
    Remove-Item -LiteralPath $archivePath -Force
    throw "libsodium archive SHA-256 mismatch: expected $SodiumSha256, got $actual. The file was deleted; nothing was built."
}
Write-Host "    SHA-256 ok: $actual"
$sodiumExtract = Join-Path $Deps "libsodium-$SodiumVersion-msvc"
$sodiumRoot = Join-Path $sodiumExtract 'libsodium'
if (-not (Test-Path -LiteralPath (Join-Path $sodiumRoot 'include\sodium.h'))) {
    if (Test-Path -LiteralPath $sodiumExtract) { Remove-Item -LiteralPath $sodiumExtract -Recurse -Force }
    Expand-Archive -LiteralPath $archivePath -DestinationPath $sodiumExtract
}
# Keep only what the build needs (the package is about 400 MB extracted).
Get-ChildItem -LiteralPath $sodiumRoot -Directory | Where-Object { $_.Name -notin 'include', 'x64' } | Remove-Item -Recurse -Force
foreach ($configuration in Get-ChildItem -LiteralPath (Join-Path $sodiumRoot 'x64') -Directory) {
    Get-ChildItem -LiteralPath $configuration.FullName -Directory | Where-Object Name -ne 'v143' | Remove-Item -Recurse -Force
    $toolset = Join-Path $configuration.FullName 'v143'
    if (Test-Path -LiteralPath $toolset) {
        Get-ChildItem -LiteralPath $toolset -Directory | Where-Object Name -ne 'static' | Remove-Item -Recurse -Force
    }
}

# ---------------------------------------------------------------------------------------------- tools
$cmake = (Get-Command cmake -ErrorAction SilentlyContinue)?.Source
if (-not $cmake) { $cmake = Find-VsTool 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' }
if (-not $cmake) { throw 'cmake was not found (install the "C++ CMake tools for Windows" component of Visual Studio 2022).' }
$ctest = Join-Path (Split-Path $cmake) 'ctest.exe'

if (-not $LuaLibrary) {
    $nuget = if ($env:NUGET_PACKAGES) { $env:NUGET_PACKAGES } else { Join-Path $HOME '.nuget\packages' }
    $candidate = Join-Path $nuget 'keralua\1.4.9\runtimes\win-x64\native\lua54.dll'
    if (Test-Path -LiteralPath $candidate) { $LuaLibrary = $candidate }
}

# MSBuild from a non-interactive shell: the file tracker needs these two variables, and a reused
# node from an earlier build can hang the next one.
$msbuildArgs = @()
if ($AgentShell -or -not $env:SystemDrive) {
    if (-not $env:SystemDrive) { $env:SystemDrive = 'C:' }
    if (-not $env:ALLUSERSPROFILE) { $env:ALLUSERSPROFILE = 'C:\ProgramData' }
    $msbuildArgs = @('--', '/nodeReuse:false', '/p:TrackFileAccess=false')
}

# -------------------------------------------------------------------------------------------- build
if ($Clean -and (Test-Path -LiteralPath $BuildDir)) { Remove-Item -LiteralPath $BuildDir -Recurse -Force }

Write-Step 'configure (Visual Studio 17 2022, x64)'
$configure = @('-S', $Root, '-B', $BuildDir, '-G', 'Visual Studio 17 2022', '-A', 'x64', "-DSG_SODIUM_ROOT=$($sodiumRoot -replace '\\', '/')")
if ($LuaLibrary) { $configure += "-DSG_TEST_LUA_LIBRARY=$($LuaLibrary -replace '\\', '/')" } else { $configure += '-DSG_TEST_LUA_LIBRARY=' }
& $cmake @configure
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed ($LASTEXITCODE)" }

Write-Step 'build (Release)'
& $cmake --build $BuildDir --config Release @msbuildArgs
if ($LASTEXITCODE -ne 0) { throw "cmake build failed ($LASTEXITCODE)" }

$dll = Join-Path $BuildDir 'bin\Release\scriptgo.dll'
$lib = Join-Path $BuildDir 'lib\Release\scriptgo.lib'
if (-not (Test-Path -LiteralPath $dll)) { throw "the build did not produce $dll" }

if (-not $SkipTests) {
    Write-Step 'test (CTest)'
    if (-not $LuaLibrary) { Write-Warning 'no Lua 5.4 library found: the Lua load test will be skipped (pass -LuaLibrary).' }
    & $ctest --test-dir $BuildDir -C Release --output-on-failure
    if ($LASTEXITCODE -ne 0) { throw "ctest failed ($LASTEXITCODE)" }
}

# --------------------------------------------------------------------------------------- inspection
Write-Step 'inspect the DLL'
$dumpbin = Find-VsTool 'VC\Tools\MSVC\**\bin\Hostx64\x64\dumpbin.exe'
if ($dumpbin) {
    $exports = & $dumpbin /nologo /exports $dll | ForEach-Object { if ($_ -match '^\s+\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]+\s+(\S+)') { $Matches[1] } }
    $foreign = @($exports | Where-Object { $_ -notmatch '^sg_' })
    if (@($exports).Count -eq 0) { throw 'dumpbin listed no exports' }
    if ($foreign.Count -gt 0) { throw "the DLL exports symbols outside the sg_* ABI: $($foreign -join ', ')" }
    Write-Host "    exports: $(@($exports).Count), all sg_*"

    $headers = (& $dumpbin /nologo /headers $dll) -join "`n"
    foreach ($flag in 'Dynamic base', 'NX compatible', 'High Entropy Virtual Addresses', 'Control Flow Guard') {
        if ($headers -notmatch [regex]::Escape($flag)) { throw "the DLL is missing the '$flag' characteristic" }
    }
    Write-Host '    characteristics: ASLR (high entropy), DEP, Control Flow Guard'
    $imports = & $dumpbin /nologo /dependents $dll | Where-Object { $_ -match '^\s+\S+\.dll\s*$' } | ForEach-Object { $_.Trim() }
    if ($imports | Where-Object { $_ -match 'sodium|vcruntime|msvcp|ucrtbase' }) { throw "unexpected dynamic dependency: $($imports -join ', ')" }
    Write-Host "    imports: $($imports -join ', ')"
} else {
    Write-Warning 'dumpbin was not found: exports and PE flags were not checked.'
}
if (Test-Path -LiteralPath ([IO.Path]::ChangeExtension($dll, '.pdb'))) { throw 'a PDB was produced next to the DLL; debug symbols must not ship.' }

# ---------------------------------------------------------------------------------------- packaging
Write-Step "package -> $DistDir"
if (Test-Path -LiteralPath $DistDir) { Remove-Item -LiteralPath $DistDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $DistDir 'include\scriptgo') | Out-Null
Copy-Item -LiteralPath $dll -Destination $DistDir
Copy-Item -LiteralPath $lib -Destination $DistDir
Copy-Item -LiteralPath (Join-Path $Root 'include\scriptgo\escrow.h') -Destination (Join-Path $DistDir 'include\scriptgo')
Copy-Item -LiteralPath (Join-Path $Root 'THIRD-PARTY-NOTICES.txt') -Destination $DistDir

$shipped = Join-Path $DistDir 'scriptgo.dll'
Write-Host ''
Write-Host "scriptgo.dll  $((Get-Item -LiteralPath $shipped).Length) bytes"
Write-Host "SHA-256       $(Get-Sha256 $shipped)"
