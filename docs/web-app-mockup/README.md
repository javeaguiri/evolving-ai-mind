# Web app mock-up — Sprint 14 (AC0)

Source of the mock-ups for `docs/arch-web-app.md`.

**v0.5 (current, approved):** `console-v0.5.html`, published at
<https://claude.ai/artifact/V13D3yERqnvQDkm8Xsuu8z> (private until shared). v0.4 with the Pages,
Domains and Activity menus across the top bar (open on hover and on click), 🏠 always Home, Novia on
the left — collapsible with «, stepping aside while a run needs the width, remembered on the device —
and Phase 0 drawing the household's Home, Money and Inventory pages read-only.

**v0.4 (record):** `console-v0.4.html`, the same artifact's previous version. The console of §4: navigator,
pages of panels (workflow, data, Novia), widgets, a budget run stepped through in its panel with the
grid and how Slack shows it, chart click-through, report Refresh, 🔔, 🧠 Help, ⚙ Settings, + Add panel,
Novia's page proposal; P0/P1 and desktop/phone switches.

**v0.2 (record):** the files below, live at <https://claude.ai/artifact/CiBwcLPCVTH3YfKt85L1ro>.

| File | Frame |
|---|---|
| `Main.dc.html` | Console — clickable: the household's pages of widgets (Home, Stocks, + new page, widget menu), ⓘ on every widget, the Ask drawer (workflow routing, Novia's page proposal), the budget question, the Slack-started question, ⚙ (How your brain works, All data with the expenses grid and recipe document, Activity, Workflows, Memory, Settings); P0/P1 and EN/ES switches |
| `PhoneHome.dc.html` | Phone — Home as widgets, bottom bar of pages and Ask |
| `PhoneGate.dc.html` | Phone — budget grid gate |
| `Gates.dc.html` | Every gate type and state |
| `canvas.json` | Canvas layout and notes |

The `.dc.html` files are Design-canvas components: they load the canvas runtime (`support.js`) and
render inside the canvas, not when opened directly in a browser. All names and amounts are invented.
