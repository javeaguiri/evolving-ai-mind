# Sprint 18 — Novia in the browser

**Status: CLOSED 2026-11-22 — started 2026-11-18. All seven ACs met: six live, AC5 by review and tests.** Scope and ACs agreed with Javear at "start sprint". The
first slice of `docs/arch-web-app.md` (v0.10) §10 Phase 1. The prior sprint's retro is
`docs/sprints/sprint-17.md`.

**Branch:** `sprint/18-web-novia` — merged to main at close, as every sprint is.

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
| **V — a panel's topic** (Javear, 2026-11-21) | A `minds_eye` panel names a `domain` of the registry or a free-text `topic`, one of the two; the session's `topic` holds the domain's name or the text. The topic is a filing label only — it is not passed to her (dropped, not backlogged) |
| **W — one message for an answer** (Javear, 2026-11-21) | Items 6 and 7 are one message, `GATE_ANSWERED`, sent by `resumeGate` once it accepts an answer: `gateId`, `label`, a form's `changes`, `answeredIn`. Kept in the inbox, so the web draws the answer under its question (item 7); Slack updates the gate's message when the answer came from elsewhere (item 6). The message is found by reading the run's thread for the `gate_id` its buttons carry — the bot gains `channels:history`, `groups:history`, `im:history` (option A over storing each gate's message ts). `GATE_RESOLVED` is not built |
| **T — a turn's calls on one line** (Javear, 2026-11-18) | Her region on the web draws a turn that made several tool calls as one progress line (*Turn 5 · 3 calls*, the calls listed under it), so a repeated turn number never reads as a glitch. /proc gives the facts as structure — the progress message carries its `turn` (and the call's label) beside the formatted text, which Slack ignores; the web groups by `turn` and never parses the text. Slack keeps one line per call |

## Scope

