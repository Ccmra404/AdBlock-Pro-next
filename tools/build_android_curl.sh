#!/usr/bin/env bash
set -euo pipefail

curl_version=8.23.0
openssl_version=3.5.9
curl_sha=8dadd7d2536a314f982ad05a651b713f426bf7d02cc2c76cffb9796f2218e6c5
openssl_sha=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a

: "${ANDROID_NDK_ROOT:?ANDROID_NDK_ROOT must point to the Android NDK}"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/src" "$root/openssl" "$root/curl" "$GITHUB_WORKSPACE/bin"
cd "$root/src"

curl -fL --retry 3 "https://curl.se/download/curl-$curl_version.tar.xz" -o curl.tar.xz
curl -fL --retry 3 "https://github.com/openssl/openssl/releases/download/openssl-$openssl_version/openssl-$openssl_version.tar.gz" -o openssl.tar.gz
echo "$curl_sha  curl.tar.xz" | sha256sum -c -
echo "$openssl_sha  openssl.tar.gz" | sha256sum -c -
tar -xf curl.tar.xz
tar -xf openssl.tar.gz

toolchain="$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin"
export PATH="$toolchain:$PATH"
export ANDROID_NDK_ROOT
export CFLAGS="-fPIC -O2"
export LDFLAGS="-Wl,-z,max-page-size=16384"

cd "$root/src/openssl-$openssl_version"
./Configure android-arm64 -D__ANDROID_API__=23 -Wl,-z,max-page-size=16384 no-shared no-tests --prefix="$root/openssl"
make -j"$(nproc)"
make install_sw

cd "$root/src/curl-$curl_version"
CC=aarch64-linux-android23-clang \
  ./configure --host=aarch64-linux-android --with-openssl="$root/openssl" \
    --with-ca-path=/system/etc/security/cacerts --disable-shared --enable-static \
    --disable-ftp --disable-file --disable-ldap --disable-ldaps --disable-rtsp \
    --disable-dict --disable-telnet --disable-tftp --disable-pop3 --disable-imap \
    --disable-smb --disable-smtp --disable-gopher --disable-mqtt \
    --without-zlib --without-brotli --without-zstd --without-libpsl --without-nghttp2
make -j"$(nproc)"
install -m 755 src/curl "$GITHUB_WORKSPACE/bin/curl"
file "$GITHUB_WORKSPACE/bin/curl"
readelf -h "$GITHUB_WORKSPACE/bin/curl" | grep -q 'Machine:.*AArch64'
