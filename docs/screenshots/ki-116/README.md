# Kin attachments (KI-116)

Captured headlessly on a seeded scratch vault. No owner documents or credentials
appear in these images.

- `composer.png`: pasted and dropped images, a text file and removable previews.
- `sent.png`: saved chips and the scripted model's image acknowledgement.
- `restarted.png`: the same thread after a backend restart; Kin reads its earlier image by reference.
- `nonvision.png`: a text-only model's one-line warning and an image-capable alternative.
- `vision.png`: Qwen3.7 Plus reads the document heading from a pasted screenshot,
  with `KINTSUGI_HEADLESS_AI_READONLY=1`, no document chip and no tools.

The composer uses the existing Button, PromptInput and chip styles. The
thumbnail adds no new theme values. Light and dark modes were inspected;
fonts and Hugeicons are unchanged.

Checks:

- `pnpm lint:copy`, `pnpm typecheck`, `pnpm test`.
- `cargo test -p kintsugi --no-default-features --features headless -j "$VOLLI_CONCURRENCY_HINT" attachment --lib`: 19 passed.
- `pnpm --filter @kintsugi/desktop exec node --test test/runtime-attachments.test.ts`: two passed.
- `swift scripts/check-headless-macos.swift <backend-pid>`: zero native windows,
  no Dock app, no focus activation.

`apps/desktop/test/runtime-attachments.test.ts` drives paste, drop, file input,
PDF and text attachments, a backend restart and a later image read. The
macOS Rust tests exercise PDFKit extraction, HEIC conversion and EXIF orientation.
