import { plain, type Block, type Inline } from '@kintsugi/core/markdown';
import { createContext, Fragment, memo, useContext, useMemo, useState } from 'react';
import { Image, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';

import { figureCaption, footnoteLink, readerDocument, readerUrl, superscript, type ReaderDocument } from '@/lib/feed-reader';
import { fonts, useTheme } from '@/theme';

const DocumentContext = createContext<ReaderDocument & { base: string | null }>({ blocks: [], notes: [], base: null });

/** The same reading typography for an article and a story's lead article.
 * Markdown is parsed once; raw HTML never enters the native view tree. */
export const FeedReader = memo(function FeedReader({ text, title, base = null }: { text: string; title?: string | null; base?: string | null }) {
  const theme = useTheme();
  const doc = useMemo(() => readerDocument(text, title), [text, title]);
  const context = useMemo(() => ({ ...doc, base }), [doc, base]);
  return <DocumentContext value={context}><View style={styles.blocks} testID="feed-reader">
    <ReaderBlocks blocks={doc.blocks} />
    {doc.notes.length > 0 && <View accessibilityLabel="Footnotes" style={[styles.blocks, styles.notes, { borderColor: theme.border }]}>
      {doc.notes.map((note, i) => <View key={note.id} style={styles.listRow}>
        <Text style={[styles.body, styles.bullet, { color: theme.muted }]}>{`${i + 1}.`}</Text>
        <Text selectable style={[styles.body, styles.listContent, { color: theme.muted }]}><ReaderInlines content={note.content} /></Text>
      </View>)}
    </View>}
  </View></DocumentContext>;
});

function ReaderBlocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((block, i) => <ReaderBlock key={i} block={block} />);
}

function ReaderBlock({ block }: { block: Block }) {
  const theme = useTheme();
  switch (block.t) {
    case 'p':
      return <Text selectable style={[styles.body, { color: theme.text }]}><ReaderInlines content={block.c} /></Text>;
    case 'h':
      return <Text selectable accessibilityRole="header" style={[styles.heading, block.level === 1 ? styles.titleHeading : block.level === 2 ? styles.largeHeading : block.level === 3 ? styles.smallHeading : styles.bodyHeading, { color: theme.text }]}><ReaderInlines content={block.c} /></Text>;
    case 'quote':
    case 'callout':
      return <View style={[styles.quote, styles.blocks, { borderColor: theme.border }, block.t === 'callout' && { backgroundColor: theme.surface }]}><ReaderBlocks blocks={block.c} /></View>;
    case 'list':
      return <View style={styles.list}>{block.items.map((item, i) => (
        <View key={i} style={styles.listRow}>
          <Text style={[styles.body, styles.bullet, { color: theme.muted }]}>{item.task !== null ? (item.task ? '☑' : '☐') : block.ordered ? `${block.start + i}.` : '•'}</Text>
          <View style={[styles.listContent, styles.blocks]}><ReaderBlocks blocks={item.c} /></View>
        </View>
      ))}</View>;
    case 'code':
      return <View style={[styles.codeBlock, { backgroundColor: theme.surface }]}>
        {block.title && <Text style={[styles.caption, { color: theme.muted }]}>{block.title}</Text>}
        <ScrollView horizontal contentContainerStyle={styles.codeContent}>
          <Text selectable style={[styles.mono, { color: theme.text }]}>{block.v}</Text>
        </ScrollView>
      </View>;
    case 'hr':
      return <View style={[styles.rule, { backgroundColor: theme.border }]} />;
    case 'figure':
      return <ReaderFigure key={block.src} src={block.src} alt={block.alt} caption={block.caption} />;
    case 'table':
      return <ScrollView horizontal><View accessibilityRole="table">
        {[block.head, ...block.rows].map((row, r) => (
          <View key={r} style={styles.tableRow}>
            {row.map((cell, c) => <Text key={c} selectable style={[styles.body, styles.cell, { color: theme.text, borderColor: theme.border, textAlign: block.align[c] ?? 'left' }, r === 0 && { fontWeight: '600', backgroundColor: theme.surface }]}><ReaderInlines content={cell} /></Text>)}
          </View>
        ))}
      </View></ScrollView>;
  }
}

