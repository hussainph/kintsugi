const fs = require('node:fs');
const path = require('node:path');
const { withEntitlementsPlist, withInfoPlist, withXcodeProject } = require('expo/config-plugins');
const { default: plist } = require('@expo/plist');

const TARGET = 'KintsugiShare';
const GROUP = 'group.dev.phalasiya.kintsugi.capture';
const KEYCHAIN = '$(AppIdentifierPrefix)dev.phalasiya.kintsugi.capture';
const sharedSources = ['CaptureStore.swift', 'CaptureDelivery.swift', 'CapturePairing.swift'];
const privacy = {
  NSPrivacyTracking: false,
  NSPrivacyCollectedDataTypes: [],
  NSPrivacyAccessedAPITypes: [{
    NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
    NSPrivacyAccessedAPITypeReasons: ['C617.1'], // queue files inside our App Group
  }],
};
const entitlements = {
  'com.apple.security.application-groups': [GROUP],
  'keychain-access-groups': [KEYCHAIN],
};

/** Native sources live outside ios/. Every prebuild regenerates the extension. */
module.exports = function withCapture(config) {
  const bundleIdentifier = `${config.ios.bundleIdentifier}.share`;
  config.ios.privacyManifests ??= {};
  const reasons = config.ios.privacyManifests.NSPrivacyAccessedAPITypes ?? [];
  if (!reasons.some((entry) => entry.NSPrivacyAccessedAPIType === 'NSPrivacyAccessedAPICategoryFileTimestamp')) {
    reasons.push(...privacy.NSPrivacyAccessedAPITypes);
  }
  config.ios.privacyManifests.NSPrivacyAccessedAPITypes = reasons;
  config = withEntitlementsPlist(config, (mod) => {
    for (const [key, values] of Object.entries(entitlements)) {
      // Keep the app's original default group first: existing SecureStore
      // pairing items must remain readable when keychain sharing is enabled.
      const original = key === 'keychain-access-groups' ? [`$(AppIdentifierPrefix)${config.ios.bundleIdentifier}`] : [];
      mod.modResults[key] = [...new Set([...original, ...(mod.modResults[key] ?? []), ...values])];
    }
    return mod;
  });
  config = withInfoPlist(config, (mod) => {
    mod.modResults.KintsugiKeychainGroup = KEYCHAIN;
    return mod;
  });
  config.extra ??= {};
  config.extra.eas ??= {};
  config.extra.eas.build ??= {};
  config.extra.eas.build.experimental ??= {};
  config.extra.eas.build.experimental.ios ??= {};
  const extensions = config.extra.eas.build.experimental.ios.appExtensions ?? [];
  config.extra.eas.build.experimental.ios.appExtensions = [
    ...extensions.filter((extension) => extension.targetName !== TARGET),
    { targetName: TARGET, bundleIdentifier, entitlements },
  ];

  return withXcodeProject(config, (mod) => {
    const root = mod.modRequest.projectRoot;
    const destination = path.join(mod.modRequest.platformProjectRoot, TARGET);
    fs.mkdirSync(destination, { recursive: true });
    for (const source of sharedSources) {
      fs.copyFileSync(path.join(root, 'modules/capture/ios/Shared', source), path.join(destination, source));
    }
    fs.copyFileSync(path.join(root, 'share/ShareViewController.swift'), path.join(destination, 'ShareViewController.swift'));
    fs.writeFileSync(path.join(destination, 'Info.plist'), plist.build({
      CFBundleDisplayName: 'Kintsugi',
      CFBundleExecutable: '$(EXECUTABLE_NAME)',
      CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
      CFBundleName: '$(PRODUCT_NAME)',
      CFBundlePackageType: 'XPC!',
      CFBundleShortVersionString: mod.version ?? '0.1.0',
      CFBundleVersion: mod.ios.buildNumber ?? '1',
      KintsugiKeychainGroup: KEYCHAIN,
      // The same local-network access as the containing app (development pairing).
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
      NSLocalNetworkUsageDescription: 'Send your captures to Kintsugi on your Mac.',
      NSExtension: {
        NSExtensionPointIdentifier: 'com.apple.share-services',
        NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).ShareViewController',
        NSExtensionAttributes: {
          NSExtensionActivationRule: {
            NSExtensionActivationSupportsText: true,
            NSExtensionActivationSupportsWebURLWithMaxCount: 1,
            NSExtensionActivationSupportsImageWithMaxCount: 1,
            // One PDF or EPUB (com.adobe.pdf, org.idpf.epub-container or a
            // `.pdf`/`.epub` file URL). The rule can't name file types, so
            // any single file activates; the sheet refuses other types and
            // files over 50 MB without saving.
            NSExtensionActivationSupportsFileWithMaxCount: 1,
          },
        },
      },
    }));
    fs.writeFileSync(path.join(destination, `${TARGET}.entitlements`), plist.build(entitlements));
    fs.writeFileSync(path.join(destination, 'PrivacyInfo.xcprivacy'), plist.build(privacy));

    const project = mod.modResults;
    const appTarget = project.getFirstTarget();
    // xcode's addTarget only wires dependencies when both sections exist.
    project.hash.project.objects.PBXTargetDependency ??= {};
    project.hash.project.objects.PBXContainerItemProxy ??= {};
    const existing = Object.entries(project.pbxNativeTargetSection()).find(
      ([key, value]) => !key.endsWith('_comment') && value.name?.replaceAll('"', '') === TARGET,
    );
    const target = existing
      ? { uuid: existing[0], pbxNativeTarget: existing[1] }
      : project.addTarget(TARGET, 'app_extension', TARGET, bundleIdentifier);
    const existingGroup = Object.entries(project.hash.project.objects.PBXGroup).find(
      ([key, value]) => !key.endsWith('_comment') && value.name?.replaceAll('"', '') === TARGET,
    );
    const group = existingGroup ? { uuid: existingGroup[0] } : project.addPbxGroup([], TARGET, TARGET);
    if (!existingGroup) project.addToPbxGroup(group.uuid, project.getFirstProject().firstProject.mainGroup);
    if (!existing) {
      project.addBuildPhase([], 'PBXSourcesBuildPhase', 'Sources', target.uuid);
      project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
      project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
    }
    // add*File ignores an existing reference, and adds newly introduced sources
    // even when the target already exists (prebuild without --clean).
    for (const source of [...sharedSources, 'ShareViewController.swift']) {
      project.addSourceFile(source, { target: target.uuid }, group.uuid);
    }
    for (const source of ['Info.plist', `${TARGET}.entitlements`]) {
      if (!project.hasFile(source)) project.addFile(source, group.uuid);
    }
    project.addResourceFile('PrivacyInfo.xcprivacy', { target: target.uuid }, group.uuid);
    // xcode 4 emits optional file attributes as the literal `undefined`.
    for (const file of Object.values(project.pbxFileReferenceSection())) {
      if (typeof file !== 'object') continue;
      for (const key of Object.keys(file)) if (file[key] === undefined) delete file[key];
    }
    // Embed before RN/CocoaPods resource scripts. Appending the extension after
    // those scripts can create an Xcode dependency cycle during code signing.
    const phases = appTarget.firstTarget.buildPhases;
    const copies = project.hash.project.objects.PBXCopyFilesBuildPhase;
    const builds = project.pbxBuildFileSection();
    const embedIndex = phases.findIndex(({ value }) => copies[value]?.files.some(
      ({ value }) => builds[value].fileRef === target.pbxNativeTarget.productReference,
    ));
    if (embedIndex >= 0) {
      const [embed] = phases.splice(embedIndex, 1);
      const resourcesIndex = phases.findIndex(({ value }) => project.hash.project.objects.PBXResourcesBuildPhase[value]);
      phases.splice(resourcesIndex + 1, 0, embed);
    }
    const appConfigurations = project.pbxXCConfigurationList()[appTarget.firstTarget.buildConfigurationList].buildConfigurations;
    const appSettings = project.pbxXCBuildConfigurationSection()[appConfigurations[0].value].buildSettings;
    const configurations = project.pbxXCConfigurationList()[target.pbxNativeTarget.buildConfigurationList].buildConfigurations;
    for (const { value } of configurations) {
      Object.assign(project.pbxXCBuildConfigurationSection()[value].buildSettings, {
        APPLICATION_EXTENSION_API_ONLY: 'YES',
        CODE_SIGN_ENTITLEMENTS: `"${TARGET}/${TARGET}.entitlements"`,
        CODE_SIGN_STYLE: 'Automatic',
        CURRENT_PROJECT_VERSION: mod.ios.buildNumber ?? '1',
        GENERATE_INFOPLIST_FILE: 'NO',
        INFOPLIST_FILE: `"${TARGET}/Info.plist"`,
        IPHONEOS_DEPLOYMENT_TARGET: appSettings.IPHONEOS_DEPLOYMENT_TARGET,
        MARKETING_VERSION: mod.version ?? '0.1.0',
        SWIFT_VERSION: '5.0',
        TARGETED_DEVICE_FAMILY: '"1,2"',
        ...(appSettings.DEVELOPMENT_TEAM ? { DEVELOPMENT_TEAM: appSettings.DEVELOPMENT_TEAM } : {}),
      });
    }
    return mod;
  });
};
