"use client"

import { useMemo, type ElementType } from "react"
import { useGraphicalTheme } from "../../components/graphical"
import {
  APPEARANCE_STATES,
  appearanceVariables,
  themePart,
} from "../../components/graphical/components/library/component-theme"
import { resolveButtonPartStyle } from "../../components/graphical/lib/component-parts"
import type { ButtonVariant, ComponentId } from "../../components/graphical/lib/theme-model"
import type { ComponentPartId } from "../../components/graphical/lib/component-parts"

// Retain the receiving primitives' complete API (asChild, refs, form events and
// dismissal) while sharing Graphical's live appearance resolver and portal scope.
export function graphicalPart<C extends ElementType>(
  base: C,
  component: ComponentId,
  part: ComponentPartId,
  structure = "",
): C {
  return themePart(base, component, part, `ki-radix ${structure}`)
}

export { usePartStyle, usePartAppearance } from "../../components/graphical/components/library/component-theme"

export function useButtonVariables(variant: ButtonVariant) {
  const { document, colorMode } = useGraphicalTheme()
  return useMemo(() => appearanceVariables(Object.fromEntries(
    APPEARANCE_STATES.map(state => [
      state,
      resolveButtonPartStyle(document, colorMode, state, variant),
    ]),
  )), [document, colorMode, variant])
}
