#!/usr/bin/env bash
# Builds libscriptgo.so on Linux (x86-64 or arm64) and runs its test suite.
#
#   ./build-linux.sh                 from sdk/native, on a Linux box or in a container
#   SG_SANITIZE=1 ./build-linux.sh   AddressSanitizer + UBSan: runs the tests, packages nothing
#
# Needs: a C compiler, make, cmake >= 3.21, pkg-config, curl (or wget), tar. For the Lua load test,
# a Lua 5.4 shared library: pass SG_TEST_LUA_LIBRARY=/path/to/liblua5.4.so.0, or install the
# distribution's package (Debian: liblua5.4-0) and the script finds it.
#
# libsodium is built here from its release tarball, pinned by SHA-256, as a static PIC archive.
# Distribution packages are often older than the 1.0.19 this library needs, and a static link is
# the point: a libsodium.so dropped next to the host could otherwise observe keys.
#
# Output: dist/linux-<arch>/libscriptgo.so, the header and the third-party notices. The library
# depends on libc only (and libpthread/libm where the toolchain keeps them separate).
set -euo pipefail

SODIUM_VERSION="1.0.22"
SODIUM_SHA256="adbdd8f16149e81ac6078a03aca6fc03b592b89ef7b5ed83841c086191be3349"
SODIUM_URL="https://github.com/jedisct1/libsodium/releases/download/${SODIUM_VERSION}-RELEASE/libsodium-${SODIUM_VERSION}.tar.gz"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A build tree outside the source folder keeps a mounted (Windows) checkout clean and fast.
work="${SG_BUILD_DIR:-$here/.build-linux}"
deps="$work/deps"
prefix="$deps/sodium"
case "$(uname -m)" in
  x86_64) arch="x64" ;;
  aarch64 | arm64) arch="arm64" ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 2 ;;
esac
dist="${SG_DIST_DIR:-$here/dist}/linux-$arch"
mkdir -p "$deps" "$dist"

echo "==> libsodium $SODIUM_VERSION (static, PIC)"
if [ ! -f "$prefix/lib/libsodium.a" ]; then
  tarball="$deps/libsodium-$SODIUM_VERSION.tar.gz"
  if [ ! -f "$tarball" ]; then
    if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$tarball" "$SODIUM_URL"; else wget -q -O "$tarball" "$SODIUM_URL"; fi
  fi
  actual="$(sha256sum "$tarball" | cut -d' ' -f1)"
  if [ "$actual" != "$SODIUM_SHA256" ]; then
    rm -f "$tarball"
    echo "libsodium archive SHA-256 mismatch: expected $SODIUM_SHA256, got $actual. The file was deleted; nothing was built." >&2
    exit 1
  fi
  rm -rf "$deps/src" && mkdir -p "$deps/src"
  tar -xzf "$tarball" -C "$deps/src" --strip-components=1
  (cd "$deps/src" && ./configure --prefix="$prefix" --disable-shared --enable-static --with-pic --disable-dependency-tracking >/dev/null && make -j"$(nproc)" >/dev/null && make install >/dev/null)
fi
echo "    $(ls -l "$prefix/lib/libsodium.a" | awk '{print $5}') bytes"

lua="${SG_TEST_LUA_LIBRARY:-}"
if [ -z "$lua" ]; then
  lua="$(ls /usr/lib/*/liblua5.4.so.0 /usr/lib/*/liblua5.4.so /usr/lib64/liblua-5.4.so /usr/lib/liblua5.4.so 2>/dev/null | head -n 1 || true)"
fi
if [ -n "$lua" ]; then echo "==> Lua for the load test: $lua"; else echo "==> no Lua 5.4 library found: the Lua load test will report it"; fi

sanitize="${SG_SANITIZE:-}"
tree="$work/cmake${sanitize:+-sanitize}"
echo "==> configure and build${sanitize:+ (AddressSanitizer + UBSan)}"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
cmake -S "$here" -B "$tree" -DCMAKE_BUILD_TYPE=Release -DSG_BUILD_TESTS=ON ${sanitize:+-DSG_SANITIZE=ON} ${lua:+-DSG_TEST_LUA_LIBRARY="$lua"} >/dev/null
cmake --build "$tree" -j"$(nproc)"

echo "==> tests"
# AddressSanitizer of older compilers (GCC 12, Debian 12) loops on "DEADLYSIGNAL" when the kernel
# randomises mappings over more than 28 bits. Running the instrumented tests without ASLR avoids it;
# in Docker that needs --security-opt seccomp=unconfined (build-linux.ps1 -Sanitize passes it).
run=()
if [ -n "$sanitize" ] && command -v setarch >/dev/null 2>&1 && setarch "$(uname -m)" -R true 2>/dev/null; then run=(setarch "$(uname -m)" -R); fi
"${run[@]}" ctest --test-dir "$tree" --output-on-failure --timeout 600
if [ -n "$sanitize" ]; then echo "==> sanitizer run done: nothing is packaged from an instrumented build"; exit 0; fi

echo "==> inspect the library"
so="$(find "$tree" -maxdepth 2 -name 'libscriptgo.so' | head -n 1)"
# Functions only (type T): the version node of exports.map is an absolute symbol, not an export.
exports="$(nm -D --defined-only "$so" | awk '$2 == "T" {print $3}' | sed 's/@.*//' | sort -u)"
count="$(printf '%s\n' "$exports" | wc -l)"
foreign="$(printf '%s\n' "$exports" | grep -v '^sg_' || true)"
echo "    exports: $count$( [ -z "$foreign" ] && echo ', all sg_*' )"
if [ -n "$foreign" ]; then echo "    NOT sg_*: $foreign" >&2; exit 1; fi
echo "    needs: $(readelf -d "$so" | awk '/NEEDED/ {gsub(/[\[\]]/, "", $5); printf "%s ", $5}')"
if readelf -d "$so" | grep -q 'libsodium'; then echo "libsodium is linked dynamically: refusing to package." >&2; exit 1; fi

cp "$so" "$dist/libscriptgo.so"
strip --strip-unneeded "$dist/libscriptgo.so"
mkdir -p "$dist/include/scriptgo"
cp "$here/include/scriptgo/escrow.h" "$dist/include/scriptgo/escrow.h"
cp "$here/THIRD-PARTY-NOTICES.txt" "$dist/THIRD-PARTY-NOTICES.txt"
echo "==> package -> $dist"
echo "libscriptgo.so  $(stat -c %s "$dist/libscriptgo.so") bytes"
echo "SHA-256         $(sha256sum "$dist/libscriptgo.so" | cut -d' ' -f1)"
echo "glibc needed    $(objdump -T "$dist/libscriptgo.so" | grep -o 'GLIBC_[0-9.]*' | sort -V | tail -n 1)"
