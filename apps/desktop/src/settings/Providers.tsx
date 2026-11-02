import { useEffect, useState } from "react";
import { toast } from "sonner";
import { credentialLabel, providers, shown, type ProviderStatus } from "@/lib/ai";
import { Group, Page, Row } from "./parts";

const PROBLEM: ProviderStatus["auth"][] = ["unsupported_login", "expired_login"];

/** Settings › Providers: where each provider's credential comes from, for
 *  the providers the default models use and any other with a credential. */
export function ProviderSettings() {
  const [list, setList] = useState<ProviderStatus[] | null>(null);

  useEffect(() => {
    providers().then(setList).catch((e) => toast.error(String(e)));
  }, []);

  return (
    <Page title="Providers">
      <Group data-testid="credentials">
        {list?.filter(shown).map((p) => (
          <Row key={p.id} label={p.name} data-provider={p.id}>
            <span className={PROBLEM.includes(p.auth) ? "ki-error ki-text-xs" : "ki-muted ki-text-xs"}>{credentialLabel(p)}</span>
          </Row>
        ))}
      </Group>
      <p className="ki-muted ki-text-xs">
        Log in or add keys with <code className="ki-data">opencode auth login</code>.
      </p>
    </Page>
  );
}
