# Sprint 18 — Novia in the browser

**Status: ACTIVE — started 2026-11-18; session 2 closed 2026-11-19.** Scope and ACs agreed with Javear at "start sprint". The
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
| **O — a session's address** | `PGC_Session.callback` jsonb, the shape of `PGC_WorkflowRun.callback`, replaces `slack_thread_ts` for every session type (`minds_eye`, `general_chat`, `llm_call_diagnostic`): Slack `{provider, channel, threadId}`, web `{provider: 'web', channel: <principal>}`. A message's own callback wins, the session's is the fallback, as today. Ownership is one check on a callback, for runs and sessions alike. Migrated add → backfill → deploy → backfill → drop |
| **P — `slackUser`** | Becomes `user` on the minds-eye path only (slackbot command, PROC body, log); the other commands keep theirs — no defect asks |
| **Q — a session's conversation** | `PGC_UiMessage.session_id` (integer, no FK, as `workflow_run_id`), from `payload.sessionId`. The conversation is the session's inbox rows with the person's own entries from `PGC_SessionEntry`, by time — what Slack showed, never her tool calls; sessions before the inbox (2026-11-15) say her replies were not kept |
| **R — names in code** | minds-eye, never Novia: `/proc/minds-eye/sessions…`, `/minds-eye/sessions…`, the `minds_eye` panel kind, `canSeeSession`; `arch-web-app.md` corrected to match |
| **S — a session's name** (Javear, 2026-11-18, added in session) | `PGC_Session.label` text, nullable, edited from the web — in her region and in a `minds_eye` panel. A session is named by its `label`, else its first message. Separate from `topic`, which files it under a panel. Added with item 1's migration |
| **U — her routes** (Javear, 2026-11-19) | A message is refused while a round is under way (`session_busy`), unless the round has outlived ProcFunction's timeout. One `…/responses` route answers both of her gates, PROC reading which waits; the gate is named by `atSeq`, and what its message carried (`resetActionCount`, `afterTruncation`) is read from its inbox row, never the body. Typed text while a continue gate waits is its follow-up; while an action gate waits it is refused (`gate_waiting`). Sessions are listed by last activity, newest first |
| **T — a turn's calls on one line** (Javear, 2026-11-18) | Her region on the web draws a turn that made several tool calls as one progress line (*Turn 5 · 3 calls*, the calls listed under it), so a repeated turn number never reads as a glitch. /proc gives the facts as structure — the progress message carries its `turn` (and the call's label) beside the formatted text, which Slack ignores; the web groups by `turn` and never parses the text. Slack keeps one line per call |

## Scope

