import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = createRequire(resolve(here, '../../../desktop/package.json'));
const mobile = createRequire(resolve(here, '../../package.json'));
const { createServer } = await import(desktop.resolve('vite'));
const { default: react } = await import(desktop.resolve('@vitejs/plugin-react'));

export async function startAppearanceServer(port = 0) {
  const server = await createServer({
    configFile: false,
    root: here,
    cacheDir: resolve(here, '../../../../.headless/mobile-appearance-vite'),
    plugins: [react()],
    define: { __DEV__: 'true', 'process.env.NODE_ENV': JSON.stringify('development') },
    resolve: {
      dedupe: ['react', 'react-dom', '@codemirror/state', '@codemirror/view'],
      alias: [
        { find: /^react-native$/, replacement: resolve(here, 'native.jsx') },
        { find: /^expo-sqlite\/kv-store$/, replacement: resolve(here, 'storage.js') },
        { find: /^expo\/dom$/, replacement: resolve(dirname(mobile.resolve('expo/package.json')), 'build/dom/dom/dom.web.js') },
        { find: '@', replacement: resolve(here, '../../src') },
        { find: /^react$/, replacement: mobile.resolve('react') },
        { find: /^react-dom\/client$/, replacement: mobile.resolve('react-dom/client') },
        { find: /^react-dom$/, replacement: mobile.resolve('react-dom') },
      ],
    },
    server: { host: '127.0.0.1', port, fs: { allow: [resolve(here, '../../../..')] } },
  });
  await server.listen();
  return { server, url: server.resolvedUrls.local[0] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, url } = await startAppearanceServer(Number(process.env.PORT ?? 0));
  console.log(url);
  const stop = async () => { await server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