| # | Item |
|---|---|
| **1** | ✅ DONE **Novia's Slack leaks removed** (`arch-home-brain.md` §3.2): `PGC_Session.slack_thread_ts` becomes `callback` (O); `slackUser` becomes `user` (P); `PGC_UiMessage.session_id` (Q). `PGC_Session.topic` (§2.5) and `label` (S) added. Schema through the template, `seed_PGC_Schema.json` and `addColumn`/`modifyColumn` — never bootstrap. Schema ✅ DONE (`9c80594`); templates and registry seed in step, the sync test now covering `description` (`eee57a0`). **Steps 1–3 done 2026-11-18:** `addColumn` ×4; `migrate-pgc-session-callback.mjs` filled 228 sessions (3 with a channel from the inbox) and 15 inbox rows, rerun "no changes"; registry 17 ok, `PGC_Session` refused until `slack_thread_ts` is dropped. Code ✅ DONE: sessions store `callback` (minds-eye, chat, explain; `keptCallback`), `user` on the minds-eye path, the inbox writes `session_id`; `minds_eye_system_prompt` v42 and `workflow_convention_bridge` v5 no longer say Slack. The migration replays on any instance bootstrapped before Sprint 18, through SERV (`4eca1f9`: columns, backfill, `--drop`, then the registry upsert). **Deployed 2026-11-18:** `sam deploy`; `minds_eye_system_prompt` v42, `workflow_convention_bridge` v5 upserted; `--drop` run — nothing left to fill, `slack_thread_ts` dropped, registry 18/18 ok, rerun a no-op; no errors in the logs. Live check (session 1367, Javear in Slack): the session stored its callback and her replies their `session_id`; her progress lines did not — the renderer drew buttons on any markdown message with a `sessionId`. Fixed (`dc978bc`, deployed): `invitesReply` from /proc decides Slack's buttons (`mindsEyeReplyBlocks`), every session message carries `sessionId`, and the migration linked 79 earlier progress lines by their thread. Live check of the fix pending: one `/novia` exchange. Found on the way (Javear's reply to 1367 never arrived): *Send answers* clicked with every box empty was ignored without a word — now the clicker is told privately to fill in an answer or use *Continue with Novia* (`3f6c2af`, deployed). Final check ✅ (1367 continued): her reply, row 243, the only row with `invitesReply`; every row carries `session_id`. **✅ DONE.** Two engine defects found in the same session, fixed: a continue gate re-posted after a follow-up reply said *I've reached my turn limit* — /proc now sends the gate's `reason` and Slack words it from that (A); and a truncation notice did not survive a round boundary, so after Continue she rewrote the same over-long response twice (~10k tokens each) — a round ending owed the notice carries `afterTruncation` through the gate to the next round |
| **2** | 🟡 **Novia's resources** (§3.2, `arch-home-brain.md` §4.7), spec first, each its own commit: `GET /minds-eye/sessions[?topic=]`, `GET /minds-eye/sessions/{id}/messages`, `POST /minds-eye/sessions`, `POST /minds-eye/sessions/{id}/messages`, and answering her questions. PROC and `WebApiFunction`'s allow-list; every route checks the principal and reads `minds_eye` sessions only. **Spec ✅ (`c4548aa`)**, shapes agreed (U). Last activity needs `PGC_Session.last_active_at`, kept by a trigger on `PGC_SessionEntry`; SERV had no route to add a trigger to a live table, so `POST /serv/schema/addTrigger` was built first (spec `2f021bb`, code `7d393dd`, not yet deployed) — functions from SERV's catalogue `trigger-functions.mjs`, never SQL from the caller. Column and trigger in the templates and registry seed ✅ (`78b3f76`); `createTable` now checks its triggers the same way (`e7df8ea`). Migration `dev_scripts/migrate-pgc-session-last-active.mjs` written (requests from the templates; `--check` live: column and trigger to add, ~1,380 sessions to backfill, `PGC_Session` refused for the missing column alone). **Deployed 2026-11-19:** `sam deploy`; migration run — column and trigger added, 1,380 sessions backfilled, registry 18/18 ok; the first rerun found the backfill a fraction of a millisecond short (a JS `Date` keeps milliseconds, the column microseconds) — now written as text, rerun 0 to fill; no errors in the logs. The trigger's first live firing is seen on the next session entry. **Routes built and deployed 2026-11-19** (smoke, read-only as Javear's principal: the list by last activity and its next page, 1372's conversation interleaved by time, a `general_chat` id 404): `src/proc/minds-eye-sessions.mjs` (the six, item 8's rename included), `canSeeSession`, the dispatch, the web allow-list (18 operations) and the summarised conversation; 39 + 7 new tests. The state read checked read-only against sessions 1362, 1367 and 1372. Known edge: the lifetime-turn notice invites no reply, so a session ended by it reads *working* until the round ceiling passes |
| **3** | 🟡 **Her region** (§4.1, §4.5): left, « collapses it (remembered on the device); sessions most recently active first (U), named by label or first message (S); the open conversation as markdown; a turn's calls grouped on one line (T); `?minds-eye=<sessionId>` (R); polled while open; the *Novia* tab on a phone. **Built and deployed 2026-11-19** (`sam deploy` with item 2's routes, then `deploy-web.mjs`): `src/ui/web/app/minds-eye/` (`Region.jsx`, `conversation.mjs`), wired into the shell and the phone's tabs; her progress lines now carry `turn`, `call`, `detail` (T, `minds-eye.mjs`); gates and questions drawn read-only until item 4; 17 new tests. Not done: collapsing on her own while a run needs the full width. **Added 2026-11-21 (Javear):** her edge dragged to resize her — 280 px to 60% of the window, remembered on the device, double-click for 320 px, arrow keys too (`RegionHandle.jsx`). Its byproduct (Javear): a widened region left Money's half panels side by side in a narrow page — the grid followed the window's width. Now it follows the page's (a container query on `.main`): under 740 px thirds become halves and halves stack |
| **4** | 🟡 **Her questions:** `minds_eye_gate`, `minds_eye_continue_gate`, and a reply's `questions` with *Answer* and *Follow-up*, added to §5.2 and drawn with the existing gate components — parity with what Slack draws today. **Built and deployed 2026-11-19** (`deploy-web.mjs`): in her region (`Region.jsx`), only on the message she waits on (`answerable`): the action gate's confirm/test/Cancel, the continue gate's Continue/End with the follow-up in her box, a reply's questions with answer boxes, *Anything else* and *Send answers*; §5.2 rows added; 8 new tests |
| **5** | ✅ **Novia panels** (§4.2): the `minds_eye` panel kind — a topic's sessions, *New* starts one on the topic; at least one on a household page (`household/pages.json`). Kind `novia` renamed `minds_eye` (`7abb15c`, decision R). A panel's topic is a `domain` of the registry or free text, one of the two — a domain preferred, as it outlives a renamed panel (decision V; `b1e3b3e`). The panel is her region drawn with the topic (`MindsEyePanel.jsx`, `50821f2`); the session open is the panel's own. **Deployed 2026-11-21** (`deploy-web.mjs`; Money v4 with `ask-money` on `budgets_expenses`). Live ✅ (AC3, session 1391). **✅ DONE** |
| **6** | ✅ **`GATE_ANSWERED`** (§8, decision W): a Slack-started gate answered on the web updates the Slack message, so its buttons disappear rather than refuse. Needs the bot's history scopes (Javear, console). **Built 2026-11-21** (W): `resumeGate` sends `GATE_ANSWERED` (`gateAnsweredMessage`) once it accepts an answer — before the cancel notice, before the gate is popped; `answeredIn` from the click (`slack`) or `answerGate` (`web`, `minds_eye`); a person's run only. The listener's `postGateAnswered` reads the run's thread, finds messages whose buttons carry the gate_id and replaces the buttons with *✅ Save — answered on the web*; a thread it cannot read (`missing_scope`) is logged and left. `preservedContentBlocks` moved to `form-fields.mjs`. Inbox check widened (`migrate-pgc-uimessage-gate-answered.mjs`, run: replaced, registry ok, rerun no changes). **Deployed 2026-11-21** (`sam deploy`, `deploy-web.mjs`; no errors in the logs). Scopes added and the bot reinstalled 2026-11-22 (Javear; token unchanged). Live ✅ (AC4, run 1075). **✅ DONE** |
| **7** | ✅ **A run's thread keeps its answers** (backlog, decision L): built with item 6 as one message (W) — the web draws `GATE_ANSWERED` under its question. **Built 2026-11-21:** `ThreadView` draws it under its question — the inbox's record over the page's — and leaves it out of the messages and the fold; a form's changes counted by `src/shared/form-changes.mjs`, the web's own count moved there. 15 new tests with item 6. Live ✅ (AC4, run 1075). **✅ DONE** |
| **8** | ✅ **Renaming a session** (S): `label` on the session reads; a write route to set or clear it (spec first; principal-checked, `minds_eye` only); rename in her region and in a `minds_eye` panel. Route built with item 2. **UI built and deployed 2026-11-21:** ✎ beside the open conversation's name — a box holding its label, Enter or leaving it saves, Escape keeps the name, empty clears (`ConvoTitle` in `Region.jsx`, so the panel has it too); the web client's `patch`. Live ✅ (AC6). **✅ DONE** |
| **9** | ✅ **A list reads on as it is scrolled** (Javear, 2026-11-21, added in session): a records panel reads one page (100, or its `limit`) and stops — *Showing 50 of N*. Scrolling near its end reads the next page and adds it, until there is no more. Spec first: `offset` on `GET /sources/{source}/rows` (web and PROC); SERV's `getRows` takes an `offset`; `sources.mjs` passes it through. **Built 2026-11-21:** spec (`openapi.yaml`, its own commit); SERV `resolveReadOffset`, `LIMIT … OFFSET`, `truncated` past offset plus the page, tested against the real route; PROC `?offset` and `pageOrder` (ends on `id` where the source has one); the panel reads on when its end scrolls into view (`MoreRows`, `appendPage`), *Show more* as the keyboard and retry path; §4.2 *Reading on*. 10 new tests. The web API's allow-list now passes `offset` too. **Deployed 2026-11-21** (`sam deploy`, `deploy-web.mjs`); smoke, read-only: *Budget and spending by category*'s second page — 50 rows from offset 50, 135 matching, more to come. Live ✅ (AC7). **✅ DONE** |

## Acceptance Criteria

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ✅ | Javear starts a session in Novia's region, she replies, and after a reload the session reopens with its history — **met 2026-11-19, session 1381** (started on the web, two replies, reopened with its history) | 1, 2, 3 | Shown live |
| **AC2** | ✅ | Every Novia gate type is answered in the browser, a gated action (e.g. `propose_workflow_fix`) included — **met 2026-11-21, session 1381** (web-started): her questions answered (09:08:30), `propose_schema_fix` approved (09:09:30), the continue gate's Continue (09:12:28), `register_workflow` *Apply and test* (09:13:55); after the lost round (fixed `e9dd8e5`) she finished and tested `add_recipe` | 2, 4 | One live session per gate type |
| **AC3** | ✅ | A Novia panel on a household page lists its topic's sessions; *New* starts one on that topic — **met 2026-11-21, session 1391** (started from Money's `ask-money` panel, stored with topic `budgets_expenses`, listed in the panel after a reload) | 1, 2, 5 | Shown live |
| **AC4** | ✅ | A Slack-started gate answered on the web loses its buttons in Slack, and the answer shows in the run's thread after a reload — **met 2026-11-22, run 1075** (`process_receipt`, Slack-started): a form gate and an approval answered on the web, each Slack message found by its `gate_id` and its buttons replaced; both answers under their questions after a reload | 6, 7 | Shown live |
| **AC5** | ✅ | Each new endpoint is in `openapi.yaml` before it is built, as its own commit; every minds-eye session read checks the principal and returns `minds_eye` sessions only — a `general_chat` or `llm_call_diagnostic` id is a 404 — **met 2026-11-22**: reviewed — each spec commit precedes its code and holds only docs (`c4548aa`→`dff4be4`, `2f021bb`→`7d393dd`, `006b53f`→`6d89f40`, `7d90ada`→`0f10905`); spec, web allow-list and PROC dispatch name the same six operations; every id route refuses through `loadSession`. The refusals were only smoke-tested, so route tests added against stubbed SERV (404 on all four id routes for both other types, 403 for another person's session, the list's filter and cursor), each shown to fail with its check removed | all | Review as each lands, and tests |
| **AC6** | ✅ | Javear renames a session on the web; the new name shows in her region and its panel, and survives a reload — **met 2026-11-21**: 1381 renamed in her region, 1391 in Money's panel, both kept after a reload | 1, 2, 8 | Shown live |
| **AC7** | ✅ | A records panel longer than its page (Money's *Budget and spending by category*, *Expenses*) reads on as Javear scrolls, to its last row — **met 2026-11-21**, Javear scrolling Money's lists | 9 | Shown live |

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

**2026-11-21 (session 3).** Item 5 built and deployed (kind `minds_eye`, decision V, the panel
on Money). AC2 under way (Javear, session 1381): gates answered on the web, then the session
looked hung after an approved `register_workflow` — the action ran, then SERV refused a call and
the round threw. Cause: Lambda throttling at the account's concurrency of 10 (SERV throttled 17×,
PROC 4×, concurrency flat at 10, 09:08–09:19); the web app's polling holds three functions per
read. Javear requested 1000 in Service Quotas (2026-11-21), approval pending. Fixed in Execution (`e9dd8e5`,
deployed): a round that throws now tells the person it stopped, with the follow-up, instead of
vanishing. From the computer after 1381: her region widened to
its longest session name (a flex item's automatic minimum) and the collapsed strip showed » alone
— fixed and deployed (`026930e`): the region holds 320px, the strip names her.
Later the same session: AC2 and AC3 met; item 8 (rename) built, AC6 met; her edge made draggable
(Javear). Its byproduct — Money's halves side by side in a narrowed page — fixed with a container
query. Item 9 added and done (records panels read on as scrolled, AC7 met). Decision W merged items
6 and 7 into `GATE_ANSWERED`; built and deployed, the inbox check migrated. **Blocked:** AC4 waits
on Javear adding the bot's `channels:history`, `groups:history`, `im:history` scopes (Slack app
console, then reinstall). Then AC5's review and the sprint close. Concurrency quota: still pending.

