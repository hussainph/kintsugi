import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { WritingList } from '@/components/WritingList';
import { baseName, linkedFilter } from '@/lib/browse';
import { library } from '@/lib/documents';

/** One folder of the vault, browsed on the phone's own copy, so it works
 *  without the Mac. The status and tag filters carry over from the list
 *  the owner came from. */
export default function FolderScreen() {
  const { path = '', ...params } = useLocalSearchParams<{ path: string; status?: string; tag?: string | string[] }>();
  const [query, setQuery] = useState('');
  return (
    <>
      <Stack.Title>{baseName(path) || library.vaultName || 'Kintsugi'}</Stack.Title>
      <Stack.SearchBar placeholder={`Find in ${baseName(path)}`} onChangeText={(e) => setQuery(e.nativeEvent.text)} />
      <WritingList dir={path} rootName={library.vaultName ?? 'Kintsugi'} query={query} empty="Nothing in this folder yet." linked={linkedFilter(params)} />
    </>
  );
}
