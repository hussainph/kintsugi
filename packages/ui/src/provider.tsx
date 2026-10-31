import { useEffect, useState, type ReactNode } from "react";
import {
  GraphicalProvider,
  IconRendererProvider,
  createHugeiconsRenderer,
  theme,
  type ColorMode,
} from "../components/graphical";
import { HugeiconsIcon } from "@hugeicons/react";
import { TooltipProvider } from "./components/tooltip";

// The selected free pack contains stroke-rounded artwork. Catalog and adapter
// are loaded only when the captured theme requests Hugeicons; successful loads
// are cached by the bundled renderer. Never silently fall back to Lucide.
const { renderIcon } = createHugeiconsRenderer({
  loadCatalog: async (variant) => {
    if (variant !== "stroke-rounded") {
      throw new Error(`The free icon setup does not supply ${variant}`);
    }
    return import("./hugeicons-catalog");
  },
  renderGlyph: (icon, { strokeWidth: _strokeWidth, ...svgProps }) => (
    <HugeiconsIcon icon={icon} strokeWidth={1.5} {...svgProps} />
  ),
});

/** Follow the host's actual .dark state (including live system/preview changes). */
export function useColorMode(): ColorMode {
  const readMode = (): ColorMode =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
  const [mode, setMode] = useState(readMode);
  useEffect(() => {
    const observer = new MutationObserver(() => setMode(readMode()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    setMode(readMode());
    return () => observer.disconnect();
  }, []);
  return mode;
}

export function KintsugiProvider({ children, colorMode }: {
  children: ReactNode;
  colorMode?: ColorMode;
}) {
  const actualMode = useColorMode();
  return (
    <IconRendererProvider renderIcon={renderIcon}>
      <GraphicalProvider document={theme} colorMode={colorMode ?? actualMode}>
        <TooltipProvider>{children}</TooltipProvider>
      </GraphicalProvider>
    </IconRendererProvider>
  );
}
