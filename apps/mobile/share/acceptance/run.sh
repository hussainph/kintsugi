#!/usr/bin/env bash
#
# KI-2 headless share acceptance.
#
# Runs the *real* system share sheet on a booted-but-windowless simulator:
#   - the real Kintsugi app (with the extension plugins/with-capture.js generated)
#     is installed, paired through the real `kintsugi://pair` deep link, and then
#     terminated; the journal checks the uploader's User-Agent as well;
#   - a tiny host app (apps/mobile/share/acceptance/Sources) presents
#     UIActivityViewController with a URL, a generated PNG or text;
#   - XCTest UI tests pick "Kintsugi" in the sheet, type a note and Save;
#   - assertions read the App Group container and a fake Mac's journal on the
#     host, never inside the UI test.
#
# This script never opens Simulator.app or Device Hub, never downloads a
# runtime, never runs `expo prebuild`/`pod install` or edits native sources under
# apps/mobile/ios, and never reads a real pairing token (test tokens only).
#
# Usage:  ./run.sh preflight | harness | run | server | clean
#   preflight  report toolchain, runtime, device and artifact readiness; boots nothing
#   harness    xcodegen + build the host app and UI tests only (--generic skips a device)
#   run        the whole acceptance (boots the device, installs, pairs, url + image)
#   server     run the fake Mac in the foreground (debugging)
#   clean      delete generated evidence (keeps source files)
#
# The default `run` proves the feature end to end with one URL and one image
# capture. Extra scenarios are opt-in: KI2_ONLY=text (plain text) and
# KI2_ONLY=phone (phone capture box) and KI2_ONLY=drain (forced app handoff).
#
# Environment (all optional):
#   KI2_UDID            use this simulator instead of the script's own device
#   KI2_APP_PATH        use an already built Kintsugi.app (skips building it)
#   KI2_SKIP_APP_BUILD  1 = require KI2_APP_PATH
#   KI2_RUNTIME_PREFIX  iOS runtime version prefix to accept        (default 27.)
#   KI2_DEVICE_NAME     name of the script's own simulator        (default below)
#   KI2_DEVICE_TYPE     device type for that simulator            (default iPhone-17)
#   KI2_PORT            fake Mac port                              (default 8848)
#   KI2_TOKEN           fake Mac bearer token              (default test-token)
#   KI2_ONLY            run one case: url | image | text | phone | drain
#   KI2_RESET           1 = uninstall + reset keychain first (default: 1 for
#                       the script's own device, 0 for KI2_UDID)
#   VOLLI_CONCURRENCY_HINT  passed to xcodebuild -jobs
#
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
MOBILE=$(cd "$HERE/../.." && pwd)
WORK="$MOBILE/.expo/share-acceptance"
PROJECT="$WORK/project/ShareHarness.xcodeproj"
JOURNAL="$WORK/journal/mac.jsonl"
LOGS="$WORK/logs"
RESULTS="$WORK/results"
SHOTS="$WORK/screenshots"

KI2_APP_ID="dev.phalasiya.kintsugi"
KI2_EXTENSION_ID="dev.phalasiya.kintsugi.share"
KI2_APP_GROUP="group.dev.phalasiya.kintsugi.capture"
KI2_HARNESS_ID="dev.phalasiya.kintsugi.shareharness"
KI2_TESTS="ShareHarnessUITests/CaptureAcceptanceTests"

: "${KI2_UDID:=}"
: "${KI2_APP_PATH:=}"
: "${KI2_SKIP_APP_BUILD:=0}"
: "${KI2_RUNTIME_PREFIX:=27.}"
: "${KI2_DEVICE_NAME:=KI-2 acceptance iPhone}"
: "${KI2_DEVICE_TYPE:=com.apple.CoreSimulator.SimDeviceType.iPhone-17}"
: "${KI2_PORT:=8848}"
: "${KI2_TOKEN:=test-token}"
: "${KI2_ONLY:=}"
: "${KI2_RESET:=}"
: "${JOBS:=${VOLLI_CONCURRENCY_HINT:-0}}"

UDID=""
RUNTIME_ID=""
DEVICE_LABEL=""
APP=""
SERVER_PID=""
RESULTS_LOG=""
SUMMARY="$WORK/summary.md"

# xcodegen resolves the current user for project metadata; a bare agent shell
# may have no USER, which makes it fail with "Couldn't find current username".
export USER="${USER:-$(id -un)}"
export LOGNAME="${LOGNAME:-$(id -un)}"

