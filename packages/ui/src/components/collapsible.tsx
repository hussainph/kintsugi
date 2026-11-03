import { Collapsible as CollapsiblePrimitive } from "radix-ui"
import { cn } from "cn"
import { graphicalPart } from "./graphical"

const Root = graphicalPart(CollapsiblePrimitive.Root, "collapsible", "group", "ui-stack ki-collapsible")
const Trigger = graphicalPart(CollapsiblePrimitive.Trigger, "collapsible", "trigger", "ui-button ui-spread")
const Panel = graphicalPart(CollapsiblePrimitive.Content, "collapsible", "panel", "ki-disclosure")

/** `bare`: a disclosure inside a navigation tree. The rows are the surface,
 *  so the group adds no gap, panel surface or padding of its own; only the
 *  open and close motion stays. */
type Bare = { bare?: boolean }

function Collapsible({ bare, className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root> & Bare) {
  if (bare) return <CollapsiblePrimitive.Root data-slot="collapsible" className={className} {...props} />
  return <Root data-slot="collapsible" className={className} {...props} />
}

function CollapsibleTrigger(props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  // Existing Sidebar triggers compose their own navigation button. Do not put
  // a second control's surface/spacing around that authored asChild content.
  const Comp = props.asChild ? CollapsiblePrimitive.Trigger : Trigger
  return <Comp data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent({ bare, children, className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent> & Bare) {
  if (bare) {
    return (
      <CollapsiblePrimitive.Content data-slot="collapsible-content" className={cn("ki-disclosure", className)} {...props}>
        {children}
      </CollapsiblePrimitive.Content>
    )
  }
  return (
    <Panel data-slot="collapsible-content" className={className} {...props}>
      <div className="ui-disclosure-content">{children}</div>
    </Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
