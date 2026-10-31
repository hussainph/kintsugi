import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { theme } from '../components/graphical/theme'
import { getComponentParts, resolveComponentPartStyle, setComponentPartToken, type ComponentPartId } from '../components/graphical/lib/component-parts'
import { componentReferenceSource } from '../components/graphical/lib/component-references'
import { choiceAppearance, choiceMarkStyle } from '../components/graphical/lib/component-appearances'
import {
  componentCssStyle, previewCssVariables, resolveColor, withFocusBorder,
  type ButtonVariant, type ColorMode, type ComponentId, type ComponentState,
  type ComponentStyle, type ComponentTokens, type ThemeDocument,
} from '../components/graphical/lib/theme-model'
import { correctComponentContrastStyle, contrastRoleColorKey, DARK_CONTRAST_ROLES } from '../components/graphical/lib/contrast-correction'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const canvas = theme.theme.colors.dark['neutral-1']
const dark = (component: ComponentId, part: ComponentPartId, state: ComponentState = 'rest', document = theme) =>
  resolveComponentPartStyle(document, 'dark', component, part, state)
const fresh = (): ThemeDocument => structuredClone(theme)
const jsonStyle = (style: ComponentStyle): ComponentStyle => JSON.parse(JSON.stringify(style))

function ratio(foreground: string, background: string) {
  const luminance = (hex: string) => {
    assert.match(hex, /^#[\da-f]{6}$/i, 'contrast assertions use fully opaque resolved colors')
    const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
  }
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
const contrast = (foreground: string, background: string, minimum = 3) =>
  assert.ok(ratio(foreground, background) >= minimum,
    `${foreground} against ${background}: ${ratio(foreground, background).toFixed(2)} must reach ${minimum}:1`)

test('approved roles are semantic neutral assignments, not a Color 1 palette replacement', () => {
  assert.deepEqual(DARK_CONTRAST_ROLES, {
    foreground: 'neutral-9', focus: 'neutral-9', indicator: 'neutral-10', onIndicator: 'neutral-1',
  })
  assert.equal(resolveColor(theme.theme, 'dark', 'color-1'), '#0a0a0a')
  assert.equal(resolveColor(theme.theme, 'dark', 'color-1-transparent'), '#0a0a0a33')
  assert.equal(contrastRoleColorKey(theme.theme, 'light', 'color-1', 'focus'), 'color-1')
  assert.equal(contrastRoleColorKey(theme.theme, 'dark', 'color-2', 'focus'), 'color-2')
  assert.equal(contrastRoleColorKey(theme.theme, 'dark', 'color-1-transparent', 'focus'), 'neutral-9')
})

test('checkbox/group checked and indeterminate fills retain contrasting marks under focus', () => {
  for (const component of ['checkbox', 'checkbox-group'] as const) {
    for (const state of ['checked', 'indeterminate'] as const) {
      const control = dark(component, 'control', state)
      const mark = dark(component, 'indicator', state)
      assert.equal(control.background, '#f9f9f9')
      assert.equal(control.foreground, '#191919')
      assert.equal(control.borderColor, '#f9f9f9')
      assert.equal(mark.foreground, '#191919')
      contrast(control.background, canvas)
      contrast(mark.foreground, control.background, 4.5)
      assert.deepEqual(withFocusBorder(control, dark(component, 'control', 'focus')), control)
      assert.equal(control.focusOutline, '2px solid #e0e0e0')
    }
  }
  const appearance = choiceAppearance(theme, 'dark', 'checkbox')
  assert.equal(appearance({ checked: true, focused: true, disabled: false }).background, '#f9f9f9')
  assert.equal(choiceMarkStyle(theme, 'dark', 'checkbox', 'checked').color, '#191919')
})

test('radio/group dot and checked boundary remain visible with a separate focus outline', () => {
  for (const component of ['radio', 'radio-group'] as const) {
    const selected = dark(component, 'control', 'checked')
    const dot = dark(component, 'indicator', 'checked')
    assert.equal(selected.borderColor, '#f9f9f9')
    assert.equal(dot.background, '#f9f9f9')
    assert.equal(dot.foreground, '#f9f9f9')
    contrast(dot.background, selected.background)
    contrast(selected.borderColor, selected.background)
    assert.deepEqual(withFocusBorder(selected, dark(component, 'control', 'focus')), selected)
    assert.equal(selected.focusOutline, '2px solid #e0e0e0')
    assert.equal(dark(component, 'indicator', 'disabled').background, '#757575')
  }
})

test('switch thumb contrasts in both positions; focus never removes the checked fill', () => {
  for (const state of ['rest', 'hover', 'focus', 'checked'] as const) {
    const track = dark('switch', 'control', state)
    const thumb = dark('switch', 'thumb', state)
    assert.equal(track.background, state === 'checked' ? '#f9f9f9' : '#363636')
    assert.equal(thumb.background, state === 'checked' ? '#191919' : '#f9f9f9')
    contrast(thumb.background, track.background)
    if (state === 'checked') contrast(track.background, canvas)
  }
  const checked = choiceAppearance(theme, 'dark', 'switch')({ checked: true, focused: true, disabled: false })
  assert.equal(checked.background, '#f9f9f9')
  assert.equal(checked.focusOutline, '2px solid #e0e0e0')
  assert.equal(choiceMarkStyle(theme, 'dark', 'switch', 'checked').backgroundColor, '#191919')
  assert.equal(dark('switch', 'thumb', 'disabled').background, '#757575')
})

test('PreviewCard link uses strong neutral ink; value indicators and completion stay legible', () => {
  for (const state of ['rest', 'hover', 'focus'] as const) {
    const link = dark('preview-card', 'trigger', state)
    assert.equal(link.foreground, '#e0e0e0')
    contrast(link.foreground, canvas, 4.5)
    contrast(link.foreground, theme.theme.colors.dark['neutral-2'], 4.5)
  }
  assert.equal(dark('preview-card', 'trigger', 'disabled').foreground, '#757575')
  for (const component of ['slider', 'progress', 'meter'] as const) {
    const fill = dark(component, 'indicator')
    assert.equal(fill.background, '#f9f9f9')
    assert.equal(fill.foreground, '#191919')
    contrast(fill.background, dark(component, 'track').background)
    contrast(fill.foreground, fill.background, 4.5)
  }
  assert.equal(dark('slider', 'thumb').borderColor, '#f9f9f9')
  assert.equal(dark('otp-field', 'input', 'complete').borderColor, '#f9f9f9')
  assert.equal(dark('meter', 'indicator', 'low').background, '#ddbc74')
  assert.equal(dark('meter', 'indicator', 'high').background, '#ee9991')
})

type Spec = {
  component: ComponentId
  parts: { id: ComponentPartId; source?: { component: ComponentId; part: ComponentPartId } }[]
  variants: Record<string, Record<ColorMode, Record<string, Record<string, {
    tokens: ComponentTokens; style: ComponentStyle
  }>>>>
}
const specs = readdirSync(`${root}/gui/components/kintsugi`).filter(name => name.endsWith('.md')).map(name =>
  JSON.parse(readFileSync(`${root}/gui/components/kintsugi/${name}`, 'utf8').split('```json\n')[1]!.split('\n```')[0]!) as Spec)

test('all 38 effective specifications change only the independently approved dark color roles', () => {
  assert.equal(specs.length, 38)
  for (const spec of specs) for (const [variant, modes] of Object.entries(spec.variants)) {
    for (const mode of ['light', 'dark'] as const) for (const [part, states] of Object.entries(modes[mode])) {
      const source = spec.parts.find(item => item.id === part)?.source
      const owner = source?.component ?? spec.component
      const ownerPart = source?.part ?? part
      for (const [state, expected] of Object.entries(states)) {
        const label = `${spec.component}/${variant}/${mode}/${part}/${state}`
        const actual = resolveComponentPartStyle(theme, mode, spec.component, part as ComponentPartId, state as ComponentState, variant as ButtonVariant | 'default')
        const allowed = new Set<string>()
        if (mode === 'dark') {
          if (expected.style.focusOutline) {
            allowed.add('focusOutline')
            assert.equal(actual.focusOutline, '2px solid #e0e0e0', label)
            contrast('#e0e0e0', canvas)
          }
          if (state === 'focus') {
            allowed.add('shadow')
            if (['color-1', 'color-1-transparent'].includes(expected.tokens.borderColor)) {
              allowed.add('borderColor')
              assert.equal(actual.borderColor, '#e0e0e0', label)
            }
            const oldHalo = '0 0 0 1.26px color-mix(in srgb, #0a0a0a33 24%, transparent)'
            assert.equal(actual.shadow, expected.style.shadow.replace(oldHalo, '0 0 0 1.26px #e0e0e0'), `${label} only the default focus layer changes`)
          }
          if ((['checkbox', 'switch'].includes(owner) && ownerPart === 'control' && ['checked', 'indeterminate'].includes(state)) ||
            (['radio', 'slider', 'meter', 'progress'].includes(owner) && ownerPart === 'indicator' && expected.tokens.background === 'color-1')) {
            allowed.add('background'); allowed.add('foreground'); allowed.add('borderColor')
          }
          if (owner === 'checkbox' && ownerPart === 'indicator' && ['checked', 'indeterminate'].includes(state)) allowed.add('foreground')
          if (owner === 'switch' && ownerPart === 'thumb' && ['rest', 'hover', 'focus'].includes(state)) {
            allowed.add('background'); allowed.add('foreground')
          }
          if (owner === 'preview-card' && ownerPart === 'trigger' && state !== 'disabled') allowed.add('foreground')
          if ((owner === 'radio' && ownerPart === 'control' && state === 'checked') ||
            (owner === 'slider' && ownerPart === 'thumb' && state !== 'disabled') ||
            (owner === 'otp-field' && ownerPart === 'input' && state === 'complete')) allowed.add('borderColor')
        }
        for (const key of new Set([...Object.keys(expected.style), ...Object.keys(actual)])) {
          if (!allowed.has(key)) assert.deepEqual(actual[key as keyof ComponentStyle], expected.style[key as keyof ComponentStyle], `${label}/${key} unchanged`)
        }
      }
    }
  }
})

test('palette, identity, every light variable and every unrelated dark variable match the capture', () => {
  const before = JSON.stringify(theme)
  const reference = readFileSync(`${root}/gui/themes/kintsugi.md`, 'utf8')
  assert.equal(theme.name, 'Kintsugi')
  assert.equal(theme.theme.name, 'Charter')
  for (const mode of ['light', 'dark'] as const) {
    const actual = previewCssVariables(theme.theme, mode) as Record<string, string | number>
    const section = reference.split(`## ${mode} CSS variables`)[1]!.split('\n## ')[0]!
    for (const match of section.matchAll(/^\| `([^`]+)` \| (.*) \|$/gm)) {
      const [, variable, value] = match
      assert.equal(String(actual[variable!]), mode === 'dark' && variable === '--cte-focus' ? '#e0e0e0' : value, `${mode}/${variable}`)
    }
    assert.equal(actual['--theme-name'], 'Paper')
    for (const spec of specs) for (const [variant, modes] of Object.entries(spec.variants))
      for (const [part, states] of Object.entries(modes[mode])) for (const state of Object.keys(states))
        componentCssStyle(resolveComponentPartStyle(theme, mode, spec.component, part as ComponentPartId, state as ComponentState, variant as ButtonVariant | 'default'))
  }
  assert.equal(JSON.stringify(theme), before, 'resolving never mutates the captured document')
})

test('authored foregrounds, fills, edges, rings, and foreground/background pairs stay literal', () => {
  const document = fresh()
  document.componentTokens = {
    'preview-card:default:part:trigger:rest': { foreground: 'color-1' },
    'checkbox:default:part:control:checked': { background: 'color-1' },
    'input:default:part:control:focus': { borderColor: 'color-1' },
    'switch:default:part:thumb:rest': { background: 'color-2' },
    'radio:default:part:control:focus': { focusRing: { color: 'color-1', width: 3, opacity: 100 } },
  }
  assert.equal(dark('preview-card', 'trigger', 'rest', document).foreground, '#0a0a0a')
  assert.equal(dark('checkbox', 'control', 'checked', document).background, '#0a0a0a')
  assert.equal(dark('checkbox', 'indicator', 'checked', document).foreground, '#ffffff')
  assert.equal(dark('input', 'control', 'focus', document).borderColor, '#0a0a0a')
  assert.equal(dark('switch', 'thumb', 'rest', document).background, '#779575')
  assert.equal(dark('radio', 'control', 'rest', document).focusOutline, '3px solid #0a0a0a')
  document.theme.focusRing = { color: 'color-1', width: 'l', opacity: 100 }
  assert.equal(dark('input', 'control', 'rest', document).focusOutline, '1.26px solid #0a0a0a')
  delete document.theme.focusRing
  document.theme.primaryForeground = { dark: 'neutral-10' }
  assert.equal(dark('switch', 'control', 'checked', document).background, '#0a0a0a')
  assert.equal(dark('switch', 'control', 'checked', document).foreground, '#f9f9f9')
  assert.equal(dark('switch', 'thumb', 'checked', document).background, '#779575', 'authored rest thumb fill is inherited by checked')
  const pair = fresh()
  pair.componentTokens['checkbox:default:part:indicator:rest'] = { foreground: 'neutral-10' }
  assert.equal(dark('checkbox', 'control', 'checked', pair).background, '#0a0a0a', 'preserve the fill paired with an authored checkmark')
  assert.equal(dark('checkbox', 'indicator', 'checked', pair).foreground, '#f9f9f9')
  pair.theme.primaryForeground = { dark: 'neutral-10' }
  assert.equal(dark('radio', 'indicator', 'checked', pair).background, '#f9f9f9', 'radio dot does not consume primary foreground')
})

test('supported Radio control background edits preserve the dot and checked boundary through RadioGroup references', () => {
  for (const component of ['radio', 'radio-group'] as const) {
    for (const authoredState of ['rest', 'checked'] as const) {
      const source = componentReferenceSource(theme, component, 'control') ?? { component, part: 'control' as const }
      const document = setComponentPartToken(fresh(), source.component, 'default', source.part, authoredState, 'background', 'neutral-10')
      const before = JSON.stringify(document)
      const spec = specs.find(item => item.component === component)!.variants.default!
      for (const state of ['rest', 'checked', 'disabled'] as const) {
        const expected = spec.dark.indicator![state]!
        assert.deepEqual(jsonStyle(dark(component, 'indicator', state, document)), expected.style, `${component}/${authoredState}/${state} dot and paired foreground remain captured`)
        assert.deepEqual(correctComponentContrastStyle(document, 'dark', component, 'indicator', state, 'default', expected.tokens, expected.style), expected.style, 'shared-reference spec sampler follows the same guard')
        assert.deepEqual(jsonStyle(resolveComponentPartStyle(document, 'light', component, 'indicator', state)), spec.light.indicator![state]!.style, 'custom counterpart does not introduce light-mode corrections')
      }
      const checked = dark(component, 'control', 'checked', document)
      assert.equal(checked.background, '#f9f9f9')
      assert.equal(checked.borderColor, '#0a0a0a', 'preserve the original dark checked boundary on the authored light control')
      contrast(dark(component, 'indicator', 'checked', document).background, checked.background)
      contrast(checked.borderColor, checked.background)
      const focused = dark(component, 'control', 'focus', document)
      assert.equal(focused.borderColor, '#0a0a0a', 'the original boundary is preserved independently of the separate focus outline')
      assert.deepEqual(withFocusBorder(checked, focused), checked)
      assert.equal(checked.focusOutline, '2px solid #e0e0e0', 'the separate focus outline remains available')
      assert.equal(JSON.stringify(document), before)
    }
  }
})

test('disabled-only Radio edits preserve the disabled pair without reducing enabled Radio/RadioGroup contrast', () => {
  for (const component of ['radio', 'radio-group'] as const) {
    const source = componentReferenceSource(theme, component, 'control') ?? { component, part: 'control' as const }
    const document = setComponentPartToken(fresh(), source.component, 'default', source.part, 'disabled', 'background', 'neutral-10')
    for (const state of ['rest', 'hover', 'focus', 'checked'] as const) {
      assert.deepEqual(dark(component, 'control', state, document), dark(component, 'control', state), `${component}/${state} remains corrected despite the disabled-only override`)
    }
    for (const state of ['rest', 'checked'] as const) {
      const indicator = dark(component, 'indicator', state, document)
      assert.deepEqual(indicator, dark(component, 'indicator', state))
      assert.equal(indicator.background, '#f9f9f9')
      contrast(indicator.background, dark(component, 'control', 'checked', document).background)
    }
    const checked = dark(component, 'control', 'checked', document)
    assert.equal(checked.borderColor, '#f9f9f9')
    contrast(checked.borderColor, checked.background)
    const disabled = dark(component, 'control', 'disabled', document)
    const disabledIndicator = dark(component, 'indicator', 'disabled', document)
    assert.equal(disabled.background, '#f9f9f9', 'the authored disabled surface is retained')
    assert.deepEqual(jsonStyle(disabledIndicator), specs.find(item => item.component === component)!.variants.default!.dark.indicator!.disabled!.style)
    contrast(disabledIndicator.background, disabled.background)
  }
})

test('supported Slider/Progress/Meter track edits preserve coexisting indicator pairs without crossing disabled states', () => {
  for (const component of ['slider', 'progress', 'meter'] as const) {
    const parts = getComponentParts(component)
    const spec = specs.find(item => item.component === component)!.variants.default!
    // Slider's focused/hovered track can coexist with its rest-state indicator.
    for (const authoredState of parts.find(part => part.id === 'track')!.states) {
      const document = setComponentPartToken(fresh(), component, 'default', 'track', authoredState, 'background', 'neutral-10')
      const before = JSON.stringify(document)
      for (const state of parts.find(part => part.id === 'indicator')!.states) {
        const actual = dark(component, 'indicator', state, document)
        const preservePair = authoredState === 'rest' || (authoredState === 'disabled') === (state === 'disabled')
        const expected = preservePair ? spec.dark.indicator![state]!.style : jsonStyle(dark(component, 'indicator', state))
        assert.deepEqual(jsonStyle(actual), expected, `${component}/${authoredState}/${state} preserves only coexisting counterpart edits`)
        assert.deepEqual(jsonStyle(resolveComponentPartStyle(document, 'light', component, 'indicator', state)), spec.light.indicator![state]!.style, 'light mode stays untouched')
        if (authoredState === 'disabled' && state === 'disabled') {
          const disabledTrack = dark(component, 'track', 'disabled', document)
          assert.equal(disabledTrack.background, '#f9f9f9', 'the authored disabled track is retained')
          assert.equal(actual.background, '#494949', 'the captured disabled indicator is retained')
          contrast(actual.background, disabledTrack.background)
        }
        if (spec.dark.indicator![state]!.style.background === '#0a0a0a') {
          const trackState = authoredState === 'disabled' && state !== 'disabled' ? 'rest' : authoredState
          contrast(actual.background, dark(component, 'track', trackState, document).background)
          contrast(actual.foreground, actual.background, 4.5)
          if (authoredState === 'disabled' && state !== 'disabled') {
            assert.equal(actual.background, '#f9f9f9', 'disabled-only track edits never suppress the enabled fill correction')
            assert.equal(actual.foreground, '#191919')
          }
        }
      }
      if (component === 'slider') for (const state of parts.find(part => part.id === 'thumb')!.states) {
        const actual = dark(component, 'thumb', state, document)
        const preservePair = authoredState === 'rest' || (authoredState === 'disabled') === (state === 'disabled')
        const expected: ComponentStyle = preservePair ? spec.dark.thumb![state]!.style : dark(component, 'thumb', state)
        for (const key of ['background', 'foreground', 'borderColor'] as const)
          assert.equal(actual[key], expected[key], `slider/${authoredState}/${state}/${key} retains only the coexisting authored-track pairing`)
        if (authoredState === 'disabled' && state !== 'disabled') contrast(actual.borderColor, actual.background)
        assert.equal(actual.focusOutline, '2px solid #e0e0e0')
      }
      assert.equal(JSON.stringify(document), before)
    }
  }
})

test('the correction follows live neutral tokens, preserves authored shadows, and ignores other palettes/themes', () => {
  const document = fresh()
  document.theme.colors.dark['neutral-9'] = '#c8c8c8'
  document.theme.colors.dark['neutral-10'] = '#e0e0e0'
  document.componentTokens['input:default:part:control:rest'] = { shadows: { dark: [
    { x: 2, y: 3, blur: 4, spread: 5, opacity: 40, color: { light: 'color-1', dark: 'color-1' } },
  ] } }
  const rest = dark('input', 'control', 'rest', document)
  const focused = dark('input', 'control', 'focus', document)
  assert.equal(focused.focusOutline, '2px solid #c8c8c8')
  assert.equal(focused.shadow, `${rest.shadow}, 0 0 0 1.26px #c8c8c8`)
  assert.equal(dark('checkbox', 'control', 'checked', document).background, '#e0e0e0')
  document.componentTokens['switch:default:part:thumb:rest'] = { backgroundOpacity: 31, radius: 's' }
  assert.equal(dark('switch', 'thumb', 'rest', document).background, 'color-mix(in srgb, #e0e0e0 31%, transparent)')
  assert.equal(dark('switch', 'thumb', 'rest', document).radius, 5)
  document.componentTokens['preview-card:default:rest'] = { foreground: 'color-1' }
  assert.equal(dark('preview-card', 'trigger', 'hover', document).foreground, '#0a0a0a', 'legacy authored foreground is preserved')
  for (const change of [
    (doc: ThemeDocument) => { doc.theme.name = 'Grove' },
    (doc: ThemeDocument) => { doc.theme.colors.dark['color-1'] = '#abcdef' },
    (doc: ThemeDocument) => { doc.theme.colors.dark['neutral-1'] = '#000000' },
  ]) {
    const edited = fresh(); change(edited)
    assert.equal(contrastRoleColorKey(edited.theme, 'dark', 'color-1', 'focus'), 'color-1')
    const expected = specs.find(spec => spec.component === 'preview-card')!.variants.default!.dark.trigger!.rest!
    assert.strictEqual(correctComponentContrastStyle(edited, 'dark', 'preview-card', 'trigger', 'rest', 'default', expected.tokens, expected.style), expected.style)
  }
})