**2026-11-22 (session 4).** Javear added the bot's history scopes and reinstalled (token
unchanged). AC4 met live on run 1075 (`process_receipt`, started in Slack): a form gate and an
approval answered on the web, each Slack message found by its `gate_id` and its buttons
replaced, both answers under their questions after a reload. On the same run Javear saw Slack
draw step 11 differently and asked whether the web work had reached Slack. It had not: step 11's
`multi_select` (a multi-select menu in Slack since July) came from the workflow, changed
2026-11-18 with Novia; the reveal headings' emoji came with the same change, and Slack showed
their names because the reveal title went out without `emoji: true` (unchanged since August).
Fixed and deployed (`emoji: true`, Execution); the iPhone app draws the icons, Slack desktop
still shows the names in a collapsible container's title even with the flag — Slack's own
rendering, left as is. AC5 reviewed: spec before code throughout; the refusals had been proved
only by the 11-19 smoke, so route tests added (13), each shown to fail with its check removed.
Concurrency quota raised to 1000 (approved). Sprint closed.

## Outcome — closed 2026-11-22

**The household talks to Novia on the web page.** Her region sits left of every page — collapsed
to a strip, dragged wider, a tab on a phone — listing sessions by last activity, named by their
label or first message. A session is started, continued, renamed and reopened there with its
history, and her gates and questions are answered in place. A `minds_eye` panel keeps one domain's
or topic's sessions on a page (Money's `ask-money`). A gate answered anywhere is kept in the run's
thread, and Slack's buttons for it disappear when it was answered on the web.

