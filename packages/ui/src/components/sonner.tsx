import { useGraphicalTheme } from "../../components/graphical"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "@kintsugi/ui/icons"
import { usePartStyle } from "./graphical"
import type { CSSProperties } from "react"

function textVariables(prefix: string, style: CSSProperties): CSSProperties {
  return Object.fromEntries(Object.entries(style).filter(([name]) => name.startsWith("--ui-")).map(([name, value]) => [name.replace("--ui-", `--ki-${prefix}-`), value]))
}

// Keep Sonner's existing toast() manager, actions, swipe, timing and live-region
// behavior. Only its surfaces and text parts use the supplied Toast resolver.
const Toaster = ({ toastOptions, icons, style, ...props }: ToasterProps) => {
  const { colorMode } = useGraphicalTheme()
  const surface = usePartStyle("toast", "popover")
  const title = usePartStyle("toast", "title")
  const description = usePartStyle("toast", "description")
  const action = usePartStyle("toast", "action")
  const close = usePartStyle("toast", "close")
  return (
    <Sonner
      theme={colorMode}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-[1em]" />,
        info: <InfoIcon className="size-[1em]" />,
        warning: <TriangleAlertIcon className="size-[1em]" />,
        error: <OctagonXIcon className="size-[1em]" />,
        loading: <Loader2Icon className="ki-toast-spinner size-[1em]" />,
        ...icons,
      }}
      style={{
        ...surface,
        ...textVariables("toast-title", title),
        ...textVariables("toast-description", description),
        ...textVariables("toast-close", close),
        ...style,
      }}
      toastOptions={{
        ...toastOptions,
        unstyled: toastOptions?.unstyled ?? true,
        style: { ...surface, transitionDuration: "var(--motion-large-duration)", transitionTimingFunction: "var(--motion-large-easing)", ...toastOptions?.style },
        actionButtonStyle: { ...action, ...toastOptions?.actionButtonStyle },
        cancelButtonStyle: { ...close, ...toastOptions?.cancelButtonStyle },
        classNames: {
          ...toastOptions?.classNames,
          toast: `ui-part ki-toast ${toastOptions?.classNames?.toast ?? ""}`,
          title: `ki-toast-title ${toastOptions?.classNames?.title ?? ""}`,
          description: `ki-toast-description ${toastOptions?.classNames?.description ?? ""}`,
          actionButton: `ui-part ui-button ${toastOptions?.classNames?.actionButton ?? ""}`,
          cancelButton: `ui-part ui-button ${toastOptions?.classNames?.cancelButton ?? ""}`,
          closeButton: `ki-toast-close ${toastOptions?.classNames?.closeButton ?? ""}`,
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
