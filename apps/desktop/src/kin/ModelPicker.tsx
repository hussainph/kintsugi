import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { effortLevels, modelInfo, models as listModels, sameEntry, shown, type ModelRef, type ProviderModels, type ThinkingLevel } from "@/lib/ai";
import { kin, type ChatModel } from "@/lib/kin";
import { Effort } from "./Effort";
import { ModelMenu } from "./ModelMenu";
import type { Chip } from "@/lib/chips";
import { imageModelWarning } from "./attachments";

type Props = {
  /** The conversation it applies to: a thread's key, "" for general. */
  conversation: string;
  /** Bumped when another vault opens: its conversations have their own picks. */
  vault: number;
  /** "Choose models" opens Settings; the chat gets out of the way. */
  onManage: () => void;
  chips?: Chip[];
  onAttachmentWarning?: (warning: string | null) => void;
};

/**
 * The chat composer's model and effort for one conversation (KI-61,
 * KI-77): the models turned on in Settings, and how hard the one in use
 * thinks. Loads and saves its own state; mounted while the chat is open.
 */
export function ChatModelPicker({ conversation, vault, onManage, chips = [], onAttachmentWarning }: Props) {
  const [providers, setProviders] = useState<ProviderModels[] | null>(null);
  const [enabled, setEnabled] = useState<ModelRef[] | null>(null);
  const scope = JSON.stringify([vault, conversation]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [loaded, setLoaded] = useState<{ scope: string; model: ChatModel } | null>(null);
  const model = loaded?.scope === scope ? loaded.model : null;

  useEffect(() => {
    listModels().then(setProviders).catch(() => setProviders([]));
    kin.settings().then((s) => setEnabled(s.enabled)).catch(() => setEnabled([]));
  }, []);
  useEffect(() => {
    let current = true;
    kin.chatModel(conversation).then((model) => current && setLoaded({ scope, model })).catch(() => current && setLoaded(null));
    return () => {
      current = false;
    };
  }, [conversation, scope]);

  const save = async (change: Promise<ChatModel>) => {
    try {
      const model = await change;
      if (currentScope.current === scope) setLoaded({ scope, model });
    } catch (e) {
      if (currentScope.current === scope) toast.error(String(e));
    }
  };
  const resolved = model?.resolved ?? null;
  const info = modelInfo(providers, resolved);
  const levels = effortLevels(info);
  const warning = imageModelWarning(chips, info?.images, (providers ?? []).filter(shown).flatMap((provider) => provider.models.map((candidate) => ({
    name: candidate.name,
    images: candidate.images,
    usable: provider.usable,
    enabled: !!enabled?.some((entry) => sameEntry(entry, { provider: provider.id, model: candidate.id })),
  }))));
  useEffect(() => { onAttachmentWarning?.(warning); }, [warning, onAttachmentWarning]);

  return (
    <div className="ki-model-picker" data-testid="chat-model">
      <ModelMenu
        look="compact"
        providers={providers}
        enabled={enabled}
        chosen={model?.chosen ?? null}
        current={resolved}
        onChange={(next) => void save(kin.setChatModel(conversation, next))}
        label="Model"
        automatic="Default"
        onManage={onManage}
        disabled={!model}
      />
      <Effort
        levels={levels}
        value={resolved?.reasoning as ThinkingLevel | undefined}
        onChange={(level) => void save(kin.setChatEffort(conversation, level))}
        label="Effort"
        disabled={!model}
      />
    </div>
  );
}
