#requires -Version 5.1
<#
.SYNOPSIS
  Prepares the SCRIPT//GO Godot demo: copies the lua-gdextension addon and the SCRIPT//GO host
  script into the project, then imports the project once so Godot registers the GDExtension.

.DESCRIPTION
  Nothing copied here is committed (see .gitignore): the addon binaries are third-party, and
  addons/scriptgo/ holds copies of sdk/adapters/godot/scriptgo_host.gd and scriptgo_watchdog.gd.
  Re-run this script after changing those files. The Lua side (core, adapter, runtime glue) is
  read from the repository's sdk/ folder at run time and needs no copy.

  Expected downloads (see sdk/adapters/godot/README.md), each extracted in its own folder:
    tools/runtimes/godot/lua-gdextension-0.7.0/addons/lua-gdextension   (lua-gdextension.zip 0.7.0, Lua 5.4)
    tools/runtimes/godot/godot-4.5.2-stable/Godot_v4.5.2-stable_win64_console.exe

.PARAMETER AddonDir
  The lua-gdextension addon folder to copy (the one holding luagdextension.gdextension).

.PARAMETER Godot
  The Godot 4.5 executable used for the one-time import. Skipped with -NoImport.
#>
param(
    [string]$AddonDir,
    [string]$Godot,
    [switch]$NoImport
)
$ErrorActionPreference = 'Stop'

$project = $PSScriptRoot
$repo = (Resolve-Path (Join-Path $project '..\..\..')).Path
$runtimes = Join-Path $repo 'tools\runtimes\godot'
if (-not $AddonDir) { $AddonDir = Join-Path $runtimes 'lua-gdextension-0.7.0\addons\lua-gdextension' }
if (-not $Godot) { $Godot = Join-Path $runtimes 'godot-4.5.2-stable\Godot_v4.5.2-stable_win64_console.exe' }

if (-not (Test-Path (Join-Path $AddonDir 'luagdextension.gdextension'))) {
    throw "lua-gdextension addon not found in '$AddonDir'. Download lua-gdextension.zip 0.7.0 from https://github.com/gilzoide/lua-gdextension/releases/tag/0.7.0 and extract it to tools/runtimes/godot/lua-gdextension-0.7.0 (or pass -AddonDir)."
}

# 1. The bridge addon.
$addons = Join-Path $project 'addons'
$target = Join-Path $addons 'lua-gdextension'
if (Test-Path $target) { Remove-Item -Recurse -Force $target }
New-Item -ItemType Directory -Force $addons | Out-Null
Copy-Item -Recurse $AddonDir $target
$version = (Select-String -Path (Join-Path $target 'plugin.cfg') -Pattern '^version="(.+)"').Matches[0].Groups[1].Value
Write-Host "lua-gdextension $version -> addons/lua-gdextension"

# 2. The SCRIPT//GO host node (autoload ScriptGoHost) and the verify watchdog (ScriptGoWatchdog).
$sg = Join-Path $addons 'scriptgo'
New-Item -ItemType Directory -Force $sg | Out-Null
foreach ($file in 'scriptgo_host.gd', 'scriptgo_watchdog.gd') {
    Copy-Item -Force (Join-Path $repo "sdk\adapters\godot\$file") (Join-Path $sg $file)
    Write-Host "sdk/adapters/godot/$file -> addons/scriptgo/$file"
}

# 3. One import, so .godot/extension_list.cfg lists the GDExtension (a plain run does not scan).
if ($NoImport) { return }
if (-not (Test-Path $Godot)) { throw "Godot not found at '$Godot' (pass -Godot or -NoImport)." }
$list = Join-Path $project '.godot\extension_list.cfg'
for ($attempt = 1; $attempt -le 2; $attempt++) {
    & $Godot --headless --import --path $project 2>&1 | Out-Null
    if ((Test-Path $list) -and (Select-String -Path $list -Pattern 'luagdextension' -Quiet)) { break }
}
if (-not ((Test-Path $list) -and (Select-String -Path $list -Pattern 'luagdextension' -Quiet))) {
    throw 'Godot did not register the GDExtension (.godot/extension_list.cfg). Open the project in the editor once.'
}
Write-Host 'project imported; GDExtension registered'
