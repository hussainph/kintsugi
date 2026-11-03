import * as React from "react"
import { cn } from "cn"
import { type IconComponent } from "../../icons"

/**
 * A line in the conversation about the conversation itself: a reply that
 * failed, a model that stopped responding, a cap that's reached. Says what
 * happened, with at most a detail and an action or two.
 */
export function ChatNotice({ tone = "info", icon: Icon, title, detail, actions, className, ...props }: Omit<React.ComponentProps<"div">, "title"> & {
  tone?: "info" | "warning" | "error"
  icon?: IconComponent
  title: React.ReactNode
  detail?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div data-slot="chat-notice" data-tone={tone} role={tone === "error" ? "alert" : undefined} className={cn("ki-chat-notice", className)} {...props}>
      {Icon && <Icon className="ki-chat-notice-icon" aria-hidden />}
      <div className="ki-chat-notice-body">
        <p className="ki-chat-notice-title">{title}</p>
        {detail && <p className="ki-chat-notice-detail">{detail}</p>}
        {actions && <div className="ki-chat-notice-actions">{actions}</div>}
      </div>
    </div>
  )
}
