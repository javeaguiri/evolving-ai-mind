# Sprint 14 — A web front end, Phase 0

**Status: CLOSED 2026-10-31.** Started 2026-10-22 (Javear); scope confirmed with two changes: R1 to the backlog, encryption at rest in. Outcome and retro at the end of this file.
**Narrowed 2026-10-30 (Javear): Sprint 14 finishes as a design sprint — AC0 is its deliverable. Sprint 15 is Novia: cost (the Anthropic API directly) and testing her own work end to end.**
Read `docs/sprints/sprint-13.md` §Retro and `docs/arch-home-brain.md` (§3, §4.4, §4.6, §4.7, §4.10) first.

**Branch:** `sprint/14-web-phase-0`

> **Decided 2026-10-18 by Javear.** Slack is not cutting it as the main interface — editing a
> spreadsheet of data is what proved it — and it stays a good accessory. The front end is a
> **web site** (responsive, one codebase for phone and desktop). The goal is **general
> acceptability, not multi-tenancy**: tenancy waits until the construction-company partner has
> firmly committed. Build for one household, keep the habits in `arch-home-brain.md` §3.3.

---

## Sprint Goal

**Design the web app in detail, then prove a second experience layer works end to end: a web site that shows a waiting gate,
takes the answer, and resumes the run — with a `form` gate rendered as a real editable grid.**

This is the Home Brain design's Phase 0 (§4.10). It proves the seam in §3.1 holds for a second
provider, and that a grid answers the bulk-edit ceiling Slack cannot.

---

## Scope

| # | Item |
|---|---|
| **0** | ✅ DONE — approved 2026-10-31 (v0.5). **A detailed design of the web app — first, and approved before any build (Javear, 2026-10-18).** `docs/arch-home-brain.md` is a v0.1 proposal: layout, regions, flows and phasing at sketch depth. The detailed design takes it to buildable for Phase 0 and Phase 1, as `docs/arch-web-app.md` (the Home Brain doc keeps the product direction and the tenancy model). It settles: **hosting** and how the site reaches PROC without the internal API key; **sign-in** for one user; **framework**; **result delivery** (polling vs push); **pages and navigation** at phone and desktop width; **every gate type's web rendering** from the provider-neutral `dialog`, including the editable grid (§6.4's grid hint); the **API surface** in `openapi.yaml` terms; **error, empty and loading states**; how a **Slack-started run answered on the web** shows it (§6.2); and **what Phase 0 builds versus what Phase 1 adds**. Wireframes are part of it |
| **1** | **The web provider, end to end — Phase 0.** Spec first in `docs/openapi.yaml`: `GET /gates`, `POST /gates/{runId}/responses`, `GET /inbox` (§4.7). `provider: 'web'` routed by `callback.provider` (§4.6). A site shell that lists waiting gates and answers them. Results reach the site rather than Slack for a web-started run |
| **2** | **A `form` gate as an editable grid** — the shape Slack could not render. Open question §6.4 (the grid hint: row key and column label on the `human_gate` contract) is settled here, and Sprint 13's field `group` heading folds into it |
| **3** | **`manage_budget` (= `edit_budget`, 357 v7) as the Phase 0 workflow** — one column, ~21 rows, the grid's natural first consumer. Its four Sprint 13 findings go to Novia as findings: every save writes all 21 rows; amounts are `text`; `currency: 'USD'` hardcoded in a euro household; grouping by label prefix |
| **4** | **Sign-in for one user.** The site is public-facing, so it needs a real identity even with one user: the browser never holds the internal API key, and identity comes from the token, never the request body (§3.3). Mechanism decided at "start sprint" |
| ~~**5**~~ | ~~Release readiness R1–R3, moved forward~~ — **R1 moved to `docs/backlog.md` at "start sprint" (Javear, 2026-10-22).** R2 is blocked by R1 and held with it. Consequence, accepted: the site is built against prod |
| **6** | **Encryption at rest for PostgreSQL (Javear, 2026-10-22).** RDS `StorageEncrypted` is absent and cannot be switched on in place: snapshot → encrypted copy → restore. Two things make it more than a toggle: `EvoMindDB` is a CloudFormation resource with a custom `DBInstanceIdentifier`, so setting `StorageEncrypted: true` in `template.yaml` asks CloudFormation for a replacement it cannot perform under a custom name; and writes after the snapshot are lost unless the system is quiet during the cut. Plan (endpoint kept by renaming the restored instance to `SYSRDSEvoMind`, template brought back in line with the live instance, KMS key choice — AWS-managed free vs customer-managed ~$1/month) written and agreed before any AWS action. No longer waits for the Aurora decision (R5) |
| **7** | **Novia's prompt cache holds across a session (Javear, 2026-10-24 — added in-sprint).** Oct 24 cost $14.67 for 50 Opus calls: session 1261 had grown to 234K tokens over three days, and 20 of its calls rewrote the whole prefix at $5/M where a read is $0.20/M. Three causes, all Execution: (a) Layer 1 lists every workflow's version inside `instructions`, so each approved `propose_workflow_fix` invalidates the prefix (4 misses, $4.11); (b) a prose reply rebuilds as an assistant message plus a user turn, not as the respond call it stands for, and every round started after one read back only tools + instructions (4 of 4, vs 1 of 1 hit after a respond call; $2.44 on Oct 24); (c) the 5-minute TTL expires between Javear's turns (7 misses, $5.35) — **not fixable on `/v1/agent` (measured 2026-10-24):** the gateway accepts `prompt_cache_options: { ttl: '1h' }` (an unknown field is a 400) but ignores it — the write is billed at the 5-minute rate (1.25×, not 2×) and the identical request 7 minutes later rewrote all 13,171 tokens with no read. (a) and (b) ✅ DONE, deployed (`b6cba4c`) |
| ~~**8**~~ | ~~`read_workflow_run` — a Novia read tool for run data~~ — **moved to `docs/backlog.md` the day it was added (Javear, 2026-10-25)**, with the wake and the test-data policy |
| **9** | **`answer_gate` — Novia answers a gate in a run she started (Javear, 2026-10-25 — added in-sprint).** The first step towards Novia testing her own builds, fixes and enhancements inside the cache TTL, keeping Javear out of the test-troubleshoot-repair loop. Built on scope item 1's provider-neutral `POST /gates/{runId}/responses` with `gate_id`, not a second resume path. Refused for any run she did not start (`triggered_by: 'minds_eye'` in her session) and always for the gates that guard her own gated writes — those remain Javear's. Not in scope: waking her when her run reaches a gate (a run outlives her round budget), and a policy for test data written to prod (she handled it by hand for the receipt test — see session 5) |

