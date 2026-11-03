import { useEffect, useState } from "react";
import { toast } from "sonner";
import { effortLevels, modelInfo, models as listModels, type ModelRef, type ProviderModels, type ThinkingLevel } from "@/lib/ai";
import { kin, type ChatModel } from "@/lib/kin";
import { Effort } from "./Effort";
import { ModelMenu } from "./ModelMenu";

type Props = {
  /** The conversation it applies to: a thread's key, "" for general. */
  conversation: string;
  /** Bumped when another vault opens: its conversations have their own picks. */
  vault: number;
  /** "Choose models" opens Settings; the chat gets out of the way. */
  onManage: () => void;
};

/**
 * The chat composer's model and effort for one conversation (KI-61,
 * KI-77): the models turned on in Settings, and how hard the one in use
 * thinks. Loads and saves its own state; mounted while the chat is open.
 */
export function ChatModelPicker({ conversation, vault, onManage }: Props) {
  const [providers, setProviders] = useState<ProviderModels[] | null>(null);
  const [enabled, setEnabled] = useState<ModelRef[] | null>(null);
  const [model, setModel] = useState<ChatModel | null>(null);

  useEffect(() => {
    listModels().then(setProviders).catch(() => setProviders([]));
    kin.settings().then((s) => setEnabled(s.enabled)).catch(() => setEnabled([]));
  }, []);
  useEffect(() => {
    let current = true;
    kin.chatModel(conversation).then((m) => current && setModel(m)).catch(() => current && setModel(null));
    return () => {
      current = false;
    };
  }, [conversation, vault]);

  const save = async (change: Promise<ChatModel>) => {
    try {
      setModel(await change);
    } catch (e) {
      toast.error(String(e));
    }
  };
  const resolved = model?.resolved ?? null;
  const levels = effortLevels(modelInfo(providers, resolved));

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
