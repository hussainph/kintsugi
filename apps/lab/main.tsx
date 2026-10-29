// Install the fail-closed bridge before evaluating any product module.
import { installLabBridge } from "./bridge/install";
import "./styles.css";
installLabBridge();
void import("./mount").catch((error: unknown) => {
  console.error(error);
  const root = document.getElementById("root");
  if (root) {
    root.setAttribute("role", "alert");
    root.textContent = `Lab failed to boot: ${String(error)}`;
  }
});
