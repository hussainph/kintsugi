# KI-20 Graphical verification — FINAL PASS

## Final outcome

**One coherent complete run:180/180 checks PASS;38/38 behavioral rows PASS in both light and dark;84/84 rendered main-part specification samples match.** No console, page or HTTP errors. Run: 2026-10-31T16:32:33.232Z → 2026-10-31T16:34:38.033Z.

- Final source guard follow-up:22/22 PASS after adding caller baseUIHandlerPrevented cancellation guard to ContextMenu.Trigger.
- Final Caption copy follow-up:2/2 PASS after wording correction, with current screenshots.
- Existing Lab boot CLI:17 entries /32 stories PASS, including all discovered component/page stories.
- No fallback/unavailable/loading glyphs after settling. Sidebar Geist Mono400/500/600 loaded.
- All checks used headless:true Chrome, one serial worker (concurrency hint1), loopback server4415. No native app/window launched.

## Resolved findings and installed-library adaptations

- Loading Button now has Saving accessible name and busy semantics; actual button checks PASS both modes.
- Caption now uses onBlur. Installed Base UI1.9 intentionally suppresses valueMissing for untouched inputs (useFieldValidation.js:176); the runner verifies that policy, then **type→clear→blur** produces invalid/error and refill clears it. The final fixture accurately says “Required. Type a caption, clear it, and blur to see validation.” No forced dirty state or invented validation.
- ContextMenu right-click plus **Shift+F10 and ContextMenu keys** now open the library portal. Focus enters the menu; ArrowDown/Home focuses Open clip; Enter runs its callback and dismisses. Both modes PASS, and the last guard refinement was rechecked.
- Tabs retains installed manual activation: arrow keys move focus; Space activates. Disabled tabs may receive roving focus but do not activate.
- Menu/submenu exit waits now correctly account for both parent and nested exiting nodes; no harness strict-selector failures remain.

Earlier interim partial counts and failure artifacts are superseded by this coherent final result. **No unresolved behavioral failures remain in this verifier.**

## 38-row behavioral coverage

| Component / import from `@kintsugi/ui/graphical` | Exact action/assertion coverage | Light | Dark |
| --- | --- | --- | --- |
| Button | Click all five variants and assert status; Enter activates primary; loading action has an accessible name. | PASS | PASS |
| Input | Fill title; assert native value and focus. | PASS | PASS |
| Checkbox | Assert checked/mixed; Space unchecks the standalone choice. | PASS | PASS |
| CheckboxGroup | Mixed parent → click selects all → click clears all children. | PASS | PASS |
| Radio | ArrowDown moves exclusivity private → public. | PASS | PASS |
| RadioGroup | Click In review; Published disabled; ArrowDown wraps to Draft. | PASS | PASS |
| Switch | Checked initial state; Space toggles off. | PASS | PASS |
| Toggle | Space changes persistent aria-pressed false → true. | PASS | PASS |
| ToggleGroup | Select bold alongside italic; ArrowRight moves roving focus. | PASS | PASS |
| Field | Untouched blur intentionally suppresses required errors (Base UI1.9); type→clear→blur produces invalid; fill clears it; explicit invalid and readonly semantics. | PASS | PASS |
| Fieldset | Real fieldset/legend group named Author; fill labeled Name. | PASS | PASS |
| Form | Empty submit invalid; valid email submit/status and FormData preserve named value. | PASS | PASS |
| NumberField | 500 → increment 600 → decrement 500 → ArrowUp 600. | PASS | PASS |
| OTPField | Type 123456 across six inputs; completion callback and combined named form value. | PASS | PASS |
| Select | Initial Draft label; Space opens portal; select In review; native review value; Published disabled; Escape. | PASS | PASS |
| Combobox | Filter Rep; ArrowDown/Enter selects Repair; unmatched query displays empty state. | PASS | PASS |
| Autocomplete | Filter Ess; keyboard selects Essays; verify actual themed portal. | PASS | PASS |
| Accordion | Enter expands backlinks and associated region; Enter collapses and hides it. | PASS | PASS |
| Collapsible | Click expands details; Space collapses and removes visible content. | PASS | PASS |
| Tabs | ArrowRight roving focus, Space activation; References panel association; History disabled; wrap and select Writing. | PASS | PASS |
| Dialog | Open named modal portal; edit field; six Tab steps remain trapped; Escape dismisses and restores trigger focus. | PASS | PASS |
| AlertDialog | Open alertdialog; cancel preserves; confirm changes fixture status and closes. | PASS | PASS |
| Drawer | Open named References dialog portal; Done closes. | PASS | PASS |
| Popover | Open named dialog portal; Done closes. | PASS | PASS |
| PreviewCard | Hover opens actual portal; Escape; real href preserved; keyboard focus reopens. | PASS | PASS |
| Tooltip | Keyboard focus opens real popup; Escape dismisses. | PASS | PASS |
| Menu | Disabled Publish; toggle checkbox; choose radio; keyboard submenu chooses Essays; keyboard Open action. | PASS | PASS |
| ContextMenu | Right-click portal/action/dismissal; Shift+F10 transfers menu focus; ArrowDown/Home focuses Open, Enter changes status; ContextMenu key opens; Escape dismisses. | PASS | PASS |
| Menubar | ArrowRight File → Edit; ArrowDown opens; First action updates status. | PASS | PASS |
| NavigationMenu | Library opens portal; Notes is a real link and navigates to expected hash. | PASS | PASS |
| Toolbar | Space toggles Bold; ArrowRight focuses Italic; no nested interactive elements; real link. | PASS | PASS |
| Avatar | Loaded artwork has accessible name/natural size; separate HP fallback; root is square. | PASS | PASS |
| Slider | 40 initial → ArrowRight 41 → End 100; named hidden value = 100. | PASS | PASS |
| Meter | Read-only role and 0/40/100 value bounds; visible numeric value, no slider role. | PASS | PASS |
| Progress | Determinate aria-value/visible 40; toggle indeterminate removes value and exposes loading label. | PASS | PASS |
| Toast | Trigger creates real themed portal notification; Acknowledge dismisses. | PASS | PASS |
| ScrollArea | Keyboard-focusable viewport; PageDown scrolls; bottom range reachable. | PASS | PASS |
| Separator | Two semantic separators with horizontal/vertical orientation and zero native borders. | PASS | PASS |

