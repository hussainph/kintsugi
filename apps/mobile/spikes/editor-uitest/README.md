# KI-28 editor spike: headless UI test driver

Drives the dev-only `kintsugi://editor-spike` screen (`src/app/editor-spike.tsx`)
in the installed Kintsugi **debug** build with real touches and the real
software keyboard, without opening Simulator.app or Device Hub. `Host` is the
empty app XCUITest needs; the tests drive `dev.phalasiya.kintsugi` by bundle id.

From the repository root, with the app built and installed as described in
`AGENTS.md` ("Phone app") and Metro running:

```sh
UDID=<a simulator you created for this>
mkdir -p .headless/uitest
(cd apps/mobile/spikes/editor-uitest && xcodegen generate --spec project.yml --project "$OLDPWD/.headless/uitest")
xcodebuild build-for-testing -project .headless/uitest/EditorSpikeUITests.xcodeproj \
  -scheme SpikeUITests -destination "id=$UDID" -derivedDataPath .headless/uitest/dd
TEST_RUNNER_SPIKE_OUT="$PWD/.headless/spike-out" xcodebuild test-without-building \
  -project .headless/uitest/EditorSpikeUITests.xcodeproj -scheme SpikeUITests \
  -destination "id=$UDID" -derivedDataPath .headless/uitest/dd \
  -only-testing:SpikeUITests/EditorSpikeTests/testShortDocument
```

Screenshots and a `.log` of the on-screen metrics line land in
`.headless/spike-out/`. Switch appearance with
`xcrun simctl ui "$UDID" appearance dark`.
