#requires -Version 7.0
# Builds libscriptgo.so in a Linux container (Docker) and runs its test suite there.
#
#   pwsh -File sdk/native/build-linux.ps1 [-Image debian:12] [-Sanitize]
#
# The container gets the sources read-only, builds in its own filesystem (not on the mounted
# checkout) and writes only dist/linux-<arch>/. build-linux.sh does the work and can be run
# directly on a Linux machine. Building on an older distribution gives a library that loads on
# more systems: the script prints the newest glibc symbol version the result needs.
param([string]$Image = 'debian:12', [switch]$Sanitize)
$ErrorActionPreference = 'Stop'
$native = $PSScriptRoot
$dist = Join-Path $native 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$steps = @(
  'set -e',
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get update -qq >/dev/null',
  'apt-get install -y -qq --no-install-recommends build-essential cmake pkg-config curl ca-certificates binutils liblua5.4-0 >/dev/null',
  'cp -r /src /work && cd /work',
  'sed -i "s/\r$//" build-linux.sh src/exports.map',
  "SG_BUILD_DIR=/tmp/sg-build SG_DIST_DIR=/dist $(if ($Sanitize) { 'SG_SANITIZE=1 ' })bash ./build-linux.sh"
) -join ' && '
# -Sanitize: the instrumented tests run without ASLR (see build-linux.sh), which Docker's default
# seccomp profile forbids. The container is thrown away and has the sources read-only.
$extra = if ($Sanitize) { @('--security-opt', 'seccomp=unconfined') } else { @() }
docker run --rm @extra -v "${native}:/src:ro" -v "${dist}:/dist" $Image bash -c $steps
if ($LASTEXITCODE -ne 0) { throw "the Linux build failed (exit $LASTEXITCODE)" }
