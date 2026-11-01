// Run after `expo prebuild --platform ios --no-install`.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { IOSConfig } = require('expo/config-plugins');
const plist = require('@expo/plist').default;
const project = IOSConfig.XcodeUtils.getPbxproj(process.cwd());
const unquote = (value) => value?.replaceAll('"', '');
const targets = Object.entries(project.pbxNativeTargetSection()).filter(
  ([id, target]) => !id.endsWith('_comment') && unquote(target.name) === 'KintsugiShare',
);
assert.equal(targets.length, 1, 'exactly one extension target');
const [targetID, target] = targets[0];
assert.equal(unquote(target.productType), 'com.apple.product-type.app-extension');
const app = project.getFirstTarget().firstTarget;
const dependencies = project.hash.project.objects.PBXTargetDependency;
assert(app.dependencies.some(({ value }) => dependencies[value].target === targetID), 'app builds extension');
const copies = project.hash.project.objects.PBXCopyFilesBuildPhase;
const builds = project.pbxBuildFileSection();
const embedIndex = app.buildPhases.findIndex(({ value }) => copies[value]?.files.some(({ value }) => builds[value].fileRef === target.productReference));
assert(embedIndex >= 0, 'app embeds extension');
const scripts = project.hash.project.objects.PBXShellScriptBuildPhase;
const bundleIndex = app.buildPhases.findIndex(({ value }) => unquote(scripts[value]?.name) === 'Bundle React Native code and images');
assert(embedIndex < bundleIndex, 'embed phase precedes React Native bundle script');
for (const { value } of project.pbxXCConfigurationList()[target.buildConfigurationList].buildConfigurations) {
  const settings = project.pbxXCBuildConfigurationSection()[value].buildSettings;
  assert.equal(settings.APPLICATION_EXTENSION_API_ONLY, 'YES');
  assert.equal(unquote(settings.INFOPLIST_FILE), 'KintsugiShare/Info.plist');
  assert.equal(unquote(settings.CODE_SIGN_ENTITLEMENTS), 'KintsugiShare/KintsugiShare.entitlements');
  assert.equal(unquote(settings.PRODUCT_BUNDLE_IDENTIFIER), 'dev.phalasiya.kintsugi.share');
}
const load = (file) => plist.parse(fs.readFileSync(file, 'utf8'));
const appEntitlements = load('ios/Kintsugi/Kintsugi.entitlements');
const shareEntitlements = load('ios/KintsugiShare/KintsugiShare.entitlements');
assert.equal(appEntitlements['keychain-access-groups'][0], '$(AppIdentifierPrefix)dev.phalasiya.kintsugi', 'old pairing keychain remains the default');
for (const entitlements of [appEntitlements, shareEntitlements]) {
  assert(entitlements['com.apple.security.application-groups'].includes('group.dev.phalasiya.kintsugi.capture'));
  assert(entitlements['keychain-access-groups'].includes('$(AppIdentifierPrefix)dev.phalasiya.kintsugi.capture'));
}
const info = load('ios/KintsugiShare/Info.plist');
assert.equal(info.NSExtension.NSExtensionPointIdentifier, 'com.apple.share-services');
assert.equal(info.KintsugiKeychainGroup, '$(AppIdentifierPrefix)dev.phalasiya.kintsugi.capture');
const rule = info.NSExtension.NSExtensionAttributes.NSExtensionActivationRule;
assert.equal(rule.NSExtensionActivationSupportsWebURLWithMaxCount, 1);
assert.equal(rule.NSExtensionActivationSupportsImageWithMaxCount, 1);
assert.equal(rule.NSExtensionActivationSupportsText, true);
assert.equal(rule.NSExtensionActivationSupportsFileWithMaxCount, 1, 'one PDF or EPUB per share');
const files = project.hash.project.objects.PBXFileReference;
const sources = project.hash.project.objects.PBXSourcesBuildPhase;
const phase = target.buildPhases.map(({ value }) => sources[value]).find(Boolean);
const sourceNames = phase.files.map(({ value }) => unquote(files[builds[value].fileRef].path)).sort();
assert.deepEqual(sourceNames, ['CaptureDelivery.swift', 'CapturePairing.swift', 'CaptureStore.swift', 'ShareViewController.swift']);
for (const file of sourceNames) assert(fs.statSync(`ios/KintsugiShare/${file}`).size > 0);
const privacy = load('ios/KintsugiShare/PrivacyInfo.xcprivacy');
assert.equal(privacy.NSPrivacyAccessedAPITypes[0].NSPrivacyAccessedAPIType, 'NSPrivacyAccessedAPICategoryFileTimestamp');
const resources = project.hash.project.objects.PBXResourcesBuildPhase;
const resourcePhase = target.buildPhases.map(({ value }) => resources[value]).find(Boolean);
assert(resourcePhase.files.some(({ value }) => unquote(files[builds[value].fileRef].path) === 'PrivacyInfo.xcprivacy'));
console.log('Capture CNG target: sources, dependency, embedding, activation (URL, text, image, file), privacy manifest, entitlements and keychain migration OK.');
