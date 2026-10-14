#!/usr/bin/env bash
# Puts the two native libraries into app/src/main/jniLibs/arm64-v8a/.
#
# Neither is committed. libnode.so is 60 MB and comes from the nodejs-mobile release (Node 18 — the
# newest nodejs-mobile ships, and the reason the app cannot use the game's own tools/setup.mjs, which
# wants Node 22). libc++_shared.so is copied out of the Android NDK the runner already has: libnode
# links against it, nodejs-mobile does not ship it, and without it the app dies at startup with
# `dlopen failed: library "libc++_shared.so" not found`.
set -euo pipefail

NJM_VERSION="${NJM_VERSION:-v18.20.4}"
ABI="${ABI:-arm64-v8a}"

ANDROID_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ANDROID_DIR/app/src/main/jniLibs/$ABI"
mkdir -p "$DEST"

if [ ! -f "$DEST/libnode.so" ]; then
  url="https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${NJM_VERSION}/nodejs-mobile-${NJM_VERSION}-android.zip"
  tmp="$(mktemp -d)"
  echo "==> downloading $url"
  curl -fL --retry 5 --retry-delay 3 -o "$tmp/njm.zip" "$url"
  unzip -q -o "$tmp/njm.zip" -d "$tmp/njm"
  src="$(find "$tmp/njm" -path "*/bin/$ABI/libnode.so" | head -n1 || true)"
  if [ -z "$src" ]; then
    echo "!! no libnode.so for $ABI in the nodejs-mobile package" >&2
    find "$tmp/njm" -name 'libnode.so' >&2 || true
    exit 1
  fi
  cp "$src" "$DEST/libnode.so"
  rm -rf "$tmp"
fi
ls -lh "$DEST/libnode.so"

if [ ! -f "$DEST/libc++_shared.so" ]; then
  sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/usr/local/lib/android/sdk}}"
  src="$(find "$sdk/ndk" -path '*/sysroot/usr/lib/aarch64-linux-android/libc++_shared.so' 2>/dev/null | sort | tail -n1 || true)"
  if [ -z "$src" ]; then
    echo "!! no libc++_shared.so under $sdk/ndk — is the NDK installed on this runner?" >&2
    exit 1
  fi
  cp "$src" "$DEST/libc++_shared.so"
fi
ls -lh "$DEST/libc++_shared.so"
