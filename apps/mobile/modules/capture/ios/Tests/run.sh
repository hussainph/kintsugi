#!/bin/sh
# Compiles ios/Shared with the standalone tests (Swift 5 language mode, as the
# share extension builds it) and runs them on the Mac. Build output and
# scratch directories live in apps/mobile/.expo/capture-tests (gitignored).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
base="$here/../../../../.expo/capture-tests"
out="$base/run-$$" # one directory per run, so concurrent runs don't collide
mkdir -p "$out/scratch"
trap 'rm -rf "$out"; rmdir "$base" 2>/dev/null || true' EXIT
xcrun swiftc -swift-version 5 -O -module-cache-path "$out/module-cache" \
  -o "$out/capture-tests" "$here"/../Shared/*.swift "$here/main.swift"
CAPTURE_TEST_DIR="$out/scratch" "$out/capture-tests"
