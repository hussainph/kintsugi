import * as React from "react"
import { cn } from "cn"
import { ArrowDown } from "../../icons"
import { Button } from "../button"

/**
 * A chat's scrolling log, after AI Elements' Conversation: it follows new
 * content while the reader is at the bottom, stays put when they've scrolled
 * up to read, and offers a button back to the latest. Placement-agnostic:
 * it fills whatever column it's given.
 */

type Stick = {
  /** The reader is at (or near) the bottom. */
  atBottom: boolean
  scrollToBottom: (behavior?: ScrollBehavior) => void
  scroller: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
}

const StickContext = React.createContext<Stick | null>(null)

/** How close to the bottom still counts as "at the bottom". */
const SLACK = 48

export function useConversation() {
  const stick = React.useContext(StickContext)
  if (!stick) throw new Error("useConversation needs a <Conversation>")
  return stick
}

type ConversationProps = React.ComponentProps<"div"> & {
  /** Changing it (another thread) jumps to the bottom and follows again. */
  resetKey?: unknown
}

export function Conversation({ className, children, resetKey, ...props }: ConversationProps) {
  const scroller = React.useRef<HTMLDivElement | null>(null)
  const [atBottom, setAtBottom] = React.useState(true)
  const following = React.useRef(true)

  /** A smooth scroll down is under way: its scroll events aren't his. */
  const settling = React.useRef(false)

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scroller.current
    if (!el) return
    following.current = true
    settling.current = behavior === "smooth"
    setAtBottom(true)
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  // Content growing (a streamed word, a new message, a step) keeps the
  // bottom in view only while he's following.
  React.useLayoutEffect(() => {
    const el = scroller.current
    const content = el?.firstElementChild
    if (!el || !content) return
    const observer = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight
    })
    observer.observe(content)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  React.useLayoutEffect(() => {
    scrollToBottom()
  }, [resetKey, scrollToBottom])

  const lastTop = React.useRef(0)
  const onScroll = React.useCallback(() => {
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight <= SLACK
    // Only scrolling up leaves the bottom: content changing under a reader
    // who's following (a reply replacing its live turn) doesn't.
    const up = el.scrollTop < lastTop.current - 1
    lastTop.current = el.scrollTop
    if (settling.current) {
      if (!near) return
      settling.current = false
    }
    if (near) following.current = true
    else if (up) following.current = false
    else if (following.current) {
      el.scrollTop = el.scrollHeight
      return
    }
    setAtBottom(following.current)
  }, [])

  const stick = React.useMemo(() => ({ atBottom, scrollToBottom, scroller, onScroll }), [atBottom, scrollToBottom, onScroll])
  return (
    <StickContext.Provider value={stick}>
      <div data-slot="conversation" className={cn("ki-conversation", className)} {...props}>
        {children}
      </div>
    </StickContext.Provider>
  )
}

/** The scrolling part; its log is measured as it grows. */
export function ConversationContent({ className, children, ...props }: React.ComponentProps<"div">) {
  const { scroller, onScroll } = useConversation()
  return (
    <div ref={scroller} onScroll={onScroll} data-slot="conversation-content" className={cn("ki-conversation-scroller", className)} {...props}>
      <div className="ki-conversation-log">{children}</div>
    </div>
  )
}

/** One short line, an optional picture above it and actions below. */
export function ConversationEmptyState({ className, icon, title, children, ...props }: React.ComponentProps<"div"> & { icon?: React.ReactNode; title: React.ReactNode }) {
  return (
    <div data-slot="conversation-empty" className={cn("ki-conversation-empty", className)} {...props}>
      {icon}
      <p className="ki-conversation-empty-title">{title}</p>
      {children}
    </div>
  )
}

/** Back to the latest, shown only while he's scrolled up. */
export function ConversationScrollButton({ className, label = "Scroll to latest", ...props }: React.ComponentProps<"button"> & { label?: string }) {
  const { atBottom, scrollToBottom } = useConversation()
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={label}
      title={label}
      data-slot="conversation-scroll-button"
      data-hidden={atBottom || undefined}
      tabIndex={atBottom ? -1 : undefined}
      aria-hidden={atBottom || undefined}
      className={cn("ki-conversation-scroll-button", className)}
      onClick={() => scrollToBottom("smooth")}
      {...props}
    >
      <ArrowDown />
    </Button>
  )
}
