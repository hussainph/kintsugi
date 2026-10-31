# Component specifications

Each theme below includes a focused specification for every component in Graphical's preview catalog. Specifications combine the preview's resolved values with anatomy, geometry, state, and composition rules. Authored refinements are part of the target, not optional suggestions. Read the relevant files when building individual components; read every entry when setting up the full library.

Both setup choices include all specifications. When the full library is selected, components/graphical/ also contains the actual preview components, their shared styling runtime, styles.css, and the current theme.ts snapshot. Use that implementation directly and follow the component setup in base-ui.md; specifications explain and verify it, not replace it. The theme-and-skills choice includes no component source or component dependency installation; build or style components as needed. Follow the selected setup in GUI.md when present.

For a full installation, track every component below as implemented, reused and verified, or blocked with a concrete reason, and provide its import path. Also check the receiving version's [official Base UI catalog](https://base-ui.com/llms.txt) for supported additions; disclose components without a Graphical preview specification instead of claiming a verified visual match. Utility providers and hooks are integration tools, not standalone visual components.

Preserve the supplied assets and resolved styles. Free fallbacks can change appearance and must be disclosed. Honor the receiving app's dependency and review policies; only claim visual parity for what was actually verified.

## Kintsugi

[Theme foundations](themes/kintsugi.md) · [Effective assignment tables](themes/kintsugi-components.md)

- [Accordion](components/kintsugi/accordion.md)
- [Alert dialog](components/kintsugi/alert-dialog.md)
- [Autocomplete](components/kintsugi/autocomplete.md)
- [Avatar](components/kintsugi/avatar.md)
- [Button](components/kintsugi/button.md)
- [Checkbox](components/kintsugi/checkbox.md)
- [Checkbox group](components/kintsugi/checkbox-group.md)
- [Collapsible](components/kintsugi/collapsible.md)
- [Combobox](components/kintsugi/combobox.md)
- [Context menu](components/kintsugi/context-menu.md)
- [Dialog](components/kintsugi/dialog.md)
- [Drawer](components/kintsugi/drawer.md)
- [Field](components/kintsugi/field.md)
- [Fieldset](components/kintsugi/fieldset.md)
- [Form](components/kintsugi/form.md)
- [Menu](components/kintsugi/menu.md)
- [Menubar](components/kintsugi/menubar.md)
- [Meter](components/kintsugi/meter.md)
- [Navigation menu](components/kintsugi/navigation-menu.md)
- [Number field](components/kintsugi/number-field.md)
- [OTP field](components/kintsugi/otp-field.md)
- [Popover](components/kintsugi/popover.md)
- [Preview card](components/kintsugi/preview-card.md)
- [Progress](components/kintsugi/progress.md)
- [Radio](components/kintsugi/radio.md)
- [Radio group](components/kintsugi/radio-group.md)
- [Scroll area](components/kintsugi/scroll-area.md)
- [Select](components/kintsugi/select.md)
- [Separator](components/kintsugi/separator.md)
- [Slider](components/kintsugi/slider.md)
- [Switch](components/kintsugi/switch.md)
- [Tabs](components/kintsugi/tabs.md)
- [Text field](components/kintsugi/input.md)
- [Toast](components/kintsugi/toast.md)
- [Toggle](components/kintsugi/toggle.md)
- [Toggle group](components/kintsugi/toggle-group.md)
- [Toolbar](components/kintsugi/toolbar.md)
- [Tooltip](components/kintsugi/tooltip.md)
