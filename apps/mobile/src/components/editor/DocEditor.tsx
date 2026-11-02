import { useFocusEffect, useNavigation } from 'expo-router';
import { type ComponentRef, useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { editorSessions } from '@/lib/editor-session';
import { fonts, useTheme } from '@/theme';

type Props = {
  /** Stable for the screen (its first path), so a renamed note keeps its state. */
  docKey: string;
  /** The writing as the phone's copy has it now, without frontmatter. */
  body: string;
  /** Start typing straight away (a new, empty note). */
  focus: boolean;
  /** The editor's text, with the text it was based on (see Library.edit). */
  write: (text: string, seen: string) => void;
};

// Enough to fill the screen while the editor isn't laid over it yet.
const PREVIEW = 3000;

/** The doc screen's part of the shared editor (KI-36): it reserves the space,
 *  says when the editor may show (after the push animation, hidden while
 *  swiping back), and passes text both ways. Underneath is a plain preview
 *  of the text, so the screen is never empty while it slides in or out. */
export function DocEditor({ docKey, body, focus, write }: Props) {
  const theme = useTheme();
  const navigation = useNavigation();
  const slot = useRef<ComponentRef<typeof View>>(null);
  // Once the editor covers the slot the preview goes, or it would show
  // below the editor when the keyboard shrinks it.
  const covered = useSyncExternalStore(editorSessions.subscribe, () => {
    const state = editorSessions.getSnapshot();
    return state.visible && state.session?.key === docKey && state.shown === docKey;
  });
  // What the editor holds: what it last wrote, or was last sent.
  const held = useRef(body);
  const writeRef = useRef(write);
  useEffect(() => {
    writeRef.current = write;
  });
  const bodyRef = useRef(body);
  useEffect(() => {
    bodyRef.current = body;
  });

  const measure = useCallback(
    (then?: () => void) => {
      slot.current?.measureInWindow((x, y, width, height) => {
        if (width && height) editorSessions.setSlot(docKey, { x, y, width, height });
        then?.();
      });
    },
    [docKey],
  );

  // Measured once the screen has stopped moving, so the editor appears in place.
  const show = useCallback(() => measure(() => editorSessions.setVisible(docKey, true)), [docKey, measure]);

  // This screen has the editor while it's on top: on opening, and again when
  // coming back from a linked document.
  useFocusEffect(
    useCallback(() => {
      held.current = bodyRef.current;
      editorSessions.open({ key: docKey, text: bodyRef.current, focus: focus && !bodyRef.current.trim() }, (text, seen) => {
        held.current = text;
        writeRef.current(text, seen);
      });
      // In case no transition event comes (opening at launch).
      const fallback = setTimeout(show, 600);
      return () => clearTimeout(fallback);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- `focus` only matters on opening
    }, [docKey, show]),
  );

  useEffect(() => {
    const subs = [
      navigation.addListener('transitionEnd' as never, (e: { data: { closing: boolean } }) => {
        if (!e.data.closing) show();
      }),
      navigation.addListener('transitionStart' as never, (e: { data: { closing: boolean } }) => {
        if (e.data.closing) editorSessions.setVisible(docKey, false);
      }),
      navigation.addListener('gestureCancel' as never, show),
      navigation.addListener('blur', () => editorSessions.setVisible(docKey, false)),
    ];
    return () => {
      subs.forEach((unsubscribe) => unsubscribe());
      editorSessions.close(docKey);
    };
  }, [docKey, navigation, show]);

  // Changed here other than by typing: sync, a merge, a conflict choice.
  useEffect(() => {
    if (body === held.current) return;
    held.current = body;
    editorSessions.external(docKey, body);
  }, [body, docKey]);

  return (
    <View ref={slot} style={styles.slot} onLayout={() => measure()} collapsable={false}>
      {!covered && (
        <Text style={[styles.preview, { color: theme.text }]} numberOfLines={60}>
          {body.slice(0, PREVIEW)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: { flex: 1, overflow: 'hidden' },
  preview: { fontFamily: fonts.serif, fontSize: 19, lineHeight: 29, paddingHorizontal: 20, paddingTop: 12 },
});