## Acceptance Criteria

**Final, 2026-10-31 (sprint closed).** ⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved.

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC0** | ✅ **Approved (Javear, 2026-10-31)** — `arch-web-app.md` v0.5: v0.4's pages of panels (workflow, data, Novia), widgets as data representations, workflows stepped through as in Slack, reports refreshed by re-running, 🧠 Help apart from ⚙ Settings, ceilings owned by the renderer (§5.4); v0.5's Pages/Domains/Activity menus across the top, Novia on the left, Phase 0 drawing the household's pages read-only; **mock-up v0.5** at <https://claude.ai/artifact/V13D3yERqnvQDkm8Xsuu8z> | `docs/arch-web-app.md` covers every point in scope item 0, with wireframes, and Javear approves it before Phase 0 code starts | [0](#scope) | Approval |
| ~~**AC1**~~ | ~~⬜~~ — **moved out: Sprint 14 is design only (Javear, 2026-10-30)**; to the web build sprint | A run started from the web site suspends at a gate, the gate appears on the site, and answering it there resumes the run to completion — no Slack involved | [1](#scope) | Binary, live |
| ~~**AC2**~~ | ~~⬜~~ — **moved out with AC1 (Javear, 2026-10-30)** | `manage_budget` edits all its amounts in one editable grid on the site, grouped by budget type, and one save writes **only the changed rows**, as numbers, in the household's currency | [2](#scope), [3](#scope) | Binary, live |
| ~~**AC3**~~ | ~~⬜~~ — **moved out with AC1 (Javear, 2026-10-30)** | The site requires sign-in, and no request from the browser carries the internal API key | [4](#scope) | Binary |
| ~~**AC4**~~ | ~~⬜~~ — **moved out with AC1 (Javear, 2026-10-30)** | Slack still works unchanged for a run started from Slack | [1](#scope) | Binary, from Slack |
| ~~**AC5**~~ | ~~⬜~~ | ~~R1 lands~~ — **moved to `docs/backlog.md` with R1 at "start sprint" (Javear, 2026-10-22)** | ~~5~~ | — |
| ~~**AC6**~~ | ~~⬜~~ — **moved out: design-only sprint (Javear, 2026-10-30)**; placed at sprint close | The prod database is encrypted at rest: `StorageEncrypted: true` on the live instance, `template.yaml` matches the live instance, every table's row count unchanged across the cut, and the Lambdas reach it with no SSM change or with the change made through a version-pinned deploy | [6](#scope) | Binary, verified live |
| ~~**AC7**~~ | ~~🟡~~ (a) and (b) deployed 2026-10-24; (c) not fixable on the gateway — **moved to Sprint 15 with Novia's cost work (Javear, 2026-10-30)**, where the Anthropic API's 1h TTL answers (c) | A Novia round that follows an approved workflow fix, or a prose reply, reads its prefix back from cache rather than rewriting it; the logged `cacheRead` on the round's first call covers the transcript, not only the 17,270-token tools + instructions block | [7](#scope) | Binary, from the proc logs on a live session |
| ~~**AC8**~~ | ~~⬜~~ | ~~Novia reads a live run with `read_workflow_run`~~ — **moved to `docs/backlog.md` with scope item 8 (Javear, 2026-10-25)** | ~~8~~ | — |
| ~~**AC9**~~ | ~~⬜~~ — **moved to Sprint 15, Novia testing her own work (Javear, 2026-10-30)** | Novia answers a gate in a run she started and the run resumes through the same `POST /gates/{runId}/responses` path the web uses; an answer to a run she did not start, or to a gate guarding her own gated write, is refused | [9](#scope), [1](#scope) | Binary, live |

## Carried from Sprint 13, not scoped here

| Item | Where it goes |
|---|---|
| Sprint 13 AC3 — Novia selects the pattern unprompted, on Opus 5.5 | Observed when she next designs cold; not a sprint target |
| Sprint 13 AC4 — oversized-gate failure, `preview_step`, measuring Slack's size limit | `docs/backlog.md` (Step preview). The Slack ceiling stops being the binding limit once the grid is on the web |
| Sprint 13 AC6 — the inventory correction workflow, aliases 81 / 60 / 59 | Deferred; next sprint that has room |

## Open at "start sprint"

The four open questions — hosting, sign-in, framework, result delivery — are answered **in the
design** (scope item 0), not at scoping. What "start sprint" settles is only whether this scope
and these ACs are right.

## Out of scope

| Item | Why |
|---|---|
| Multi-tenancy, several household members | Waits for the partner's commitment (Javear, 2026-10-18) |
| Phase 1's full console — navigator, command bar, Novia panel, direct edits | Phase 0 proves the seam first |
| Removing the Slack leaks in `arch-home-brain.md` §3.2 | Phase 1, except where Phase 0 needs one gone |

## Session Notes

### Session 8 — 2026-10-31 — v0.5 approved: AC0 met

**Javear on v0.4:** command bar kept apart from Novia, as designed. Phase 0 should not ship an empty
Home: build three pages — Home, Money, Inventory — as fixed pages until Phase 1 brings the editor.
A Novia topic is set only from its panel, and the user keeps the session on it; deleting, moving and
adding sessions to a topic come later (backlog). Desktop: Novia to the left of the page panels, and
the navigator's Pages / Domains / Activity as menus across the top, opening on hover.

**Agreed (Javear):** the three pages are `PGC_Page` rows written by `upsert-page.mjs` from a
household file outside the system seeds, drawn read-only — so Phase 0 builds every widget but
`form`, tables read-only, plus `GET /sources/{source}/rows` and `GET /outputs/{workflow}`; the page
editor stays Phase 1. 🏠 always goes Home. Menus open on hover and on click. Novia collapses with «,
steps aside while a run needs the width, and is remembered on the device. `set_session_topic`
dropped.

**Written:** `arch-web-app.md` v0.5 (status Approved) — §2.3, §2.5, §3.1/3.2, §4.1 rewritten, §4.2
phases per widget, §4.5, §4.8, §10, §12 Q4 removed, §13; `arch-data.md` §4.3.8 and
`arch-home-brain.md` §4.1, §4.3 to match; backlog item for topic management. **Mock-up v0.5**,
republished at the same link, source `docs/web-app-mockup/console-v0.5.html`.

**Javear: "that will complete the design of the web app"** → AC0 ✅. Next: close Sprint 14.

### Session 7 — 2026-10-31 — navigation v0.4: panels, widgets, workflows as in Slack

**Javear on v0.3:** further from what he wants; `arch-home-brain.md`'s layout is closer. 🧠 is
help — what the brain can do, how to configure pages — not settings; ⚙ is the user's settings.
A widget is a representation of data (table, graph, report, form) over a domain, table or view,
never tied to a step or gate type, and a workflow's questions must not be spread across a page:
workflows run as in Slack, from a panel that starts them and shows their history. Reports a
workflow produces stay on the page and refresh by re-running it. The web should fix Slack's display
limits, such as unnecessary paging.

**Agreed (Javear):** (1) two levels — a page holds panels of three kinds (workflow, data, Novia); a
widget is the representation inside a data panel; nesting fixed by the kind, never assembled by the
user. (2) One workflow, not two versions: the gate carries the whole set and each renderer handles
its ceiling — Slack pages lists itself and picks one row of an oversized grid.

**Written:** `arch-web-app.md` v0.4 — §4 rewritten (shell, pages/panels/widgets, click-through,
workflows as in Slack, domain pages, Novia, 🧠 Help, ⚙ Settings, routes), §2.3 `PGC_Page.panels`,
§2.5 session topics, §2.6 a workflow's latest output, §3 `GET /outputs/{workflow}`, §5.4 ceilings
owned by the renderer, ripples in §6, §9, §10, §12, §13; `arch-data.md` §4.3.8 and
`arch-home-brain.md` §4.2, §4.4 to match. **Mock-up v0.4**, a new standalone page (the v0.2 canvas
artifact cannot take a page of its own): <https://claude.ai/artifact/V13D3yERqnvQDkm8Xsuu8z>, source
`docs/web-app-mockup/console-v0.4.html`.

**Next session starts here:** Javear's review of v0.4 (doc §4 and mock-up) → AC0 approval → close
Sprint 14 → scope Sprint 15 (Novia).

### Session 6 — 2026-10-30 — design-only sprint; navigation v0.3; Node's October CVEs

**Javear's review of v0.2:** one Ask for workflows and Novia is not clear — keep them apart;
workflows are grouped by workflow or get a widget each, and every run is **labelled** (*Mercadona ·
17 Oct*, *Burger King · 12 Oct*) so receipts are picked from a list; a first-run view says *"You
don't have any process receipts runs — they will be shown here."* Page tabs and Settings are
different things: tabs preset or user-made; Settings is profile, security, language, date display,
wallpaper. Then: preset pages, custom pages, menu items and settings were mixed — he will step back
and think; **v0.3 written as the other pass he asked for** (`arch-web-app.md` §4, §2.4 run labels,
§3.1 `POST /runs`, `GET /runs`, `GET /workflows`; `arch-data.md` §4.3.8 `PGC_WorkflowRun.label`,
`display.run_label`). The mock-up is not yet redrawn.

**Decided (Javear): Sprint 14 finishes as a design sprint; Sprint 15 fixes Novia** — her cost is
affecting his ability to use her: Novia on the Anthropic API directly (backlog's top item), and her
testing her own work end to end (`answer_gate`, `read_workflow_run`, the wake, the test-data
policy). AC1–AC4, AC6 moved out; AC7, AC9 to Sprint 15.

**Node.js — the October 21 security release ("Black October"), not yet acted on.** 10 CVEs on
22.x/24.x/26.x, fixed in **22.23.4**; CVE-2026-111497 (bundled Brotli decoder, out-of-bounds write,
RCE via `fetch()` decompression) is on CISA's KEV list since Oct 27, and we `fetch()` the gateway
and Slack. This box runs `v22.22.2` (unpatched). Lambdas are `nodejs22.x` in Auto runtime mode:
`proc` on `nodejs:22.mainline.v154` (deployed 10-24), `serv`, `slackbot`, `slack-callback-listener`
on `v122` — the runtime label does not give the Node version. `npm audit --omit=dev`: 3 high
(`axios` 1.13.6, `form-data` 4.0.5, `fast-uri` 3.1.0), 2 moderate (`follow-redirects`, `uuid`),
all fixed by `npm audit fix` without a major bump. **Proposed, awaiting Javear's go:** an
`ops/node-oct-2026` branch — update Node on this box, `npm audit fix`, unit tests, log
`process.version` at cold start, deploy all four functions, confirm ≥ 22.23.4 from the logs.

**Patched and deployed the same session (Javear's go), branch `ops/node-oct-2026` (`3529a1c`):**
build host on Node 22.23.4 (dnf); `npm audit fix` (axios 1.21.0, form-data 4.0.6, fast-uri 3.1.9,
follow-redirects 1.16.2, uuid 11.1.1) — production audit 0 vulnerabilities; a `cold start { node }`
log in `lambda-utils.mjs`; 1185 tests pass; all four functions redeployed onto runtime
`nodejs:22.mainline.v158`, and `serv`'s cold start logs **`v22.23.4`** (the four share one runtime
ARN). Left: esbuild's low advisory (Windows dev server only; the fix is a minor-version bump);
`ops/node-oct-2026` awaits merge — prod now runs it.

**Next session starts here:** Javear's verdict on v0.3's navigation → mock-up v0.3 → AC0 approval → close Sprint 14 → scope
Sprint 15 (Novia).

### Session 5 — 2026-10-25 — Novia tests her own work

**Javear on Novia's inventory-quantity work (sessions 1261, 1270), on Opus 5.5:** she found the bug
Wren had found, fixed it without new bugs, and supplied a test grocery receipt that exercised her new
code. She cleaned up after the test herself: she stored the before values in memory, reverted
them, and deleted the test row from the test table. Her one cost was Oct 24's spike, part of it
the 6–7 minutes Javear spent testing between her replies (the TTL misses, $5.35 of $14.67).

**Added in-sprint (Javear): scope item 9 / AC9** — `answer_gate` on scope item 1's gate-response
endpoint, the first step towards Novia testing her own work inside the TTL. `read_workflow_run`
(item 8 / AC8) was added and then moved to `docs/backlog.md` the same session, beside the wake and
the test-data policy.

**AC0 — the navigation redesigned (Javear: a new user would be confused; why Threads *and* Novia?).**
`arch-web-app.md` §4 rewritten: the household's own **pages of widgets** are the navigation (a page
is an evolving artifact, `PGC_Page`, §2.3; a widget type is system code, as a step type is); one
**Ask** drawer, where a workflow answers if one matches and Novia otherwise (Phase 1 — intent routing
does not reach Novia today, it answers *"I could not complete that request"*); **⚙** holds the
machinery (How your brain works, generated from the registry; All data; Activity; Workflows;
Memory; Settings); **ⓘ** on every widget and term, on hover and on tap. Ripple edits in §3, §6, §8–§10,
§13; `arch-data.md` §4.3.8 gains `PGC_Page`. Mock-up rebuilt as v0.2 (same link), with a P0/P1
switch showing what Phase 0 builds: a seeded Home with Needs you and Conversations.

**Close:** Javear on v0.2 — *"Much better… we are close"*; he is still considering it, so AC0
stays 🟡. Open for his review: first-run Home (only Needs you and Conversations), page tabs plus ⚙
as two navigation surfaces, and one Ask for both workflows and Novia. **Next:** AC0 approval, then
`openapi.yaml` spec-first (incl. `GET /pages`); meanwhile, not blocked by AC0: AC7 evidence from
the proc logs and the AC6 encryption plan.

### Session 4 — 2026-10-24 — the 1h cache TTL, tried twice more; cheaper models priced

**`/v1/agent` re-measured with `prompt_cache_key` added** (the session 3 probe sent only
`prompt_cache_options: { ttl: '1h' }`). Same 19,251-token Opus 5.5 request twice, 8 minutes apart:
both calls wrote 19,247 tokens at $0.0962 ($5.00/M = 1.25 × the $4 input, the 5-minute rate; 1h
would be 2×) and the second read **0**. Ignored, with or without a cache key. **The
`/orchestrator/v1/chat/completions` endpoint** from a Perplexity snippet (also takes the key and the
TTL) returned **403 — limited preview, access by request to api@perplexity.ai**; untested, and it
takes chat messages, not the items `callLlmWithTools` echoes for cache credit. Neither changes
AC7 or the backlog's top item.

**Cheaper models for Novia, priced only** (`docs/perplexity-agent-llm`): Sonnet 5.5, gpt-6.1-sol and
gemini-4-argon are half Opus 5.5 on input, output and cache read ($2 / $10 / $0.10); DeepSeek v4 pro
and GLM 5.3 about a third; grok-4.7's cache read is 2.5× dearer. Her bill is input-dominated, so
Oct 24 would have roughly halved. Comparability is not evidenced — her failures on sonnet-4-6 were
reasoning (runs 887, 911). Proposed, not done: Sonnet 5.5 first (same caching behaviour), trialled
on a cold task with a known right answer, cost read from the proc logs; switching is a
`minds_eye_preferences` seed change.

**Next session starts here:** unchanged from session 3 — AC7 evidence, AC0 review, `openapi.yaml`,
AC6 plan. Javear decides whether to trial Sonnet 5.5 for Novia.

### Session 3 — 2026-10-24 — Novia's cost spike; design docs filled in

**The cost spike (scope item 7 / AC7, added in-sprint).** Perplexity billed $14.71 on Oct 24; the
proc logs put **$14.67** on Novia's 50 Opus calls. Session 1261 (one Slack thread, Oct 21 → Oct 24,
80 turns) had grown to 126K–234K tokens a call, and 20 calls rewrote the whole prefix at $5/M
where a read is $0.20/M. Causes, all Execution: Layer 1 workflow versions in `instructions` (4,
$4.11); prose replies rebuilt as assistant + user turn (every within-TTL round after one read back
only 17,270 tokens, 4 of 4; $2.44); the 5-minute TTL across Javear's pauses (7, $5.35). **Fixed and
deployed (`b6cba4c`):** versions dropped from Layer 1; a respond with no gateway call rebuilds as a
respond call. 1185 tests. **The 1h TTL is not available on `/v1/agent`** — accepted, ignored
(billed at the 5-minute rate, gone after 7 minutes). **Unexplained:** Javear's dashboard shows
~$0.10–0.15 on Oct 18 and 22 where the logs record $6.10 and $1.38. Novia calling Anthropic
directly is now the backlog's top priority (`7dad024`); it needs an Anthropic Console key, which
Javear stores in SSM when it is built.

**Docs:** `arch-home-brain.md` §3.3 habits 4–5 (request order for caching; cache isolation between
households). `arch-web-app.md` §7.1 (how a gate reaches either provider — `buildDialog` must carry
`row`/`column`/`group`, which it does not today; `group` is not rendered in Slack either) and §7.2
(code layout — Slack pushes, the web pulls). `arch-data.md` §4.3.8 — `PGC_UiMessage`,
`PGC_RecordEdit`, and the `display` / edit-policy / `gate_id` changes, marked designed, not built.

**Next session starts here:** AC7's evidence — Javear's next Novia session; check the proc logs
for a full `cacheRead` on the first call after an approved fix and after a prose reply (`17270` is
the failure signature). Then Javear's AC0 review of `arch-web-app.md` (now with §7.1–7.2), then
`openapi.yaml` spec-first, then the AC6 plan. Novia on the inventory consumption rates (sessions
1261, 1270): `review_inventory` v12, `process_receipt` v13 — her work, not touched from here.

### Session 2 — 2026-10-22 — "start sprint"; the design session

**Sprint started (Javear).** Scope confirmed with two changes: R1 → backlog (AC5 struck), and
encryption at rest → scope item 6 / AC6. This session works on **scope item 0 only**. The wireframes
will be seen by the construction-company partner, so they are a **working mock-up** (a visual page), not
ASCII sketches.

**Memory 424 is still live** (read 2026-10-22: the v1 build memory, "54 fields … within ~40-field
ceiling", episodic, priority 3). Novia deleted **422**; 424 was not deleted along with it.

**In parallel, unscoped (Javear):** fixing inventory-quantity adjustment with Novia in session 1261.
Not touched from this session.

**Design work (scope item 0):** `docs/arch-web-app.md` v0.1 — platform tentative (CloudFront + S3,
`WebApiFunction`, Cognito, React + esbuild, polling), `PGC_UiMessage` inbox, `gate_id` (a stale
answer is applied to a later gate today), grid hints and where they are written, domain views (grid,
document) from registry `display` metadata, what is shared with Slack, security §11, languages §13.
**Javear's decisions:** the REST CRUD layer never depends on workflows; direct edits are Phase 1.
Checked live: the registry's foreign keys match the database (an earlier "null" was my misread of
`foreignKeys` for `foreign_keys`); SERV entity writes touch the root table only — no children, no
transaction, no re-embed — recorded as Phase 1 SERV work (§6.4). `docs/arch-security.md` revised
(agent threats, S1–S6, findings F1–F8) with seven backlog rows; `docs/arch-home-brain.md` §7 —
multilingual analysis. **Mock-up:** https://claude.ai/artifact/CiBwcLPCVTH3YfKt85L1ro (private until
shared) — clickable console, two phone frames, every gate type and state. **Next:** Javear reviews
the design and mock-up offline; AC0 closes on approval.

Later in the session: the multilingual design gained §7.3 in `arch-home-brain.md` (translated text
lives in the artifact as language maps, system text in catalog files — **no translation table**;
`arch-data.md` unchanged until `display` is added), and `arch-web-app.md` §3.2 / §6.3 / §13 gained
navigation as data (`GET /domains` shape, `display.label/description/icon/order/menu`, label
fallback marked `labelFallback`). Mock-up source committed to `docs/web-app-mockup/`.

**Next session starts here:** Javear's review of `docs/arch-web-app.md` v0.1 and the mock-up →
approve (AC0 ✅) or revise. Then, before any Phase 0 code: scope item 1 spec-first in
`docs/openapi.yaml` (`GET /gates`, `POST /gates/{runId}/responses`, `GET /inbox`, `POST /commands`,
`GET /me`); and AC6's encryption-at-rest plan, written and agreed before any AWS action. Session
1261 (Novia, inventory quantity) was Javear's parallel work — ask its outcome. Memory 424 still live.

### Session 1 — 2026-10-18 — before scoping: `manage_expenses` v10, and Novia on Opus 5.5

**Novia's model verified from the proc logs:** every `callLlmWithTools` call before the 13:10 switch
was `anthropic/claude-sonnet-4-6`; every call since — session 1236, 14:27–14:30 — is
`anthropic/claude-opus-5-5`.

**360 v10 (her first work on Opus):** Delete is an `option` with `condition:
local_state.edit_state.edit_id`, hidden for a new record — closing Sprint 13 AC7's one accepted gap.
She also split step 11 into `serv_insert` (11a) / `serv_update` (11b) on a **false diagnosis** —
*"saving a new expense has never worked"*, from runs 903/904, which predate `3ce72e9`; runs 905/913
had inserted rows 289–303 through the upsert. Sound and harmless, but it repeated the habit her own
retrospective lists second: diagnosing without reading the later runs.

**Run 916 (v10) — completed, every step:** edit (258 Car Insurance → €0, via 11b), add (304
"Delete me", via 11a, category 17, debit, EUR), delete (304 `deleted_at` set). Delete-on-Add is
hidden — **confirmed from Slack by Javear** (`edit_id` is `''` on Add). Her request to delete stale memories 422 and the
v1 build memory awaits Javear.

**Next session starts here:** "start sprint" — read back this scope and its ACs for Javear's
confirmation, then scope item 0, the detailed design (`docs/arch-web-app.md`). Open with him: whether
the wireframes are for his review only or also to show the construction-company partner (a visual
page if so). Novia deleted stale memory 422 (verified); the v1 build memory (**424**, "54 fields … within ~40") is still there.

## Outcome — closed 2026-10-31

**8 sessions, branch `sprint/14-web-phase-0`. 1184 → 1185 unit tests** (the `cold start { node }`
log on `ops/node-oct-2026`). **A design sprint by decision** (Javear, 2026-10-30): **AC0 met**, the
rest moved — AC1–AC4 and AC6 to the web build, AC7 and AC9 to Sprint 15.

**AC0 met — `docs/arch-web-app.md` v0.5, approved 2026-10-31.** Platform (tentative): CloudFront +
S3, Cognito, `WebApiFunction`, React + esbuild, polling. `PGC_UiMessage` inbox, `gate_id`, run
labels, session topics, a workflow's latest output. Pages of panels — workflow, data, Novia — with
widgets as data representations; workflows stepped through as in Slack; reports refreshed by
re-running their workflow; ceilings owned by the renderer, so a workflow is never written twice.
Pages / Domains / Activity menus across the top, Novia on the left. Phase 0 draws the household's
own pages read-only; the page editor, Novia and editing records are Phase 1. Mock-up v0.5:
<https://claude.ai/artifact/V13D3yERqnvQDkm8Xsuu8z> (`docs/web-app-mockup/console-v0.5.html`).
Five versions in ten days: v0.1 platform, v0.2 pages of widgets, v0.3 menu groups, v0.4 back to
the console, v0.5 menus on top.

**Shipped, deployed:** Novia's prompt cache — Layer 1's workflow versions out of `instructions`, and
prose replies rebuilt as respond calls (`b6cba4c`, AC7 (a) and (b)); Node's October 21 security
release and `npm audit fix` on `ops/node-oct-2026` (`3529a1c`, all four functions on Node 22.23.4).

**Measured, not fixable here:** the gateway's `/v1/agent` accepts a 1h cache TTL and ignores it,
with or without a cache key — the reason Sprint 15 moves Novia to the Anthropic API.

## Retro

**What went right.**

*A clickable mock-up settled what prose could not.* v0.2's and v0.4's reviews were specific because
Javear could click through them; v0.3 went to him as a document only, and his answer was that it
had drifted. Each revision after a mock-up changed less than the one before.

*Asking two yes/no questions before rewriting.* v0.4 began with the two structural choices — panels
hold widgets, the renderer owns the ceiling — put to Javear first ("1 Yes, 2 Yes"). The rewrite then
had nothing to re-argue.

*The platform's limit, again, read rather than assumed.* The 1h TTL was probed three ways against
the gateway before the backlog's top item was written, so Sprint 15 starts from a measurement.

**What went wrong, and what it says.**

*The design drifted from the direction its owner had already approved.* v0.2 and v0.3 moved away
from `arch-home-brain.md`'s console layout, which Javear had accepted, toward structures of my own
(one Ask, ⚙ machinery, ☰ groups); v0.4 went back to it. **When revising a design, check it against
the direction document the user approved before inventing a new shape.**

*Words that meant different things to each of us.* "Widget per step or gate type" (v0.3) was a
phrase Javear could not map to anything; to him a widget was a data view. The nine-word vocabulary
in §4.6 came from that. **Define a new term against the user's own example before building on it.**

*Ten days of design for one AC, in a sprint scoped for a build.* The sprint opened with eight items
and a build goal; the design took the whole of it, and the narrowing came on day nine. A design
deliverable that the user approves should be scoped as its own sprint, or time-boxed, from the
start.

**Retro → next sprints.** Sprint 15: Novia on the Anthropic API (AC7's 1h TTL) and testing her own
work (`answer_gate`, `read_workflow_run`, the wake, the test-data policy). The web build after it,
from `arch-web-app.md` §10's Phase 0: AC1–AC4 as written here, with the household's three pages, and
`openapi.yaml` spec-first. AC6 (encryption at rest) placed when a sprint has room for a quiet cut.

