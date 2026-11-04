import { useRef, useState, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { alternativePanelCommands, type alternativesPanelModel } from "@kintsugi/editor/alternatives";
import { Button } from "@kintsugi/ui/components/button";
import { KinAvatar } from "@/kin/Avatar";
import { matches } from "@/lib/keys";
import "./versions.css";

type Model = ReturnType<typeof alternativesPanelModel>;
type Props = { model: Model; viewRef: RefObject<EditorView | null>; onAsk: () => void };
const names = { word: "Word", phrase: "Selection", sentence: "Sentence", paragraph: "Paragraph" };

/** Versions use the editor's model and commands; the margin owns no copies. */
export function Versions({ model, viewRef, onAsk }: Props) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const actions = () => viewRef.current && alternativePanelCommands(viewRef.current);
  const hasSpan = model?.entries.some((entry) => entry.text.trim());
  return <section className={model ? "ki-versions cm-alt-panel" : "ki-versions"} aria-label="Versions" onKeyDown={(event) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    const command = actions();
    if (!command) return;
    const key = event.nativeEvent;
    let run: (() => void) | undefined;
    if (matches(key, "Mod-Alt-]")) run = () => command.cycle(1);
    else if (matches(key, "Mod-Alt-[")) run = () => command.cycle(-1);
    else if (matches(key, "Mod-Shift-Alt-a")) run = command.askKin;
    else if (matches(key, "Mod-Alt-a") || event.key === "Escape") run = command.close;
    if (run) { event.preventDefault(); event.stopPropagation(); run(); }
  }}>
    <div className="ki-versions-heading"><h2>Versions</h2><div role="tablist" aria-label="Version span">
      {([model?.levels.includes("phrase") ? "phrase" : "word", "sentence", "paragraph"] as const).map((level) => <button key={level} type="button" role="tab" aria-selected={model?.level === level} disabled={!model?.levels.includes(level)} onMouseDown={(event) => event.preventDefault()} onClick={() => actions()?.level(level)}>{names[level]}</button>)}
    </div></div>
    {model && <><ul role="listbox" aria-label="Versions" aria-busy={model.asking} className="cm-alt-list">{model.entries.map((entry, index) => entry.text.trim() ? <li key={index} role="option" aria-label={entry.by === "kin" ? `Kin: ${entry.text}` : undefined} aria-selected={model.highlight === index} aria-current={entry.current || undefined} data-by={entry.by} className="cm-alt-option" onMouseDown={(event) => event.preventDefault()} onClick={() => actions()?.pick(index)}>
      <span className="ki-version-mark" aria-hidden>{entry.by === "kin" ? <KinAvatar /> : <span data-current={entry.current} />}</span><span className="cm-alt-option-text">{entry.text}</span>
    </li> : null)}</ul><div className="ki-versions-add">
      <input ref={input} aria-label="Add a version" placeholder="Add a version" value={text} disabled={model.readOnly || !hasSpan} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        const command = actions();
        if (!command) return;
        if (event.key === "Enter") { event.preventDefault(); if (text.trim()) { command.add(text.trim()); setText(""); } else command.pick(model.highlight); }
        else if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); command.move(event.key === "ArrowDown" ? 1 : -1); }
        else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !text && !event.altKey && !event.metaKey) {
          const level = model.levels[model.levels.indexOf(model.level) + (event.key === "ArrowRight" ? 1 : -1)];
          if (level) { event.preventDefault(); command.level(level); }
        }
        else if (event.key === "Backspace" && !text) { event.preventDefault(); command.remove(model.highlight); }
      }} />
      <Button variant="ghost" size="xs" disabled={model.readOnly || !model.canAsk || model.asking} onClick={onAsk}>{model.asking ? "Thinking…" : "Ask Kin"}</Button>
    </div>{model.askError && <p role="alert" className="ki-error">{model.askError}</p>}</>}
  </section>;
}