All named imports above are from `@kintsugi/ui/graphical`; implementation entry is `packages/ui/components/graphical/index.ts`. Exact actions and assertions live in `scripts/check-graphical.mjs`.

## Specification and scenario evidence

-84 exact normalized expected/actual main-part samples from downloaded `gui/components/kintsugi/*.md`:all38 both modes plus all five Button variants. Applies only each part’s authored property list; compares fill/radius and full family/size/weight/line-height/tracking where applicable, plus zero native borders.
- Direct reusable bundled Input inside Field invalid/readOnly:both modes match exact error/readonly shadow+fill; separate keyboard outline preserves invalid edge.
- Open mounted Dialog follows actual html.dark light→dark→light, including portal theme variables/fonts/fills.
- Dialog accessible naming, six Tab steps of modal focus containment, Escape/focus return; distinct AlertDialog cancel/confirm; Drawer/Popover/PreviewCard/Tooltip/Select/Autocomplete/Menu/Toast real portals.
- Native form validation/submission/named values, OTP digit distribution/completion, keyboard choices and roving navigation, disabled semantics.
- Reduced-motion media plus Lab scenario: no running infinite loops; indeterminate status remains meaningful; Dialog still opens/closes.
-390px catalog has no document horizontal overflow; bottom specimen reachable; dialog fits viewport.

## Checks actually run

1. `node --check scripts/check-graphical.mjs` — PASS.
2. `pnpm --filter @kintsugi/lab exec tsx src/boot.ts --url http://127.0.0.1:4415 --out "$PWD/.lab-artifacts/ki-20/boot" --workers "$VOLLI_CONCURRENCY_HINT" --executable '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'` —32/32 stories PASS,17 entries; `.lab-artifacts/ki-20/boot/manifest.json`.
3. `node scripts/check-graphical.mjs --out .headless/graphical/final-green` — **180/180 PASS**, including all38 rows both modes and all84 style samples; `final-green/report.json`.
4. `node scripts/check-graphical.mjs --behavior-only --only ContextMenu --out .headless/graphical/context-guard` —22/22 PASS after final caller-cancellation guard.
5. Final one-off headless Playwright Caption check —2/2 modes PASS: asserts final wording, type/clear/blur invalid, fill/blur clears, captures screenshots; `field-final-copy.json`.

## Screenshots and artifacts

- Machine-readable final summary: `summary.json`.
- Complete exact results/spec values/fonts/portals/errors: `final-green/report.json`; full command log: `final-green/run.log`.
- Full catalog light/dark: `final-green/catalog-{light,dark}.png`.
- Section captures: `final-green/{controls,forms,disclosure,overlays,menus,feedback}-{light,dark}.png`.
- Current Caption wording + invalid state: `final-green/field-final-copy-{light,dark}.png`.
- Open modal/drawer/toast: `final-green/{dialog,drawer,toast}-{light,dark}.png`.
- Direct Input states: `final-green/direct-input-states-{light,dark}.png`.
- Reduced motion: `final-green/{feedback-dark-reduced-motion,dialog-dark-reduced-motion}.png`.
- Narrow viewport: `final-green/catalog-light-390-{top,bottom}.png`, `final-green/dialog-light-390.png`.

Full-page captures temporarily expose only preview scroller height/overflow for capture. Normal interaction and viewport captures use actual geometry. Screenshots were inspected for controls, forms, dark modal, direct invalid/readOnly states and narrow layout.

## Remaining limitations / external decisions

- This is behavior coverage of all38 with sampled rendered style parity—not every-part/every-state pixel equivalence.
- Timeless Sans and LT Superior Serif vendor acquisition remains externally blocked per parent; configured stacks are retained but current glyphs use fallbacks. Geist Mono is genuinely loaded.
- Authored dark color-1 is near-black: selected radio/switch and PreviewCard link have visibly weak contrast despite matching the target. Any palette change is a theme decision, not an implementation drift repair.
- Product app workflows and supplementary searchable Menu additions are owned by parent/other verifier. No additional public primitive coverage claim.
- Only `scripts/check-graphical.mjs` and owned artifact outputs were edited; no product files or commits.