**Built:** `PGC_Session.callback` in place of `slack_thread_ts` (migrated add → backfill → deploy
→ backfill → drop, 228 sessions), `topic`, `label`, `last_active_at` kept by a trigger;
`PGC_UiMessage.session_id`. SERV's `POST /serv/schema/addTrigger`, its functions from a catalogue
(`trigger-functions.mjs`) and never SQL from the caller; `createTable` checks triggers the same way.
PROC's six `/proc/minds-eye/sessions…` routes (`minds-eye-sessions.mjs`, `canSeeSession`) and
the web allow-list. The web app's region (`minds-eye/`), `MindsEyePanel.jsx`, the panel kind
`minds_eye`. `GATE_ANSWERED` from `resumeGate`, drawn by the web and acted on by Slack's
listener. `offset` on records reads, panels reading on as scrolled. Engine fixes found live in
session 1367: progress lines without buttons (`invitesReply`), an empty *Send answers* answered,
a continue gate's `reason`, a truncation notice carried across a round (`afterTruncation`), and a
round that throws now says so. Spec 3.10.0 → 3.11.0. Unit tests 1774 → 1976.

**Known edge, not fixed:** the lifetime-turn notice invites no reply, so a session it ends reads
*working* until the round ceiling passes.

**To the backlog-history:** a run's thread keeps its answers (decision L), done as items 6–7.
**Stays in the backlog:** the custom domain, managing a session's topic.

