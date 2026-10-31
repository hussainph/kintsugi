import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { theme } from "../../components/graphical/theme"
import { resolveComponentPartStyle, resolveButtonPartStyle, type ComponentPartId } from "../../components/graphical/lib/component-parts"
import { componentCssStyle, type ButtonVariant, type ColorMode, type ComponentId, type ComponentState, type ComponentStyle } from "../../components/graphical/lib/theme-model"
import { controlAppearances, inputAppearanceState } from "../../components/graphical/lib/component-appearances"
import { correctComponentContrastStyle } from "../../components/graphical/lib/contrast-correction"
import type { ComponentTokens } from "../../components/graphical/lib/theme-model"

const root = fileURLToPath(new URL("../../../../", import.meta.url))
type Spec = {
  variants: Record<string, Record<ColorMode, Record<string, Record<string, { tokens: ComponentTokens; style: ComponentStyle; css: Record<string, unknown> }>>>>
}

// Verify the full downloaded catalog as well as the parts reused by the
// Radix/cmdk/Sonner adapters. Utility patterns map to these existing parts.
const components = readdirSync(`${root}/gui/components/kintsugi`)
  .filter(name => name.endsWith(".md"))
  .sort()
  .map(name => name.replace(/\.md$/, "") as ComponentId)

assert.equal(components.length, 38, "full supplied Graphical component catalog")

for (const component of components) {
  test(`${component}: captured light and unrelated dark styles remain exact; approved dark contrast roles resolve`, () => {
    const markdown = readFileSync(`${root}/gui/components/kintsugi/${component}.md`, "utf8")
    const spec = JSON.parse(markdown.split("```json\n")[1]!.split("\n```")[0]!) as Spec
    for (const [variant, modes] of Object.entries(spec.variants)) {
      for (const [mode, parts] of Object.entries(modes)) {
        for (const [part, states] of Object.entries(parts)) {
          for (const [state, expected] of Object.entries(states)) {
            const label = `${component}/${variant}/${mode}/${part}/${state}`
            const actual = resolveComponentPartStyle(theme, mode as ColorMode, component, part as ComponentPartId, state as ComponentState, variant as ButtonVariant | "default")
            const corrected = correctComponentContrastStyle(theme, mode as ColorMode, component, part as ComponentPartId, state as ComponentState, variant as ButtonVariant | "default", expected.tokens, expected.style)
            // Keep the raw capture authoritative for every unrelated property,
            // including CSS geometry/type/effects, not merely a new snapshot.
            assert.deepEqual(JSON.parse(JSON.stringify(componentCssStyle(expected.style))), expected.css, `${label} captured CSS`)
            if (mode === "light") assert.deepEqual(corrected, expected.style, `${label} light unchanged`)
            assert.deepEqual(JSON.parse(JSON.stringify(actual)), corrected, label)
            assert.deepEqual(JSON.parse(JSON.stringify(componentCssStyle(actual))), JSON.parse(JSON.stringify(componentCssStyle(corrected))), `${label} CSS`)
            if (component === "button" && part === "control") {
              // The compatibility Button uses this merged control+label resolver.
              const labelStyle = parts.label![state]!.style
              const merged = { ...corrected }
              for (const key of ["foreground", "fontFamily", "fontSize", "lineHeight", "letterSpacing", "fontWeight"] as const) {
                Object.assign(merged, { [key]: labelStyle[key] })
              }
              assert.deepEqual(JSON.parse(JSON.stringify(resolveButtonPartStyle(theme, mode as ColorMode, state as ComponentState, variant as ButtonVariant))), merged, `${label} merged label`)
            }
          }
        }
      }
    }
  })
}

test("compatibility CSS establishes the host layer order before declaring components", () => {
  const css = readFileSync(`${root}/packages/ui/src/components/graphical.css`, "utf8")
  assert.ok(css.indexOf("@layer theme, base, components, utilities;") < css.indexOf("@layer components {"))
  assert.match(css, /\[cmdk-item\]\[data-selected="false"\]/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  const entry = readFileSync(`${root}/packages/ui/src/styles.css`, "utf8")
  assert.ok(entry.indexOf('../components/graphical/styles.css') < entry.indexOf('./components/graphical.css'), "receiving adapters follow vendor rules")
  for (const module of ["graphical.tsx", "kbd.tsx", "skeleton.tsx"]) {
    assert.doesNotMatch(readFileSync(`${root}/packages/ui/src/components/${module}`, "utf8"), /import ["']\.\/graphical\.css["']/, "no order-dependent JS style imports")
  }
})

test("Input preserves semantic appearances and a separate focus outline", () => {
  const rest = { disabled: false, valid: null, focused: false, hovered: false }
  assert.equal(inputAppearanceState(rest), "rest")
  assert.equal(inputAppearanceState({ ...rest, hovered: true }), "hover")
  assert.equal(inputAppearanceState({ ...rest, focused: true, hovered: true }), "focus")
  assert.equal(inputAppearanceState({ ...rest, readOnly: true, focused: true }), "readonly")
  assert.equal(inputAppearanceState({ ...rest, valid: true, focused: true }), "valid")
  assert.equal(inputAppearanceState({ ...rest, valid: false, focused: true }), "invalid")
  assert.equal(inputAppearanceState({ ...rest, invalid: true, focused: true }), "invalid")
  assert.equal(inputAppearanceState({ ...rest, disabled: true, invalid: true }), "disabled")
  for (const mode of ["light", "dark"] as const) {
    const appearances = controlAppearances(theme, mode, "input")
    for (const state of ["invalid", "valid", "readonly"] as const) {
      assert.deepEqual(appearances[state], resolveComponentPartStyle(theme, mode, "input", "control", state))
    }
    assert.notEqual(componentCssStyle(appearances.invalid).boxShadow, componentCssStyle(appearances.rest).boxShadow)
    assert.ok(appearances.invalid.focusOutline)
  }
})
