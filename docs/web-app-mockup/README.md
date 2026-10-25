# Web app mock-up — Sprint 14 (AC0)

Source of the mock-up for `docs/arch-web-app.md`. Live, clickable version:
<https://claude.ai/artifact/CiBwcLPCVTH3YfKt85L1ro> (private until shared).

| File | Frame |
|---|---|
| `Main.dc.html` | Console — clickable: the household's pages of widgets (Home, Stocks, + new page, widget menu), ⓘ on every widget, the Ask drawer (workflow routing, Novia's page proposal), the budget question, the Slack-started question, ⚙ (How your brain works, All data with the expenses grid and recipe document, Activity, Workflows, Memory, Settings); P0/P1 and EN/ES switches |
| `PhoneHome.dc.html` | Phone — Home as widgets, bottom bar of pages and Ask |
| `PhoneGate.dc.html` | Phone — budget grid gate |
| `Gates.dc.html` | Every gate type and state |
| `canvas.json` | Canvas layout and notes |

The `.dc.html` files are Design-canvas components: they load the canvas runtime (`support.js`) and
render inside the canvas, not when opened directly in a browser. All names and amounts are invented.
