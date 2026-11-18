# Sprint 18 — Novia in the browser

**Status: ACTIVE — started 2026-11-18.** Scope and ACs agreed with Javear at "start sprint". The
first slice of `docs/arch-web-app.md` (v0.10) §10 Phase 1. The prior sprint's retro is
`docs/sprints/sprint-17.md`.

**Branch:** `sprint/18-web-novia`

---

## Sprint Goal

**The household talks to Novia on the web page.** Sessions are started, continued and reopened in
her left-hand region, her questions answered there, and a Novia panel keeps one topic's sessions on
a page. A gate answered on the web retires Slack's stale buttons, and a run's thread shows the
answers given.

---

## Decided at scoping

| Question | Decision |
|---|---|
| **Slice of Phase 1** | Novia in the browser, with `GATE_RESOLVED` and a thread that keeps its answers; the page editor, `chart`/`metric` and domain views wait |
| **Where a web-started session replies** | The web only — the surface that starts a session owns its callback, as decision J (Sprint 17) for runs |
| **Ask Novia about this** | Later — it touches every panel; not this sprint |
| **Custom domain** | Not this sprint; stays in the backlog |

## Scope

| # | Item |
|---|---|
| **1** | ⬜ **Novia's Slack leaks removed** (`arch-home-brain.md` §3.2): `PGC_Session.slack_thread_ts` becomes a thread reference plus its provider; `slackUser` in the `/novia` body becomes the principal from the experience layer. `PGC_Session.topic` added (§2.5). Schema through the template, `seed_PGC_Schema.json` and `addColumn`/`modifyColumn` — never bootstrap |
| **2** | ⬜ **Novia's resources** (§3.2, `arch-home-brain.md` §4.7), spec first, each its own commit: `GET /novia/sessions[?topic=]`, `GET /novia/sessions/{id}/messages`, `POST /novia/sessions`, `POST /novia/sessions/{id}/messages`, and answering her questions. PROC and `WebApiFunction`'s allow-list; every route checks the principal; test sessions left out of every read |
| **3** | ⬜ **Her region** (§4.1, §4.5): left, « collapses it (remembered on the device); sessions newest first, named by topic or first message; the open conversation as markdown; `?novia=<sessionId>`; polled while open; the *Novia* tab on a phone |
| **4** | ⬜ **Her questions:** `minds_eye_gate` and `minds_eye_continue_gate` added to §5.2 and drawn with the existing gate components — parity with what Slack draws today |
| **5** | ⬜ **Novia panels** (§4.2): the `novia` panel kind — a topic's sessions, *New* starts one on the topic; at least one on a household page (`household/pages.json`) |
| **6** | ⬜ **`GATE_RESOLVED`** (§8): a Slack-started gate answered on the web updates the Slack message, so its buttons disappear rather than refuse |
| **7** | ⬜ **A run's thread keeps its answers** (backlog, decision L): `resumeGate` writes a `GATE_ANSWERED` inbox row — the action's label, a form's change count — and both surfaces draw it |

## Acceptance Criteria

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | Javear starts a session in Novia's region, she replies, and after a reload the session reopens with its history | 1, 2, 3 | Shown live |
| **AC2** | ⬜ | Every Novia gate type is answered in the browser, a gated action (e.g. `propose_workflow_fix`) included | 2, 4 | One live session per gate type |
| **AC3** | ⬜ | A Novia panel on a household page lists its topic's sessions; *New* starts one on that topic | 1, 2, 5 | Shown live |
| **AC4** | ⬜ | A Slack-started gate answered on the web loses its buttons in Slack, and the answer shows in the run's thread after a reload | 6, 7 | Shown live |
| **AC5** | ⬜ | Each new endpoint is in `openapi.yaml` before it is built, as its own commit; every Novia read checks the principal and leaves out test sessions | all | Review as each lands, and tests |

## Retro lessons to apply (sprint-17)

- **Confirm which build a tab is running** before diagnosing a web defect.
- **Parity with Slack is the baseline:** a deferral in the web design is checked against what Slack
  draws today.
- **Every read a person sees excludes test runs and sessions**, applied to every sibling read in the
  same change.
- **Map a helper's result to named fields;** don't spread an object whose keys you don't own.
- **When a write fails strangely, check `df` first.**

## Out of scope

| Item | Why |
|---|---|
| *Ask Novia about this* | Decided at scoping: later — it touches every panel |
| The page editor, `chart`/`metric` panels, Novia's `propose_page_change` | Phase 1, a later slice |
| Domain views, editable grids, the edit policy and `PGC_RecordEdit` | Phase 1, a later slice |
| 🧠 Help, Activity, the command bar, the rest of Settings, ⓘ | Phase 1, a later slice |
| Managing a session's topic (delete, move, adopt) | Backlog, after Phase 1 |
| The custom domain | Decided at scoping: not this sprint |
| WebSocket | Polling first, until it's felt (§10) |
