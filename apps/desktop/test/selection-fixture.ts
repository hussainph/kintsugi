// Shared phone editor styling without the Expo/native bridge. `native` omits
// drawSelection to exercise the ::selection path used for iOS's main range.
import { drawSelection, EditorView } from "@codemirror/view";
import { theme } from "@kintsugi/editor/theme";
import "../../mobile/src/components/editor/phone.css";

const native = new URLSearchParams(location.search).has("native");
const host = document.getElementById("root")!;
host.className = "phone-editor";
const view = new EditorView({
  parent: host,
  doc: "A selection should be easy to see, with every word still readable.",
  extensions: [theme, EditorView.lineWrapping, ...(native ? [] : [drawSelection()])],
});
view.dispatch({ selection: { anchor: 2, head: view.state.doc.length } });
view.focus();