function ReaderInlines({ content }: { content: Inline[] }) {
  const theme = useTheme();
  const { base } = useContext(DocumentContext);
  return content.map((inline, i) => {
    switch (inline.t) {
      case 'text': return <ReaderText key={i} text={inline.v} />;
      case 'br': return <Fragment key={i}>{'\n'}</Fragment>;
      case 'code': return <Text key={i} style={[styles.inlineCode, { backgroundColor: theme.surface }]}>{inline.v}</Text>;
      case 'em': return <Text key={i} style={styles.em}><ReaderInlines content={inline.c} /></Text>;
      case 'strong': return <Text key={i} style={styles.strong}><ReaderInlines content={inline.c} /></Text>;
      case 'del': return <Text key={i} style={styles.del}><ReaderInlines content={inline.c} /></Text>;
      case 'link': {
        const note = footnoteLink(inline.href, plain(inline.c));
        if (note === 'back') return null;
        if (note === 'ref') return <FootnoteNumber key={i} number={plain(inline.c).trim()} />;
        const href = readerUrl(inline.href, base);
        return href ? <Text key={i} accessibilityRole="link" style={styles.link} onPress={() => { void Linking.openURL(href).catch(() => {}); }}><ReaderInlines content={inline.c} /></Text> : <ReaderInlines key={i} content={inline.c} />;
      }
      case 'image': return <InlineImage key={`${i}-${inline.src}`} image={inline} />;
    }
  });
}

function ReaderText({ text }: { text: string }) {
  const doc = useContext(DocumentContext);
  if (!doc.notes.length || !text.includes('[^')) return <>{text}</>;
  return text.split(/\[\^([^\]\s]+)\]/).map((part, i) => {
    if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
    const index = doc.notes.findIndex((note) => note.id === part);
    return index < 0 ? <Fragment key={i}>{`[^${part}]`}</Fragment> : <FootnoteNumber key={i} number={String(index + 1)} />;
  });
}

function FootnoteNumber({ number }: { number: string }) {
  const theme = useTheme();
  return <Text accessibilityLabel={`Footnote ${number}`} style={[styles.footnote, { color: theme.muted }]}>{superscript(number)}</Text>;
}

function InlineImage({ image }: { image: Extract<Inline, { t: 'image' }> }) {
  const [failed, setFailed] = useState(false);
  const { base } = useContext(DocumentContext);
  const uri = readerUrl(image.src, base);
  const caption = figureCaption(image.title, image.alt);
  return <Text>
    {uri && !failed && <Image source={{ uri }} accessibilityLabel={image.alt || undefined} resizeMode="contain" style={styles.inlineImage} onError={() => setFailed(true)} />}
    {caption && <Text style={styles.caption}>{` ${caption} `}</Text>}
  </Text>;
}

function ReaderFigure({ src, alt, caption }: { src: string; alt: string; caption: string | null }) {
  const theme = useTheme();
  const [ratio, setRatio] = useState(3 / 2);
  const [failed, setFailed] = useState(false);
  const { base } = useContext(DocumentContext);
  const uri = readerUrl(src, base);
  const label = figureCaption(caption, alt);
  if ((!uri || failed) && !label) return null;
  return <View style={styles.figure}>
    {uri && !failed && <Image source={{ uri }} accessibilityLabel={alt || undefined} resizeMode="contain" style={[styles.figureImage, { aspectRatio: ratio }]} onError={() => setFailed(true)} onLoad={({ nativeEvent: { source } }) => { if (source.width > 0 && source.height > 0) setRatio(source.width / source.height); }} />}
    {label && <Text selectable style={[styles.caption, { color: theme.muted }]}>{label}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  blocks: { gap: 16 },
  body: { fontFamily: fonts.serif, fontSize: 18, lineHeight: 28 },
  heading: { fontFamily: fonts.serif, fontWeight: '600', marginTop: 8 },
  titleHeading: { fontSize: 28, lineHeight: 34 },
  largeHeading: { fontSize: 25, lineHeight: 32 },
  smallHeading: { fontSize: 20, lineHeight: 28 },
  bodyHeading: { fontSize: 18, lineHeight: 28 },
  quote: { borderLeftWidth: 2, paddingLeft: 16, paddingVertical: 8, paddingRight: 8 },
  list: { gap: 8 },
  listRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  bullet: { minWidth: 20, textAlign: 'right' },
  listContent: { flex: 1, minWidth: 0, gap: 8 },
  mono: { fontFamily: fonts.mono, fontSize: 15, lineHeight: 22 },
  inlineCode: { fontFamily: fonts.mono, fontSize: 16 },
  codeBlock: { borderRadius: 8, padding: 12, gap: 8 },
  codeContent: { paddingBottom: 4 },
  caption: { fontSize: 13, lineHeight: 19 },
  footnote: { fontSize: 13, lineHeight: 18 },
  notes: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 16, marginTop: 8 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 8 },
  figure: { gap: 8 },
  figureImage: { width: '100%' },
  inlineImage: { width: 120, height: 80 },
  tableRow: { flexDirection: 'row' },
  cell: { width: 160, padding: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  em: { fontStyle: 'italic' },
  strong: { fontWeight: '700' },
  del: { textDecorationLine: 'line-through' },
  link: { textDecorationLine: 'underline' },
});
