import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMarkdown } from '@kintsugi/core/markdown';

import { figureCaption, footnoteLink, itemExcerpt, readerDocument, readerUrl, summaryLabel, superscript } from './feed-reader.ts';

test('reader destinations allow only http(s) URLs', () => {
  for (const value of ['https://example.com/a#part', 'http://127.0.0.1:47475/figure.png', 'HTTPS://example.com']) assert.equal(readerUrl(value), new URL(value).href);
  for (const value of ['#anchor', '/local.png', '//example.com', 'javascript:alert(1)', 'data:image/png;base64,AA', 'file:///tmp/image.png', 'kintsugi://pair', 'mailto:me@example.com', 'https://', 'https://user:secret@example.com', 'https://example.com/\nnext', ' https://example.com']) assert.equal(readerUrl(value), null, value);
});

test('relative reader destinations use the article’s own web address, never its local route', () => {
  const base = 'https://example.com/posts/article';
  assert.equal(readerUrl('/images/bowl.png', base), 'https://example.com/images/bowl.png');
  assert.equal(readerUrl('../report', base), 'https://example.com/report');
  assert.equal(readerUrl('#fn:1', base), null);
  assert.equal(readerUrl('javascript:alert(1)', base), null);
  assert.equal(readerUrl('file:///tmp/image.png', base), null);
  assert.equal(readerUrl('image.png', 'file:///tmp/article.md'), null);
});

test('figures use captions, then meaningful alt text, without showing filenames', () => {
  assert.equal(figureCaption(' A view from the bridge ', 'bridge.jpg'), 'A view from the bridge');
  assert.equal(figureCaption(null, 'A child crossing a footbridge'), 'A child crossing a footbridge');
  for (const alt of ['', 'image', 'Photo 3', 'IMG_0123', 'DSC-0123.JPG', 'https://example.com/image']) assert.equal(figureCaption(null, alt), null);
});

test('ingested image paragraphs become figures with their short caption', () => {
  const doc = readerDocument('![A ledger](https://example.com/l.jpg)My ledger, the analogue version.');
  assert.deepEqual(doc.blocks, [{ t: 'figure', src: 'https://example.com/l.jpg', alt: 'A ledger', caption: 'My ledger, the analogue version.' }]);
  assert.equal(readerDocument(`![A ledger](https://example.com/l.jpg)${'x'.repeat(281)}`).blocks[0].t, 'p');
  assert.equal(readerDocument('Text before ![A ledger](https://example.com/l.jpg) caption.').blocks[0].t, 'p');
  assert.equal(readerDocument('![One](https://example.com/1.jpg) ![Two](https://example.com/2.jpg)').blocks[0].t, 'p');
  const titled = readerDocument('![A ledger](https://example.com/l.jpg "The original caption")More text.').blocks[0];
  assert.ok(titled.t === 'figure');
  assert.equal(titled.caption, 'The original caption');
});

test('the reader keeps raw footnotes, joins italic captions and removes only a repeated opening title', () => {
  const doc = readerDocument('# An article\n\nText.[^a]\n\n![A ledger](https://example.com/l.jpg)\n\n*The ledger after a year.*\n\n[^a]: Three days, between coats.\n  The last one took a week.', 'An article');
  assert.deepEqual(doc.blocks.map((b) => b.t), ['p', 'figure']);
  assert.equal(doc.notes[0].id, 'a');
  assert.deepEqual(doc.notes[0].content, [{ t: 'text', v: 'Three days, between coats. The last one took a week.' }]);
  const figure = doc.blocks[1];
  assert.ok(figure.t === 'figure');
  assert.equal(figure.caption, 'The ledger after a year.');
  assert.equal(readerDocument('# A different heading', 'An article').blocks[0].t, 'h');
});

test('ingested footnotes are non-link superscripts and return arrows disappear', () => {
  assert.equal(footnoteLink('#fn:1', '1'), 'ref');
  assert.equal(footnoteLink('#fn:12', ' 12 '), 'ref');
  assert.equal(footnoteLink('#fnref:1', '↩'), 'back');
  assert.equal(footnoteLink('#fnref:1', '↩\uFE0E'), 'back');
  assert.equal(footnoteLink('#section', 'Read this section'), null);
  assert.equal(footnoteLink('https://example.com/#1', '1'), null);
  assert.equal(footnoteLink('javascript:alert(1)', '1'), null);
  assert.equal(superscript('120'), '¹²⁰');
});

test('item previews prefer the author excerpt, including a deliberately empty one', () => {
  assert.equal(itemExcerpt({ excerpt: 'The first paragraph.', summary: 'Old preview.' }), 'The first paragraph.');
  assert.equal(itemExcerpt({ excerpt: '', summary: 'Old preview.' }), '');
  assert.equal(itemExcerpt({ summary: 'Older Mac preview.' }), 'Older Mac preview.');
  assert.equal(itemExcerpt({ excerpt: null, summary: null }), null);
});

test('only a non-null multi-source summary carries Kin’s mark', () => {
  assert.equal(summaryLabel(), undefined);
  assert.equal(summaryLabel({ summary: null, sources: [] }), undefined);
  const sources = [1, 2, 3].map((id) => ({ id, title: `Source ${id}`, kind: 'feed', site: null, items: 1 }));
  assert.equal(summaryLabel({ summary: { paragraphs: [] }, sources }), "Kin's summary of 3 sources");
});

test('the shared reader input preserves rich blocks and nested inline content', () => {
  const blocks = parseMarkdown(`## A heading

A paragraph with *emphasis*, **weight**, ~~a correction~~, \`code\`, [a link](https://example.com), and ![A small diagram](https://example.com/inline.png).

> A quotation.

3. First
   - Nested
4. Second

![A river](https://example.com/river.png "The river at dusk")

\`\`\`js
const longLine = 123;
\`\`\`

| Name | Value |
| --- | ---: |
| First | 1 |

---

<script>not a native view</script>`);
  assert.deepEqual(blocks.map((b) => b.t), ['h', 'p', 'quote', 'list', 'figure', 'code', 'table', 'hr']);
  const paragraph = blocks[1];
  assert.ok(paragraph.t === 'p');
  for (const type of ['em', 'strong', 'del', 'code', 'link', 'image']) assert.ok(paragraph.c.some((i) => i.t === type), type);
  const list = blocks[3];
  assert.ok(list.t === 'list');
  assert.equal(list.start, 3);
  assert.ok(list.items[0].c.some((b) => b.t === 'list'));
  assert.deepEqual(blocks[4], { t: 'figure', src: 'https://example.com/river.png', alt: 'A river', caption: 'The river at dusk' });
});

test('orphan and skip-level list items keep three levels in the phone reader', () => {
  for (const text of ['      - Only', '- Parent\n      - Child', '1. Parent\n       1. Child']) {
    const doc = readerDocument(text);
    let blocks = doc.blocks;
    let levels = 0;
    while (blocks.some((block) => block.t === 'list')) {
      const list = blocks.find((block) => block.t === 'list');
      assert.ok(list?.t === 'list');
      levels++;
      blocks = list.items[0].c;
      assert.ok(!blocks.some((block) => block.t === 'code'));
    }
    assert.equal(levels, 4, text);
    assert.ok(blocks.some((block) => block.t === 'p'));
  }
});
