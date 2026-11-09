#requires -Version 7.0
<#
.SYNOPSIS
  Builds the Lua interpreters used by the SCRIPT//GO test matrix from official sources.

.DESCRIPTION
  Downloads Lua 5.4.8, 5.3.5 and 5.1.5 from lua.org and LuaJIT (v2.1 branch) from GitHub, then
  compiles them with MSVC into tools/runtimes/bin as lua54.exe, lua53.exe, lua51.exe and luajit.exe.
  Lua 5.3.5 is the Lua of BeamMP-Server; it is built without the LUA_COMPAT_* flags, the strictest
  5.3, so code that passes there does not lean on deprecated functions.
  Requires Visual Studio 2022 Build Tools (vcvars64.bat). Linux/macOS CI uses Docker images
  instead (see tools/lua-test.mjs).
#>
param(
  [string]$OutDir = (Join-Path $PSScriptRoot 'runtimes'),
  [string]$Vcvars = 'C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Vcvars)) { throw "vcvars64.bat not found at '$Vcvars'. Pass -Vcvars." }

$src = Join-Path $OutDir 'src'
$bin = Join-Path $OutDir 'bin'
New-Item -ItemType Directory -Force $src, $bin | Out-Null

$sources = @(
  @{ Name = 'lua-5.4.8'; Url = 'https://www.lua.org/ftp/lua-5.4.8.tar.gz'; Sha256 = '4f18ddae154e793e46eeab727c59ef1c0c0c2b744e7b94219710d76f530629ae' },
  @{ Name = 'lua-5.3.5'; Url = 'https://www.lua.org/ftp/lua-5.3.5.tar.gz'; Sha256 = '0c2eed3f960446e1a3e4b9a1ca2f3ff893b6ce41942cf54d5dd59ab4b3b058ac' },
  @{ Name = 'lua-5.1.5'; Url = 'https://www.lua.org/ftp/lua-5.1.5.tar.gz'; Sha256 = '2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333' },
  @{ Name = 'LuaJIT-2.1'; Url = 'https://github.com/LuaJIT/LuaJIT/archive/refs/heads/v2.1.tar.gz'; Sha256 = $null }
)

foreach ($s in $sources) {
  $tgz = Join-Path $src "$($s.Name).tar.gz"
  if (-not (Test-Path $tgz)) {
    Write-Host "download $($s.Url)"
    Invoke-WebRequest $s.Url -OutFile $tgz
  }
  if ($s.Sha256) {
    $actual = (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $s.Sha256) { throw "SHA-256 mismatch for $($s.Name): $actual" }
  }
  $dir = Join-Path $src $s.Name
  if (-not (Test-Path $dir)) {
    tar -xzf $tgz -C $src
  }
}

function Invoke-Msvc([string]$WorkDir, [string]$Commands) {
  $bat = Join-Path $WorkDir '_build.bat'
  # NoDefaultCurrentDirectoryInExePath (set by some agent/CI shells) stops cmd from finding
  # msvcbuild.bat and the minilua/buildvm helpers it runs from the current directory.
  Set-Content -Path $bat -Encoding ascii -Value "@echo off`r`nset NoDefaultCurrentDirectoryInExePath=`r`ncall `"$Vcvars`" >nul`r`ncd /d `"$WorkDir`"`r`n$Commands`r`n"
  & cmd.exe /c $bat
  if ($LASTEXITCODE -ne 0) { throw "MSVC build failed in $WorkDir" }
}

# Lua 5.4.8: every core/lib file except the two front ends.
$l54 = Join-Path $src 'lua-5.4.8\src'
Invoke-Msvc $l54 @'
del /q *.obj 2>nul
cl /nologo /O2 /MT /W0 /DLUA_COMPAT_5_3 /c lapi.c lcode.c lctype.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c lundump.c lvm.c lzio.c lauxlib.c lbaselib.c lcorolib.c ldblib.c liolib.c lmathlib.c loadlib.c loslib.c lstrlib.c ltablib.c lutf8lib.c linit.c lua.c || exit /b 1
link /nologo /OUT:lua54.exe *.obj || exit /b 1
'@
Copy-Item (Join-Path $l54 'lua54.exe') $bin -Force

# Lua 5.3.5 (BeamMP-Server's Lua), strict: no LUA_COMPAT_* flags.
$l53 = Join-Path $src 'lua-5.3.5\src'
Invoke-Msvc $l53 @'
del /q *.obj 2>nul
cl /nologo /O2 /MT /W0 /c lapi.c lcode.c lctype.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c lundump.c lvm.c lzio.c lauxlib.c lbaselib.c lbitlib.c lcorolib.c ldblib.c liolib.c lmathlib.c loadlib.c loslib.c lstrlib.c ltablib.c lutf8lib.c linit.c lua.c || exit /b 1
link /nologo /OUT:lua53.exe *.obj || exit /b 1
'@
Copy-Item (Join-Path $l53 'lua53.exe') $bin -Force

# Lua 5.1.5.
$l51 = Join-Path $src 'lua-5.1.5\src'
Invoke-Msvc $l51 @'
del /q *.obj 2>nul
cl /nologo /O2 /MT /W0 /c lapi.c lcode.c ldebug.c ldo.c ldump.c lfunc.c lgc.c llex.c lmem.c lobject.c lopcodes.c lparser.c lstate.c lstring.c ltable.c ltm.c lundump.c lvm.c lzio.c lauxlib.c lbaselib.c ldblib.c liolib.c lmathlib.c loadlib.c loslib.c lstrlib.c ltablib.c linit.c lua.c || exit /b 1
link /nologo /OUT:lua51.exe *.obj || exit /b 1
'@
Copy-Item (Join-Path $l51 'lua51.exe') $bin -Force

# LuaJIT 2.1 (static build).
$lj = Join-Path $src 'LuaJIT-2.1\src'
Invoke-Msvc $lj 'call msvcbuild.bat static || exit /b 1'
Copy-Item (Join-Path $lj 'luajit.exe') $bin -Force

foreach ($exe in 'lua54.exe', 'lua53.exe', 'lua51.exe', 'luajit.exe') {
  $path = Join-Path $bin $exe
  $v = & $path -v 2>&1
  Write-Host ("{0,-11} {1}" -f $exe, ($v | Select-Object -First 1))
}
