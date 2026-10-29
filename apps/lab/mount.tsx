import { createRoot } from "react-dom/client";
import { Shell } from "@kintsugi/lab/shell";
import { Preview } from "@kintsugi/lab/preview";
import { dialkitAdapter } from "@kintsugi/lab/adapters/dialkit";
import { agentationAdapter } from "@kintsugi/lab/adapters/agentation";
import { Toaster } from "sonner";
import { entries } from "./registry";

const preview = new URLSearchParams(location.search).get("preview");
const entry = preview
  ? entries.find((entry) => entry.meta.id === preview)
  : undefined;
if (preview && !entry) throw new Error(`Unknown Lab entry: ${preview}`);
document.body.classList.toggle("is-lab-preview", !!preview);
const root = document.getElementById("root");
if (!root) throw new Error("Lab root missing");
createRoot(root).render(
  entry ? (
    <>
      <Preview
        entry={entry}
        storyId={
          new URLSearchParams(location.search).get("story") ??
          entry.stories[0].id
        }
      />
      <Toaster />
    </>
  ) : (
    <Shell
      entries={entries}
      title="Kintsugi Lab"
      projectName="Kintsugi"
      mark={
        <>
          k<span>✳</span>
        </>
      }
      subtitle="A living collection of the pieces that make writing feel good."
      controls={dialkitAdapter}
      critique={agentationAdapter}
    />
  ),
);