| # | Item |
|---|---|
| **1** | ✅ DONE **Novia's Slack leaks removed** (`arch-home-brain.md` §3.2): `PGC_Session.slack_thread_ts` becomes `callback` (O); `slackUser` becomes `user` (P); `PGC_UiMessage.session_id` (Q). `PGC_Session.topic` (§2.5) and `label` (S) added. Schema through the template, `seed_PGC_Schema.json` and `addColumn`/`modifyColumn` — never bootstrap. Schema ✅ DONE (`9c80594`); templates and registry seed in step, the sync test now covering `description` (`eee57a0`). **Steps 1–3 done 2026-11-18:** `addColumn` ×4; `migrate-pgc-session-callback.mjs` filled 228 sessions (3 with a channel from the inbox) and 15 inbox rows, rerun "no changes"; registry 17 ok, `PGC_Session` refused until `slack_thread_ts` is dropped. Code ✅ DONE: sessions store `callback` (minds-eye, chat, explain; `keptCallback`), `user` on the minds-eye path, the inbox writes `session_id`; `minds_eye_system_prompt` v42 and `workflow_convention_bridge` v5 no longer say Slack. The migration replays on any instance bootstrapped before Sprint 18, through SERV (`4eca1f9`: columns, backfill, `--drop`, then the registry upsert). **Deployed 2026-11-18:** `sam deploy`; `minds_eye_system_prompt` v42, `workflow_convention_bridge` v5 upserted; `--drop` run — nothing left to fill, `slack_thread_ts` dropped, registry 18/18 ok, rerun a no-op; no errors in the logs. Live check (session 1367, Javear in Slack): the session stored its callback and her replies their `session_id`; her progress lines did not — the renderer drew buttons on any markdown message with a `sessionId`. Fixed (`dc978bc`, deployed): `invitesReply` from /proc decides Slack's buttons (`mindsEyeReplyBlocks`), every session message carries `sessionId`, and the migration linked 79 earlier progress lines by their thread. Live check of the fix pending: one `/novia` exchange. Found on the way (Javear's reply to 1367 never arrived): *Send answers* clicked with every box empty was ignored without a word — now the clicker is told privately to fill in an answer or use *Continue with Novia* (`3f6c2af`, deployed). Final check ✅ (1367 continued): her reply, row 243, the only row with `invitesReply`; every row carries `session_id`. **✅ DONE.** Two engine defects found in the same session, fixed: a continue gate re-posted after a follow-up reply said *I've reached my turn limit* — /proc now sends the gate's `reason` and Slack words it from that (A); and a truncation notice did not survive a round boundary, so after Continue she rewrote the same over-long response twice (~10k tokens each) — a round ending owed the notice carries `afterTruncation` through the gate to the next round |
| **2** | 🟡 **Novia's resources** (§3.2, `arch-home-brain.md` §4.7), spec first, each its own commit: `GET /minds-eye/sessions[?topic=]`, `GET /minds-eye/sessions/{id}/messages`, `POST /minds-eye/sessions`, `POST /minds-eye/sessions/{id}/messages`, and answering her questions. PROC and `WebApiFunction`'s allow-list; every route checks the principal and reads `minds_eye` sessions only. **Spec ✅ (`c4548aa`)**, shapes agreed (U). Last activity needs `PGC_Session.last_active_at`, kept by a trigger on `PGC_SessionEntry`; SERV had no route to add a trigger to a live table, so `POST /serv/schema/addTrigger` was built first (spec `2f021bb`, code `7d393dd`, not yet deployed) — functions from SERV's catalogue `trigger-functions.mjs`, never SQL from the caller. Column and trigger in the templates and registry seed ✅ (`78b3f76`); `createTable` now checks its triggers the same way (`e7df8ea`). Migration `dev_scripts/migrate-pgc-session-last-active.mjs` written (requests from the templates; `--check` live: column and trigger to add, ~1,380 sessions to backfill, `PGC_Session` refused for the missing column alone). **Deployed 2026-11-19:** `sam deploy`; migration run — column and trigger added, 1,380 sessions backfilled, registry 18/18 ok; the first rerun found the backfill a fraction of a millisecond short (a JS `Date` keeps milliseconds, the column microseconds) — now written as text, rerun 0 to fill; no errors in the logs. The trigger's first live firing is seen on the next session entry. **Routes built and deployed 2026-11-19** (smoke, read-only as Javear's principal: the list by last activity and its next page, 1372's conversation interleaved by time, a `general_chat` id 404): `src/proc/minds-eye-sessions.mjs` (the six, item 8's rename included), `canSeeSession`, the dispatch, the web allow-list (18 operations) and the summarised conversation; 39 + 7 new tests. The state read checked read-only against sessions 1362, 1367 and 1372. Known edge: the lifetime-turn notice invites no reply, so a session ended by it reads *working* until the round ceiling passes |
| **3** | 🟡 **Her region** (§4.1, §4.5): left, « collapses it (remembered on the device); sessions most recently active first (U), named by label or first message (S); the open conversation as markdown; a turn's calls grouped on one line (T); `?minds-eye=<sessionId>` (R); polled while open; the *Novia* tab on a phone. **Built and deployed 2026-11-19** (`sam deploy` with item 2's routes, then `deploy-web.mjs`): `src/ui/web/app/minds-eye/` (`Region.jsx`, `conversation.mjs`), wired into the shell and the phone's tabs; her progress lines now carry `turn`, `call`, `detail` (T, `minds-eye.mjs`); gates and questions drawn read-only until item 4; 17 new tests. Not done: collapsing on her own while a run needs the full width |
| **4** | 🟡 **Her questions:** `minds_eye_gate`, `minds_eye_continue_gate`, and a reply's `questions` with *Answer* and *Follow-up*, added to §5.2 and drawn with the existing gate components — parity with what Slack draws today. **Built and deployed 2026-11-19** (`deploy-web.mjs`): in her region (`Region.jsx`), only on the message she waits on (`answerable`): the action gate's confirm/test/Cancel, the continue gate's Continue/End with the follow-up in her box, a reply's questions with answer boxes, *Anything else* and *Send answers*; §5.2 rows added; 8 new tests |
| **5** | ⬜ **Novia panels** (§4.2): the `minds_eye` panel kind — a topic's sessions, *New* starts one on the topic; at least one on a household page (`household/pages.json`) |
| **6** | ⬜ **`GATE_RESOLVED`** (§8): a Slack-started gate answered on the web updates the Slack message, so its buttons disappear rather than refuse |
| **7** | ⬜ **A run's thread keeps its answers** (backlog, decision L): `resumeGate` writes a `GATE_ANSWERED` inbox row — the action's label, a form's change count — and both surfaces draw it |
| **8** | ⬜ **Renaming a session** (S): `label` on the session reads; a write route to set or clear it (spec first; principal-checked, `minds_eye` only); rename in her region and in a `minds_eye` panel |

## Acceptance Criteria

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ✅ | Javear starts a session in Novia's region, she replies, and after a reload the session reopens with its history — **met 2026-11-19, session 1381** (started on the web, two replies, reopened with its history) | 1, 2, 3 | Shown live |
| **AC2** | ⬜ | Every Novia gate type is answered in the browser, a gated action (e.g. `propose_workflow_fix`) included | 2, 4 | One live session per gate type |
| **AC3** | ⬜ | A Novia panel on a household page lists its topic's sessions; *New* starts one on that topic | 1, 2, 5 | Shown live |
| **AC4** | ⬜ | A Slack-started gate answered on the web loses its buttons in Slack, and the answer shows in the run's thread after a reload | 6, 7 | Shown live |
| **AC5** | 🟡 | Each new endpoint is in `openapi.yaml` before it is built, as its own commit; every minds-eye session read checks the principal and returns `minds_eye` sessions only — a `general_chat` or `llm_call_diagnostic` id is a 404 | all | Review as each lands, and tests |
| **AC6** | ⬜ | Javear renames a session on the web; the new name shows in her region and its panel, and survives a reload | 1, 2, 8 | Shown live |

## Retro lessons to apply (sprint-17)

- **Confirm which build a tab is running** before diagnosing a web defect.
- **Parity with Slack is the baseline:** a deferral in the web design is checked against what Slack
  draws today.
- **Every read a person sees excludes what is not theirs to see** — test runs, and sessions that are
  not `minds_eye` — applied to every sibling read in the same change.
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

## Session notes

**2026-11-18 (session 1).** Sprint started; item 1 done and deployed. Found live in Novia's
session 1367 and fixed the same day: progress lines without a session (`invitesReply`), an empty
*Send answers* click ignored silently, a continue gate claiming a turn limit it never hit
(`reason`), and a truncation notice lost at a round boundary (`afterTruncation`).
**Output ceiling left as is** (Javear): the two cut-off turns were 10,240 tokens of mostly
thinking (`max_output_tokens` counts her reasoning); with the notice now carried across rounds a
cut-off costs one attempt. Revisit only if cut-offs recur — capping reasoning per turn first,
after checking what the gateway accepts.

**Session 1367 (process_receipt units) — her work, not sprint scope:** v21 (unit-aware 12a/12b)
and v22 (12c guard, 13g *Units* line) live; v22's sandbox test was running at close (replay of
run 1036 as run 1053). Piece 3 — an 11-step weight form with an LLM estimate (prompt 128, saved,
unused) — is simulated, not built; On v21 she did not act on *Apply and test*; on v22 she did. Javear
continues it with Novia (2026-11-19) — not tracked here.

**2026-11-19 (session 2).** Items 2, 3 and 4 built and deployed; AC1 met (session 1381).
Decision U agreed (session_busy, one responses route, sessions by last activity). Last activity
needed `PGC_Session.last_active_at` kept by a trigger, and SERV had no route to add a trigger to
a live table: `POST /serv/schema/addTrigger` built, trigger functions now a catalogue in
`trigger-functions.mjs`, and `createTable` checks its triggers the same way. Migration run
(1,380 sessions; a rerun first found a millisecond shortfall from a JS `Date` — fixed, now a
no-op). Her region, her gates and questions live on the web. From Javear's first try: a reply
seemed lost for a few seconds after Send (the session read *waiting* until her round spoke —
also let a second send through) and an iPhone zoomed into 14 px text boxes; both fixed and
deployed (`06cea4f`, `4d03d5c`), not yet seen live. `process_receipt` is Javear's with Novia.

**Next:** AC2 live (one session per gate type, on the web) and a look at the Send fix and the
iPhone width; then item 5 (`minds_eye` panels — the panel kind `novia` renamed `minds_eye` in
`page-config.mjs` and the `Page` schema), item 8's rename in the UI (the route is built), then 6
and 7.

