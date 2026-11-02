#!/usr/bin/env bash
# KI-29: browse and filter writing on the phone, headlessly. Never opens
# Simulator/Device Hub; uses xcrun simctl + xcodebuild test only.
#
#   UDID=<a dedicated simulator> APP=<built Kintsugi.app (Release)> ./run.sh
#
# ONLY=inspiration runs KI-3's InspirationTests instead of BrowseTests (after
# the first-launch approval). They stop the Mac midway, through a file in
# $WORK/control, to browse offline.
#
# It seeds a scratch vault under .headless/, serves the real phone API on it
# (`phone_dev_server`, which refuses any vault outside .headless), installs
# the app, pairs through the real deep link and runs BrowseTests. Screenshots
# land in .headless/browse-acceptance/shots/.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"
WORK="$ROOT/.headless/browse-acceptance"
PORT="${PORT:-47529}"
: "${UDID:?set UDID to a dedicated simulator}"
: "${APP:?set APP to a built Kintsugi.app}"
export USER="${USER:-$(id -un)}" LANG="${LANG:-en_US.UTF-8}"

rm -rf "$WORK"; mkdir -p "$WORK/shots"
VAULT="$WORK/vault"
node "$ROOT/scripts/seed-desktop.mjs" "$VAULT" >/dev/null
# A nested, tagged draft (an Obsidian block list) for the folder and tag cases.
printf -- '---\ntitle: "Glaze chemistry"\nstatus: draft\ntags:\n  - craft\n  - fire\n---\n\nNotes on glaze.\n' >"$VAULT/posts/series/glaze.md"

(cd "$ROOT" && KINTSUGI_PHONE_DEV_PORT="$PORT" KINTSUGI_PHONE_DEV_VAULT="$VAULT" \
  cargo test -q -p kintsugi phone_dev_server -- --ignored --nocapture >"$WORK/mac.log" 2>&1) &
MAC=$!
stop() { kill "$MAC" 2>/dev/null; lsof -ti "tcp:$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true; }
CONTROL="$WORK/control"; mkdir -p "$CONTROL"
# A test asks for the Mac to go away by creating control/stop-mac.
( until [ -e "$CONTROL/stop-mac" ]; do sleep 0.5; done; stop; touch "$CONTROL/mac-stopped" ) &
WATCH=$!
trap 'stop; kill "$WATCH" 2>/dev/null || true' EXIT
until grep -q 'kintsugi://pair' "$WORK/mac.log" 2>/dev/null; do sleep 1; done

xcrun simctl bootstatus "$UDID" -b >/dev/null
xcrun simctl uninstall "$UDID" dev.phalasiya.kintsugi >/dev/null 2>&1 || true
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" dev.phalasiya.kintsugi >/dev/null
sleep 3
xcrun simctl openurl "$UDID" "kintsugi://pair?url=http%3A%2F%2F127.0.0.1%3A$PORT&token=TEST-TOKEN"

xcodegen generate --quiet --spec "$HERE/project.yml" --project "$WORK" --project-root "$HERE"
ONLY_TESTING=()
if [ "${ONLY:-}" = inspiration ]; then
  ONLY_TESTING=(-only-testing:BrowseHarnessUITests/BrowseTests/test0ApproveOpen -only-testing:BrowseHarnessUITests/InspirationTests)
else
  ONLY_TESTING=(-only-testing:BrowseHarnessUITests/BrowseTests)
fi
TEST_RUNNER_SHOTS="$WORK/shots" TEST_RUNNER_VAULT="$VAULT" TEST_RUNNER_CONTROL="$CONTROL" xcodebuild test \
  "${ONLY_TESTING[@]}" \
  -project "$WORK/BrowseHarness.xcodeproj" -scheme BrowseHarness \
  -destination "id=$UDID" -derivedDataPath "$WORK/DerivedData" \
  -resultBundlePath "$WORK/browse.xcresult" -parallel-testing-enabled NO \
  ${JOBS:+-jobs "$JOBS"} >"$WORK/xcodebuild.log" 2>&1 \
  || { grep -E "error|failed|XCTAssert" "$WORK/xcodebuild.log" | tail -20; exit 1; }
grep -E "Test Case .* (passed|failed)" "$WORK/xcodebuild.log"
ls "$WORK/shots"
