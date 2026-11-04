# The fixed measure and the right margin

Screenshots from `apps/desktop/test/runtime-margin.test.ts`, taken in a scratch vault through the real headless backend. Full screen is simulated through the headless bridge.

| View | Light | Dark |
| --- | --- | --- |
| Kin tab, with the selection as a chip | [Light](04-kin-tab-light.png) | [Dark](04-kin-tab-dark.png) |
| References tab | [Light](05-references-light.png) | [Dark](05-references-dark.png) |
| Feed, with Kin alone | [Light](06-feed-light.png) | [Dark](06-feed-dark.png) |
| Settings, with Kin alone | [Light](06-settings-light.png) | [Dark](06-settings-dark.png) |
| Full screen, sidebar open, margin open | [Light](08-fullscreen-sidebar-margin-light.png) | [Dark](08-fullscreen-sidebar-margin-dark.png) |
| Full screen, sidebar as icons, margin closed | [Light](08-fullscreen-rail-plain-light.png) | [Dark](08-fullscreen-rail-plain-dark.png) |

Widths and window states, light:

- [1440, margin open](01-1440-open.png). The draft is where it was with the margin closed.
- [1280, the sidebar folded by the margin](02-1280-folded.png). The column slid left as one piece.
- [800, the margin over the page](03-800-overlay.png).
- Windowed: [sidebar open](07-windowed-sidebar-margin.png) and [sidebar as icons](07-windowed-rail-margin.png), with the margin open.
- [Scroll bars always shown](09-scrollbars-always.png).
