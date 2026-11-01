import { useLocalSearchParams } from 'expo-router';

import { Home } from '@/components/Home';
import { Welcome } from '@/components/Welcome';
import { linkedFilter } from '@/lib/browse';
import { usePairing } from '@/lib/pairing';

export default function Index() {
  const { client } = usePairing();
  // `kintsugi://?status=draft&tag=craft` opens the list filtered.
  const params = useLocalSearchParams<{ status?: string; tag?: string | string[] }>();
  return client ? <Home client={client} linked={linkedFilter(params)} /> : <Welcome />;
}