## Retro

**What went right.**

*Decisions were taken in one line each, and some mid-sprint.* O to W: four of them (S, T, V, W)
were raised by Javear during the sprint and settled before the code was written. W merged two
scope items into one message and saved a second mechanism (`GATE_RESOLVED`).

*Live use found engine defects, and each was fixed the same day.* Session 1367 alone surfaced four:
buttons on progress lines, a silent empty click, a continue gate claiming a limit it never hit, a
truncation notice lost between rounds. None was a web defect; using Novia on the web exposed them.

*A missing capability was built as a capability.* `last_active_at` needed a trigger on a live
table and SERV had no way to add one. It got a route that installs named functions from a
catalogue, rather than a one-off script or SQL passed through.

*The schema migration ran cleanly across a deploy.* Add, backfill, deploy, backfill again, drop,
with a rerun that was a no-op at each stage, and a script that replays on any older instance.

**What went wrong, and what it says.**

*The account's concurrency of 10 throttled Novia mid-session.* AC2's round died after an approved
action: SERV was throttled 17 times while the web app polled, and each web read holds three
functions at once (web API, PROC, SERV). **A polling client multiplies concurrency; check the
account's Lambda limits before adding one.** The quota is now 1000, and a round that throws says
so instead of vanishing.

*A difference in Slack looked like the web work breaking it.* Javear asked, reasonably, how far
the web changes had reached Slack. The evidence said not at all: a workflow change, plus a latent
gap in the renderer that a new emoji in a label exposed, plus Slack desktop drawing container
titles differently from the phone. But Slack's rendering is checked only by unit tests on block
shapes, which say nothing about how a client draws them. **When Slack looks different, read the
workflow's current definition and the renderer's history before suspecting the web change; and
when a sprint touches `/ui/slack`, a gate run in Slack is part of its live checks.**

*The spec's version never moved.* About 500 lines went into `openapi.yaml` across five spec-first
commits and `info.version` stayed at Sprint 17's 3.10.0 until the close. **A spec-first commit
bumps the version it changes.**

*A backfill came up short by a fraction of a millisecond.* A JS `Date` keeps milliseconds and the
column keeps microseconds, so the rerun found every row "different". **Copy a timestamp between
columns as text, never through a `Date`.**

*A route's refusals were proved only by a smoke run.* The predicate was unit-tested, but nothing
ran a route against a stored session, so AC5 had to add the tests at close. **A route that
refuses is tested through the route, against a stubbed read, in the commit that adds it.**