log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
record() { RESULTS_LOG="$RESULTS_LOG$1"$'\n'; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

xcb() {
  if [ "${JOBS}" -gt 0 ] 2>/dev/null; then
    xcodebuild -jobs "$JOBS" "$@"
  else
    xcodebuild "$@"
  fi
}

prepare_dirs() {
  mkdir -p "$WORK/project" "$LOGS" "$RESULTS" "$SHOTS" "$WORK/journal" "$WORK/queue"
}

# ---------------------------------------------------------------- environment

# Accepts any available iOS runtime whose version starts with KI2_RUNTIME_PREFIX
# (27.0 today, 27.1 later) and picks the newest. Never downloads anything.
pick_runtime() {
  xcrun simctl list runtimes --json | jq -r --arg p "$KI2_RUNTIME_PREFIX" '
    .runtimes[]
    | select(.platform == "iOS" and .isAvailable and (.version | startswith($p)))
    | select(any(.supportedDeviceTypes[]?; .productFamily == "iPhone"
        and ((.identifier | contains("Duo")) | not)))
    | "\(.version)\t\(.identifier)"' | sort -V | tail -1 | cut -f2
}

runtime_error() {
  cat >&2 <<'EOF'
ERROR: no available iOS 27.x runtime supporting a standard iPhone on this Mac.

This script never downloads a runtime. Install one first (owner action):
  xcodebuild -downloadPlatform iOS            # or Xcode > Settings > Components
  xcrun simctl runtime add <iOS *.dmg>        # if downloaded by hand
Then check:
  xcrun simctl list runtimes --json | jq -r '.runtimes[] | select(.platform=="iOS")'
EOF
}

# Our own device first: a named device keeps this run away from every other
# simulator a person or another agent is using. The Duo is never eligible.
device_by_name() {
  xcrun simctl list devices --json | jq -r --arg rt "$1" --arg n "$KI2_DEVICE_NAME" '
    .devices[$rt] // [] | map(select(.isAvailable and .name == $n)) | (.[0].udid // "")'
}

supported_device_type() {
  xcrun simctl list runtimes --json | jq -r --arg rt "$1" --arg want "$KI2_DEVICE_TYPE" '
    .runtimes[] | select(.identifier == $rt)
    | [.supportedDeviceTypes[].identifier] as $types
    | if ($types | index($want)) then $want
      else ([$types[] | select(contains("SimDeviceType.iPhone") and (contains("Duo") | not))] | .[0] // "")
      end'
}

assert_standard_device() {
  xcrun simctl list devices --json | jq -e --arg u "$1" --arg rt "$2" '
    [.devices[$rt][]? | select(.udid == $u and .isAvailable
      and (.deviceTypeIdentifier | contains("iPhone"))
      and ((.deviceTypeIdentifier | contains("Duo")) | not))] | length == 1' >/dev/null 2>&1 \
    || die "device $1 is not an available standard iPhone on $2 (the Duo cannot run app extensions)"
}

resolve_device() {
  local version
  if [ -n "$KI2_UDID" ]; then
    UDID="$KI2_UDID"
    RUNTIME_ID=$(xcrun simctl list devices --json | jq -r --arg u "$UDID" '
      .devices | to_entries[] | select(any(.value[]; .udid == $u)) | .key')
    version=$(xcrun simctl list runtimes --json | jq -r --arg rt "$RUNTIME_ID" --arg p "$KI2_RUNTIME_PREFIX" '
      .runtimes[] | select(.identifier == $rt and .platform == "iOS" and .isAvailable
        and (.version | startswith($p))) | .version')
    [ -n "$version" ] || die "provided device $UDID has no available iOS $KI2_RUNTIME_PREFIX runtime"
    assert_standard_device "$UDID" "$RUNTIME_ID"
    DEVICE_LABEL="(provided) $(xcrun simctl list devices --json | jq -r --arg u "$UDID" '[.devices[][] | select(.udid==$u)][0].name')"
    note "using provided device $UDID $DEVICE_LABEL"
    return
  fi

  RUNTIME_ID=$(pick_runtime)
  [ -n "$RUNTIME_ID" ] || { runtime_error; exit 2; }
  version=$(xcrun simctl list runtimes --json | jq -r --arg rt "$RUNTIME_ID" '.runtimes[] | select(.identifier==$rt) | .version')
  UDID=$(device_by_name "$RUNTIME_ID")
  if [ -z "$UDID" ]; then
    local type
    type=$(supported_device_type "$RUNTIME_ID")
    [ -n "$type" ] || die "iOS $version has no standard iPhone device type to create"
    UDID=$(xcrun simctl create "$KI2_DEVICE_NAME" "$type" "$RUNTIME_ID")
    note "created simulator “$KI2_DEVICE_NAME” ($type) on iOS $version: $UDID"
  else
    note "reusing simulator “$KI2_DEVICE_NAME”: $UDID"
  fi
  assert_standard_device "$UDID" "$RUNTIME_ID"
  DEVICE_LABEL="$KI2_DEVICE_NAME"
}

preflight() {
  log "toolchain"
  note "$(xcodebuild -version | tr '\n' ' ')"
  note "simulator SDK $(xcrun --sdk iphonesimulator --show-sdk-version)"
  note "xcodegen $(xcodegen --version 2>/dev/null | head -1)"
  note "node $(node --version)"

  log "iOS simulator runtimes (nothing is downloaded here)"
  xcrun simctl list runtimes --json | jq -r '
    .runtimes[] | select(.platform=="iOS")
    | "   \(.identifier)  \(.version)  available=\(.isAvailable)  build=\(.buildversion)"'
  resolve_device
  note "runtime: $RUNTIME_ID"
  note "device:  $DEVICE_LABEL ($UDID)"

  log "app artifact"
  if [ -n "$KI2_APP_PATH" ]; then
    note "provided: $KI2_APP_PATH"
    verify_artifact "$KI2_APP_PATH"
  elif [ -d "$MOBILE/ios/Pods" ]; then
    note "will build apps/mobile/ios/Kintsugi.xcworkspace (Release, simulator ad-hoc signing)"
  else
    note "apps/mobile/ios/Pods is missing — this script never runs prebuild/pod install."
    note "run “pnpm --filter @kintsugi/mobile exec expo prebuild --platform ios” first,"
    note "or pass KI2_APP_PATH=<built Kintsugi.app>."
  fi

  if pgrep -f "DeviceHub" >/dev/null 2>&1; then
    note "note: Device Hub is running (not started by this script; it is never touched)"
  fi
  note "ready; run './run.sh run' to boot and test"
}

# Simulator entitlements can live in the Mach-O __TEXT,__entitlements section
# rather than in the (empty) ad-hoc signature. Inspect the built executable,
# never a source .entitlements file, and still require a valid bundle signature.
entitlements_of() {
  local bundle=$1 signed executable binary thin offset size section
  signed=$(codesign -d --entitlements :- "$bundle" 2>/dev/null || true)
  if printf '%s' "$signed" | grep -q "$KI2_APP_GROUP"; then printf '%s' "$signed"; return; fi
  executable=$(plutil -extract CFBundleExecutable raw -o - "$bundle/Info.plist")
  binary="$bundle/$executable"
  if xcrun lipo -info "$binary" | grep -q 'Architectures in the fat file'; then
    thin="$WORK/$(basename "$bundle").entitlements-macho"
    xcrun lipo "$binary" -thin "$(uname -m)" -output "$thin"
    binary="$thin"
  fi
  section=$(xcrun otool -l "$binary" | awk '
    $1 == "sectname" && $2 == "__entitlements" { found=1 }
    found && $1 == "size" { size=$2 }
    found && $1 == "offset" && !done { print $2, size; done=1 }')
  read -r offset size <<< "$section"
  if [[ "$offset" =~ ^[0-9]+$ && "$size" =~ ^0x[0-9a-fA-F]+$ ]]; then
    dd if="$binary" bs=1 skip="$offset" count="$((size))" 2>/dev/null
  else
    printf '%s' "$signed"
  fi
}

verify_artifact() {
  local app=$1 appex="$1/PlugIns/KintsugiShare.appex" group
  [ -d "$app" ] || die "no app bundle at $app"
  [ -d "$appex" ] || die "no embedded extension at $appex — this is not the generated Kintsugi app"
  codesign --verify --deep --strict "$app" || die "app/extension signatures are invalid"
  local id
  id=$(plutil -extract CFBundleIdentifier raw -o - "$appex/Info.plist" 2>/dev/null || true)
  [ "$id" = "$KI2_EXTENSION_ID" ] || die "embedded extension is “$id”, expected $KI2_EXTENSION_ID"

  group=$(plutil -extract KintsugiKeychainGroup raw -o - "$appex/Info.plist" 2>/dev/null || true)
  case "$group" in
    "") die "the extension Info.plist has no KintsugiKeychainGroup" ;;
    *'$('*) die "KintsugiKeychainGroup is unexpanded (“$group”). CapturePairing.baseQuery() throws on that, so pairing cannot be shared. Rebuild with default simulator signing (not CODE_SIGNING_ALLOWED=NO)." ;;
  esac
  note "shared keychain group: $group"

  local bundle entitlements
  for bundle in "$app" "$appex"; do
    [ "$(plutil -extract KintsugiKeychainGroup raw -o - "$bundle/Info.plist")" = "$group" ] \
      || die "app and extension must use the same expanded Keychain group"
    entitlements=$(entitlements_of "$bundle")
    printf '%s' "$entitlements" | plutil -convert json -o - - | jq -e \
      --arg appGroup "$KI2_APP_GROUP" --arg keychainGroup "$group" '
        ((."com.apple.security.application-groups" // []) | index($appGroup)) != null
        and ((."keychain-access-groups" // []) | index($keychainGroup)) != null' >/dev/null \
      || die "$bundle lacks the exact App Group / shared-Keychain entitlements; use a signed simulator build"
  done
  note "entitlements: App Group + shared keychain present in app and extension"
}

# ---------------------------------------------------------------- simulator

boot_device() {
  log "booting $DEVICE_LABEL ($UDID) headlessly"
  # -b boots if needed and returns once the device is ready; no window is opened.
  xcrun simctl bootstatus "$UDID" -b >"$LOGS/boot.log" 2>&1 \
    || { tail -20 "$LOGS/boot.log" >&2; die "the simulator did not finish booting"; }
  xcrun simctl ui "$UDID" appearance light >/dev/null 2>&1 || true
  note "booted"
}

build_app() {
  if [ -n "$KI2_APP_PATH" ]; then
    APP="$KI2_APP_PATH"
    note "using provided app: $APP"
    return
  fi
  [ "$KI2_SKIP_APP_BUILD" != "1" ] || die "KI2_SKIP_APP_BUILD=1 needs KI2_APP_PATH"
  [ -d "$MOBILE/ios/Pods" ] \
    || die "apps/mobile/ios/Pods is missing. This script never runs prebuild or pod install (CNG, and the parent may be working there). Run “pnpm --filter @kintsugi/mobile exec expo prebuild --platform ios”, or pass KI2_APP_PATH."
  local workspace="$MOBILE/ios/Kintsugi.xcworkspace"
  [ -d "$workspace" ] || die "no $workspace; run pod install in apps/mobile/ios"

  log "building the real app (Release, default simulator ad-hoc signing)"
  xcb -workspace "$workspace" -scheme Kintsugi -configuration Release \
    -destination "id=$UDID" -derivedDataPath "$WORK/DerivedData-app" ONLY_ACTIVE_ARCH=YES build
  APP="$WORK/DerivedData-app/Build/Products/Release-iphonesimulator/Kintsugi.app"
}

# Check before uninstall/reset *and* before changing pairing. Home drains as
# soon as it is paired; a guard after pairing would silently lose an old queue
# to the stub. Inspect both stores without launching the app or changing bytes.
guard_existing_outbox() {
  local group app_data db snapshot raw recoveries
  xcrun simctl terminate "$UDID" "$KI2_APP_ID" >/dev/null 2>&1 || true
  group=$(xcrun simctl get_app_container "$UDID" "$KI2_APP_ID" "$KI2_APP_GROUP" 2>/dev/null || true)
  if [ -n "$group" ]; then
    if [ -n "$(find "$group/Captures/captures" "$group/Captures/malformed" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null || true)" ]; then
      die "existing shared captures/recovery data found before pairing or reset; use a fresh dedicated simulator (nothing was deleted)"
    fi
  fi
  app_data=$(xcrun simctl get_app_container "$UDID" "$KI2_APP_ID" data 2>/dev/null || true)
  db="$app_data/Documents/SQLite/ExpoSQLiteStorage"
  if [ -n "$app_data" ] && [ -f "$db" ]; then
    # Even read-only SQLite can create a WAL shared-memory file. Read a private
    # worktree snapshot instead; the app is terminated and the extension never
    # accesses this private legacy store.
    snapshot=$(mktemp -d "$WORK/queue-guard.XXXXXX")
    cp "$db" "$snapshot/store"
    for suffix in -wal -shm; do
      if [ -f "$db$suffix" ]; then cp "$db$suffix" "$snapshot/store$suffix"; fi
    done
    if ! raw=$(sqlite3 -readonly "$snapshot/store" "SELECT COALESCE((SELECT value FROM storage WHERE key = 'outbox'), '[]');") \
      || ! recoveries=$(sqlite3 -readonly "$snapshot/store" "SELECT count(*) FROM storage WHERE key LIKE 'outbox.recovery.%';"); then
      rm -rf "$snapshot"
      die "cannot inspect the existing legacy outbox safely; use a fresh dedicated simulator"
    fi
    rm -rf "$snapshot"
    if [ "$recoveries" != "0" ] || ! printf '%s' "$raw" | jq -e 'type == "array" and length == 0' >/dev/null; then
      die "existing legacy captures/recovery data found before pairing or reset; use a fresh dedicated simulator (nothing was deleted)"
    fi
  fi
}

install_app() {
  log "installing the app and its extension"
  if [ "${KI2_RESET:-1}" = "1" ]; then
    xcrun simctl uninstall "$UDID" "$KI2_APP_ID" >/dev/null 2>&1 || true
    # Only ever our own device by default; wipes SecureStore + the shared item.
    xcrun simctl keychain "$UDID" reset >/dev/null 2>&1 || die "could not reset the owned simulator's keychain"
  fi
  xcrun simctl install "$UDID" "$APP"
  # listapps does not consistently enumerate appex bundles. The real system
  # share-sheet test below is the registration check, not a grep of app metadata.
  note "installed $KI2_APP_ID with embedded $KI2_EXTENSION_ID"
}

# ---------------------------------------------------------------- fake Mac

start_server() {
  local mode=${1:-ok}
  prepare_dirs
  : >"$JOURNAL"
  node "$HERE/Mac/fake-mac.mjs" --port "$KI2_PORT" --token "$KI2_TOKEN" \
    --journal "$JOURNAL" --mode "$mode" >"$LOGS/fake-mac.log" 2>&1 &
  SERVER_PID=$!
  local waited=0
  while [ "$waited" -lt 50 ]; do
    grep -q '^LISTENING ' "$LOGS/fake-mac.log" 2>/dev/null && {
      note "fake Mac on 127.0.0.1:$KI2_PORT (mode $mode)"
      return 0
    }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.2
    waited=$((waited + 1))
  done
  cat "$LOGS/fake-mac.log" >&2
  die "the fake Mac did not start (port $KI2_PORT busy? set KI2_PORT)"
}

stop_server() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi
}

set_mode() {
  curl -fsS -X POST -d "{\"mode\":\"$1\"}" "http://127.0.0.1:$KI2_PORT/_control" >/dev/null \
    || die "could not switch the fake Mac to mode $1"
  note "fake Mac mode: $1"
}

wait_journal() { # jq filter, timeout seconds
  local filter=$1 timeout=${2:-90} waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if [ -s "$JOURNAL" ] && jq -es --arg base "http://127.0.0.1:$KI2_PORT" "$filter" "$JOURNAL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

# Pairing is the product's own deep link; XCTest only approves iOS's Open alert.
pair() {
  local encoded
  encoded=$(printf 'http://127.0.0.1:%s' "$KI2_PORT" | sed 's|:|%3A|g; s|/|%2F|g')
  log "pairing through kintsugi://pair (real deep link, test token only)"
  xcrun simctl openurl "$UDID" "kintsugi://pair?url=$encoded&token=$KI2_TOKEN"
  # iOS 27 may gate first-use custom schemes behind an Open confirmation.
  # XCTest drives that real alert headlessly; never write Keychain data directly.
  rm -rf "$RESULTS/pair.xcresult"
  xcb test-without-building -project "$PROJECT" -scheme ShareHarness \
    -destination "id=$UDID" -derivedDataPath "$WORK/DerivedData-harness" \
    -parallel-testing-enabled NO -collect-test-diagnostics never \
    -test-timeouts-enabled YES -maximum-test-execution-time-allowance 180 \
    -resultBundlePath "$RESULTS/pair.xcresult" \
    -only-testing:"$KI2_TESTS/testApprovePairingLink" >"$LOGS/pair.log" 2>&1 \
    || { tail -40 "$LOGS/pair.log" >&2; die "could not approve the pairing link headlessly"; }
  wait_journal 'any(.[]; .event == "hello") and any(.[]; .event == "tree")' 120 \
    || die "the app never called /v1/hello: pairing failed (see $LOGS/*.log and 'log show --last 5m --predicate \"process == \\\"Kintsugi\\\"\"')"
  note "the app reached the fake Mac and saved the pairing"
  # Home's successful tree request means pairing reached the mounted app;
  # the synchronous pairing-mirror effect has run by the end of that render.
  xcrun simctl terminate "$UDID" "$KI2_APP_ID" >/dev/null 2>&1 || true
  note "app terminated: the extension must now deliver on its own"
}

# ---------------------------------------------------------------- cases

queue_pending() {
  local dir
  dir=$(xcrun simctl get_app_container "$UDID" "$KI2_APP_ID" "$KI2_APP_GROUP" 2>/dev/null || true)
  [ -n "$dir" ] || die "cannot inspect the App Group container; missing signing entitlement?"
  [ -d "$dir/Captures/captures" ] || die "the capture store was never created in the App Group"
  find "$dir/Captures/captures" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | wc -l | tr -d ' '
}

wait_queue_empty() {
  local count waited=0
  while [ "$waited" -lt 90 ]; do
    count=$(queue_pending) || return 1
    [ "$count" = "0" ] && return 0
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

dump_queue() { # label
  local dir out
  dir=$(xcrun simctl get_app_container "$UDID" "$KI2_APP_ID" "$KI2_APP_GROUP" 2>/dev/null || true)
  out="$WORK/queue/$1"
  mkdir -p "$out"
  {
    echo "app group: ${dir:-<none>}"
    [ -n "$dir" ] && find "$dir/Captures" -maxdepth 3 2>/dev/null | sed "s|$dir|<group>|"
    for payload in "$dir"/Captures/captures/*/payload.json; do
      [ -f "$payload" ] || continue
      jq -c '{queue: input_filename, id, via, url, note, textBytes: ((.text // "") | length), imageBytes: ((.image // "") | length), imageType, capturedAt}' "$payload" 2>/dev/null || true
    done
  } >"$out/captures.txt" 2>&1
}

run_case() { # name, test method, jq assertion, expect queue empty (default 1)
  local name=$1 test=$2 assertion=$3 expect_empty=${4:-1}
  log "case $name"
  xcrun simctl terminate "$UDID" "$KI2_APP_ID" >/dev/null 2>&1 || true
  rm -rf "$RESULTS/$name.xcresult"
  local status=0
  xcb test-without-building \
    -project "$PROJECT" -scheme ShareHarness \
    -destination "id=$UDID" -derivedDataPath "$WORK/DerivedData-harness" \
    -parallel-testing-enabled NO -collect-test-diagnostics never \
    -test-timeouts-enabled YES -maximum-test-execution-time-allowance 180 \
    -resultBundlePath "$RESULTS/$name.xcresult" \
    -only-testing:"$KI2_TESTS/$test" >"$LOGS/$name.log" 2>&1 || status=$?
  xcrun simctl io "$UDID" screenshot "$SHOTS/$name.png" >/dev/null 2>&1 || true
  dump_queue "$name"
  if [ "$status" -ne 0 ]; then
    tail -40 "$LOGS/$name.log" >&2
    record "- FAIL $name (xcodebuild $status; $LOGS/$name.log, $RESULTS/$name.xcresult)"
    die "case $name failed"
  fi
  wait_journal "$assertion" 90 || {
    record "- FAIL $name (the fake Mac never saw the expected capture)"
    die "case $name: the extension did not deliver the expected capture (journal: $JOURNAL)"
  }
  local pending
  pending=$(queue_pending)
  if [ "$expect_empty" = "1" ]; then
    wait_queue_empty || {
      record "- FAIL $name ($pending capture(s) still queued after a 2xx reply)"
      die "case $name: $pending capture(s) still queued although the Mac accepted them"
    }
    printf '\npending after acknowledged delivery: 0\n' >> "$WORK/queue/$name/captures.txt"
    record "- PASS $name"
  else
    record "- PASS $name (delivery attempted, $pending capture(s) left queued as expected)"
  fi
  note "passed"
}

case_url() {
  run_case url testURLShareWithNote \
    'any(.[]; .event == "clips" and .status == 200 and .via == "share"
      and .url == ($base + "/page.html?case=url")
      and ((.userAgent // "") | startswith("KintsugiShare/"))
      and ((.note // "") | contains("KI-2 acceptance note"))
      and ((.id // "") | test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")))'
}

case_image() {
  run_case image testImageShareWithNote \
    'any(.[]; .event == "clips" and .status == 200 and .via == "share"
      and ((.imageBytes // 0) > 0) and .imageType == "image/png"
      and ((.userAgent // "") | startswith("KintsugiShare/"))
      and ((.id // "") | test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"))
      and ((.note // "") | contains("KI-2 acceptance note")))'
}

case_text() {
  run_case text testTextShare \
    'any(.[]; .event == "clips" and .status == 200 and .via == "share"
      and ((.textBytes // 0) > 0) and .url == null
      and ((.userAgent // "") | startswith("KintsugiShare/")))'
}

case_phone() {
  run_case phone testPhoneURLCapture \
    'any(.[]; .event == "clips" and .status == 200 and .via == "phone"
      and .url == ($base + "/page.html?case=phone")
      and ((.id // "") | test("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"))
      and ((.userAgent // "") | startswith("Kintsugi/")))'
}

# Durability: commit/drop the first extension request, then return 503 to its
# retries. Only the app can acknowledge this capture. No storage is modified
# by the harness: lease release/expiry and delivery use the real product code.
case_drain() {
  log "case drain (lost reply, then the app drains)"
  set_mode handoff
  run_case drain-share testURLShareWithNote \
    'any(.[]; .event == "clips" and .outcome == "reply-lost" and .dedup == false
      and ((.userAgent // "") | startswith("KintsugiShare/")))' 0
  wait_journal '[.[] | select(.event == "clips" and .outcome == "reply-lost")][0] as $lost
    | any(.[]; .event == "clips" and .status == 503 and .id == $lost.id)' 90 \
    || { record "- FAIL drain (no completed extension failure after the lost reply)"; die "no extension 503 recorded"; }
  local pending dir id
  pending=$(queue_pending)
  id=$(jq -rs '[.[] | select(.event == "clips" and .outcome == "reply-lost")][0].id' "$JOURNAL")
  dir=$(xcrun simctl get_app_container "$UDID" "$KI2_APP_ID" "$KI2_APP_GROUP")
  if [ "$pending" != "1" ] || ! jq -es --arg id "$id" 'length == 1 and .[0].id == $id' "$dir"/Captures/captures/*/payload.json >/dev/null; then
    record "- FAIL drain (the lost-response UUID is not the sole persisted capture)"
    die "the lost reply did not preserve the expected payload — durability evidence missing"
  fi
  note "queued after the lost reply: $pending capture(s), UUID $id"
  dump_queue drain-queued

  # Same stateful mode, no reset of the receipt. This control event marks the
  # explicit app launch, so a prior background callback cannot satisfy it.
  set_mode handoff
  log "launching Kintsugi to drain the outbox"
  xcrun simctl launch "$UDID" "$KI2_APP_ID" >/dev/null
  # CFNetwork identifies the app and the extension separately. Require the
  # app's fetch here, not an automatic retry of the extension's NSURLSession.
  # A forced-quit app can leave a 120 s lease, followed by Home's 30 s retry.
  wait_journal '[.[] | select(.event == "clips" and .outcome == "reply-lost")][0] as $lost
    | [.[] | select(.event == "control")][-1].at as $launch
    | any(.[]; .event == "clips" and .status == 200 and .dedup == true
      and .id == $lost.id and .path == $lost.path and .captureSha256 == $lost.captureSha256
      and .at >= $launch and ((.userAgent // "") | startswith("Kintsugi/")))' 210 || {
    record "- FAIL drain (the app never delivered the queued capture with its persisted id)"
    die "the app did not drain the queue (see $LOGS; 'log show --last 5m --predicate \"process == \\\"Kintsugi\\\"\"')"
  }
  jq -es --arg id "$id" '[.[] | select(.event == "clips" and .id == $id
    and .dedup == false and (.outcome == "reply-lost" or .outcome == "accepted"))] | length == 1' "$JOURNAL" >/dev/null \
    || { record "- FAIL drain (more than one non-deduplicated commit)"; die "capture committed more than once"; }
  pending=$(queue_pending)
  wait_queue_empty || {
    record "- FAIL drain ($pending capture(s) still queued)"
    die "the app drained with a 2xx but $pending capture(s) remain"
  }
  xcrun simctl terminate "$UDID" "$KI2_APP_ID" >/dev/null 2>&1 || true
  dump_queue drain-acknowledged
  record "- PASS drain (forced extension failure kept the UUID; the app delivered identical content to the original deduplicated path)"
  note "drained"
}

# ---------------------------------------------------------------- commands

build_harness() { # destination
  prepare_dirs
  log "generating the harness project (xcodegen)"
  ( cd "$HERE" && KI2_BASE_URL="http://127.0.0.1:$KI2_PORT" xcodegen generate --spec project.yml --project "$WORK/project" >/dev/null )
  log "building the harness for $1"
  xcb build-for-testing -project "$PROJECT" -scheme ShareHarness \
    -destination "$1" -derivedDataPath "$WORK/DerivedData-harness"
  note "harness built"
}

write_summary() {
  prepare_dirs
  {
    printf '# KI-2 share acceptance\n\n'
    printf -- '- at: %s\n' "$(date -u +%FT%TZ)"
    printf -- '- runtime: %s\n' "${RUNTIME_ID:-unknown}"
    printf -- '- device: %s (%s)\n' "${DEVICE_LABEL:-unknown}" "${UDID:-none}"
    printf -- '- app: %s\n' "${APP:-not resolved}"
    printf -- '- fake Mac journal: %s\n\n' "$JOURNAL"
    [ -n "$RESULTS_LOG" ] && printf '%s' "$RESULTS_LOG"
    printf '\nEvidence: %s\n' "$WORK"
  } >"$SUMMARY" 2>/dev/null || true
}

on_exit() {
  local status=$?
  if [ "$status" != "0" ]; then record "- FAIL run (exit $status; see logs for the failing step)"; fi
  stop_server
  write_summary
}

cmd_run() {
  trap on_exit EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  prepare_dirs
  resolve_device
  if [ -z "${KI2_RESET:-}" ]; then
    if [ -n "$KI2_UDID" ]; then KI2_RESET=0; else KI2_RESET=1; fi
  fi
  boot_device
  build_app
  verify_artifact "$APP"
  guard_existing_outbox
  install_app
  guard_existing_outbox
  start_server ok
  build_harness "id=$UDID"
  pair
  [ "$(queue_pending)" = "0" ] || { record "- FAIL setup (existing captures remain; use a dedicated simulator)"; die "queue is not empty after pairing; existing captures are preserved"; }

  # Default is the minimum that proves the feature end to end: one URL and one
  # image capture, delivered by the extension with the app terminated.
  case "${KI2_ONLY:-all}" in
    url) case_url ;;
    image) case_image ;;
    text) case_text ;;
    phone) case_phone ;;
    drain) case_drain ;;
    all) case_url; case_image ;;
    *) die "KI2_ONLY must be url, image, text, phone, drain or empty" ;;
  esac

  log "done"
  printf '%s' "${RESULTS_LOG:-}"
  note "summary: $SUMMARY"
  note "journal: $JOURNAL   screenshots: $SHOTS   results: $RESULTS"
  if pgrep -f "DeviceHub" >/dev/null 2>&1; then
    note "note: Device Hub is running (not started by this script)"
  fi
}

cmd_server() {
  prepare_dirs
  exec node "$HERE/Mac/fake-mac.mjs" --port "$KI2_PORT" --token "$KI2_TOKEN" --journal "$JOURNAL"
}

cmd_clean() {
  log "removing generated evidence under $WORK"
  rm -rf "$WORK/project" "$WORK/DerivedData-harness" "$WORK/DerivedData-app" \
    "$RESULTS" "$SHOTS" "$LOGS" "$WORK/journal" "$WORK/queue" "$SUMMARY"
  note "source files under $HERE are untouched"
}

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

case "${1:-run}" in
  preflight) prepare_dirs; preflight ;;
  harness)
    shift || true
    if [ "${1:-}" = "--generic" ]; then
      build_harness "generic/platform=iOS Simulator"
    else
      resolve_device
      build_harness "id=$UDID"
    fi
    ;;
  run) cmd_run ;;
  server) cmd_server ;;
  clean) cmd_clean ;;
  -h|--help|help) usage ;;
  *) usage; exit 2 ;;
esac
