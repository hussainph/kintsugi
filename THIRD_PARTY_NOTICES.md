# Third-party notices

Third-party assets that ship inside the Kintsugi apps, with their licenses.
Fonts are listed in `packages/ui/src/fonts/README.md`; their full license
texts sit next to the font files and in `apps/desktop/public/font-licenses/`.

## Hugeicons (free, stroke-rounded)

- Packages: `@hugeicons/core-free-icons` 4.x (icon artwork) and
  `@hugeicons/react` 1.x (the React renderer), used by `@kintsugi/ui` and the
  Mac app through `@kintsugi/ui/icons`.
- Source: https://hugeicons.com, https://github.com/hugeicons
- License: MIT. Only the free set is used; no Hugeicons Pro artwork is
  included.

```text
MIT License

Copyright (c) 2025 Hugeicons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## potion-base-8M (search embedding model)

- What: the model search uses to find things by meaning
  ([search.md](docs/search.md)). Ships inside the Mac app as
  `Contents/Resources/search-model/`, from
  `apps/desktop/src-tauri/resources/search-model/`.
- Source: [minishlab/potion-base-8M](https://huggingface.co/minishlab/potion-base-8M),
  revision `bf8b056651a2c21b8d2565580b8569da283cab23`, by Minish Lab
  (Stephan Tulkens and Thomas van Dongen), distilled from
  [BAAI/bge-base-en-v1.5](https://huggingface.co/BAAI/bge-base-en-v1.5) (MIT).
  `config.json`, `tokenizer.json` and `model.safetensors` are unchanged and
  checked against pinned hashes when the app loads them.
- License: MIT (the model card's license; Model2Vec's own license text
  below). It allows redistribution with this notice, which also ships beside
  the model as `LICENSE`.

```text
MIT License

Copyright (c) 2024 Thomas van Dongen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Defuddle (page extraction)

- What: reads the main text of a web page the readability pass can't
  ([ingest.md](docs/ingest.md)). Vendored in
  `crates/ingest/vendor/defuddle/` and compiled into the app.
- Source: https://github.com/kepano/defuddle
- License: MIT, `crates/ingest/vendor/defuddle/LICENSE`.
