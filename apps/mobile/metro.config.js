// Learn more https://docs.expo.io/guides/customizing-metro
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Workspace packages (packages/editor) carry their own React devDependency,
// which pnpm may resolve to a different patch than the app's. Two Reacts in
// one bundle break hooks, so every import of these resolves from the app.
const singletons = new Set(['react', 'react-dom']);
const fromApp = path.join(__dirname, 'package.json');
const upstream = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const name = moduleName.startsWith('@') ? moduleName.split('/').slice(0, 2).join('/') : moduleName.split('/')[0];
  const resolve = upstream ?? context.resolveRequest;
  if (singletons.has(name)) return resolve({ ...context, originModulePath: fromApp }, moduleName, platform);
  return resolve(context, moduleName, platform);
};

module.exports = config;
