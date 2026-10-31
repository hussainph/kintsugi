import { Collapsible as CollapsiblePrimitive } from "radix-ui"
import { graphicalPart } from "./graphical"

const Root = graphicalPart(CollapsiblePrimitive.Root, "collapsible", "group", "ui-stack ki-collapsible")
const Trigger = graphicalPart(CollapsiblePrimitive.Trigger, "collapsible", "trigger", "ui-button ui-spread")
const Panel = graphicalPart(CollapsiblePrimitive.Content, "collapsible", "panel", "ki-disclosure")

function Collapsible(props: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger(props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  // Existing Sidebar triggers compose their own navigation button. Do not put
  // a second control's surface/spacing around that authored asChild content.
  const Comp = props.asChild ? CollapsiblePrimitive.Trigger : Trigger
  return <Comp data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent({ children, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <Panel data-slot="collapsible-content" {...props}>
      <div className="ui-disclosure-content">{children}</div>
    </Panel>
  )
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
