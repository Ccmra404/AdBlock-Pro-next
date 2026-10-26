#!/usr/bin/env bash
# Compile a tiny Android framework client without Android API compile stubs.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
: "${D8_JAR:?Set D8_JAR to the pinned Android build-tools 35.0.0 lib/d8.jar}"
test -s "$D8_JAR"
build="$(mktemp -d)"
trap 'rm -rf "$build"' EXIT
mkdir -p "$build/classes" "$build/dex" "$root/bin"
javac --release 8 -Xlint:-options -encoding UTF-8 -d "$build/classes" "$root/tools/app-catalogue/AppCatalogue.java"
jar cf "$build/classes.jar" -C "$build/classes" .
java -cp "$D8_JAR" com.android.tools.r8.D8 --release --min-api 26 --output "$build/dex" "$build/classes.jar"
test -s "$build/dex/classes.dex"
cp "$build/dex/classes.dex" "$root/bin/adblock-apps.dex"
