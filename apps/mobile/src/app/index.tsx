import { Home } from '@/components/Home';
import { Welcome } from '@/components/Welcome';
import { usePairing } from '@/lib/pairing';

export default function Index() {
  const { client } = usePairing();
  return client ? <Home client={client} /> : <Welcome />;
}
