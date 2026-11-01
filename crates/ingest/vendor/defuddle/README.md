# Defuddle (vendored)

`defuddle.full.js` is `dist/index.full.js` from the npm package
[`defuddle`](https://github.com/kepano/defuddle) **0.19.6** (MIT, see
`LICENSE`), unmodified. It is the UMD "full" bundle, which includes Markdown
conversion. SHA-256:
`3143d808ce2e7dd22b46d63eb9a71d4b920f55feba78aa3c195dce75b276df60`.

The ingest crate embeds it (`include_str!`) and the desktop app evaluates it
inside a hidden, throwaway webview for pages that need JavaScript (see
`src/web/render.rs`). It is never loaded from a CDN, and it runs with
`useAsync: false`, so it makes no requests of its own.

To update: `npm pack defuddle@<version>` into a scratch folder, copy
`package/dist/index.full.js` here as `defuddle.full.js` and `package/LICENSE`
as `LICENSE`, and update the version and checksum above.
