# Web app mock-up — Sprint 14 (AC0)

Source of the mock-up for `docs/arch-web-app.md`. Live, clickable version:
<https://claude.ai/artifact/CiBwcLPCVTH3YfKt85L1ro> (private until shared).

| File | Frame |
|---|---|
| `Main.dc.html` | Console — clickable: Home, budget grid gate, Slack-started gate, command flow; Phase 1 expenses grid, recipe document, Novia; EN/ES |
| `PhoneHome.dc.html` | Phone — Home |
| `PhoneGate.dc.html` | Phone — budget grid gate |
| `Gates.dc.html` | Every gate type and state |
| `canvas.json` | Canvas layout and notes |

The `.dc.html` files are Design-canvas components: they load the canvas runtime (`support.js`) and
render inside the canvas, not when opened directly in a browser. All names and amounts are invented.
