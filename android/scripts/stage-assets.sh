#!/usr/bin/env bash
# Stages everything the APK carries:
#
#   assets/game/   the upstream **lite** release — code, runtime dependencies, front-end libs, data.
#                  The art and audio are stripped: those are fetched on the phone at first launch.
#   assets/mod/    this repo's own files (src/ + public/) — the panel and the server patch.
#
# The game version here is the version the APK is built against, and it must match
# EXPECTED_GAME_VERSION in src/launcher.mjs (the launcher warns when it does not) and GAME_VERSION in
# android/app/src/main/java/com/strongholdluck/android/GamePack.kt (which picks the release to download).
set -euo pipefail

GAME_VERSION="${GAME_VERSION:-0.2.6}"

ANDROID_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$ANDROID_DIR/.." && pwd)"
ASSETS="$ANDROID_DIR/app/src/main/assets"

ZIP="Stronghold-Protocol-v${GAME_VERSION}-lite.zip"
URL="https://github.com/sganggs/Stronghold-Protocol/releases/download/v${GAME_VERSION}/${ZIP}"

rm -rf "$ASSETS/game" "$ASSETS/mod"
mkdir -p "$ASSETS"

tmp="$(mktemp -d)"
echo "==> downloading $URL"
curl -fL --retry 5 --retry-delay 3 -o "$tmp/$ZIP" "$URL"
unzip -q "$tmp/$ZIP" -d "$tmp/out"
mv "$tmp/out/Stronghold-Protocol" "$ASSETS/game"
rm -rf "$tmp"

# The lite package carries no art; the phone downloads it at first launch and unpacks it in place.
rm -rf "$ASSETS/game/public/assets"
du -sh "$ASSETS/game"

mkdir -p "$ASSETS/mod"
cp -R "$REPO_DIR/src" "$ASSETS/mod/src"
cp -R "$REPO_DIR/public" "$ASSETS/mod/public"
cp "$REPO_DIR/package.json" "$ASSETS/mod/package.json"
du -sh "$ASSETS/mod"
ls "$ASSETS/mod/src" "$ASSETS/mod/public"
