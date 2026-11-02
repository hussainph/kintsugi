import { SECTIONS_API, Unpaired } from '@kintsugi/core/remote';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshControl, ScrollView } from 'react-native';

import { Ledger } from '@/components/ideas/Ledger';
import type { IdeasModel } from '@/components/ideas/parts';
import { useSendWhenWaiting } from '@/components/Toast';
import { groupIdeas, type LocalIdea } from '@/lib/ideas';
import { usePairing } from '@/lib/pairing';
import { useScreenContext } from '@/lib/screen-context';
import { ideas, OLD_MAC, syncSection, useIdeas, useMacApi } from '@/lib/sections-store';
import { useTheme } from '@/theme';

/** How often the list asks the Mac while Kin is making ideas. */
const MAKING_POLL = 3_000;

/** Ideas on the phone: Kin's ideas from the Mac, kept to read offline.
 *  Adopt makes a new draft on the Mac (and brings it here), Dismiss is a
 *  signal, and Ask for more asks Kin, on the Mac, for a few on demand. */
export default function IdeasScreen() {
  const theme = useTheme();
  const { client, unpair } = usePairing();
  const snapshot = useIdeas();
  const api = useMacApi();
  const [open, setOpen] = useState<string | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const opening = useRef<string | null>(null);
  const opened = snapshot.ideas.find((i) => i.id === open);
  useScreenContext(opened ? [{ kind: 'idea', path: opened.id, label: opened.title }] : null);

  const load = useCallback(async () => {
    if (!client) return;
    try {
      await syncSection(client, 'ideas');
    } catch (e) {
      if (e instanceof Unpaired) unpair();
    }
  }, [client, unpair]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  useSendWhenWaiting(snapshot.waiting, load);
  // While Kin works on a batch, look again every few seconds.
  const making = snapshot.making && snapshot.connection !== 'offline';
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => void load(), MAKING_POLL);
    return () => clearInterval(timer);
  }, [making, load]);

  const openPath = useCallback((path: string) => {
    if (path.startsWith('inspiration/')) router.push({ pathname: '/clip', params: { path } });
    else router.push({ pathname: '/doc', params: { path } });
  }, []);

  const model: IdeasModel = useMemo(
    () => ({
      snapshot,
      groups: groupIdeas(snapshot.ideas, keep),
      open,
      toggle: (id) => setOpen(open === id ? null : id),
      adopt: (idea: LocalIdea) => {
        opening.current = idea.id;
        ideas.adopt(idea.id);
      },
      discuss: (idea: LocalIdea) => {
        ideas.discussed(idea.id);
        router.push({ pathname: '/kin', params: { chips: JSON.stringify([{ kind: 'idea', path: idea.id, label: idea.title }]) } });
      },
      dismiss: (idea: LocalIdea, undo = false) => {
        ideas.dismiss(idea.id, undo);
        setKeep(new Set([...keep, idea.id]));
        if (open === idea.id) setOpen(null);
      },
      more: () => ideas.more(),
      openDraft: openPath,
    }),
    [snapshot, keep, open, openPath],
  );

  // The draft an Adopt made here opens once it has reached the phone.
  useEffect(() => {
    const id = opening.current;
    const path = id && snapshot.adopted[id];
    if (path) {
      opening.current = null;
      openPath(path);
    }
  }, [snapshot.adopted, openPath]);

  const status =
    api > 0 && api < SECTIONS_API
      ? OLD_MAC
      : snapshot.connection === 'offline'
        ? `Your Mac is offline${snapshot.waiting ? '. Your changes are waiting' : ''}.`
        : snapshot.problem;

  return (
    <>
      <Stack.Title large>Ideas</Stack.Title>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
      >
        <Ledger model={model} status={status} />
      </ScrollView>
    </>
  );
}
