# Sprint 14 — A web front end, Phase 0

**Status: ACTIVE — started 2026-10-22 (Javear). Scope confirmed with two changes: R1 to the backlog, encryption at rest in.**
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
| **0** | **A detailed design of the web app — first, and approved before any build (Javear, 2026-10-18).** `docs/arch-home-brain.md` is a v0.1 proposal: layout, regions, flows and phasing at sketch depth. The detailed design takes it to buildable for Phase 0 and Phase 1, as `docs/arch-web-app.md` (the Home Brain doc keeps the product direction and the tenancy model). It settles: **hosting** and how the site reaches PROC without the internal API key; **sign-in** for one user; **framework**; **result delivery** (polling vs push); **pages and navigation** at phone and desktop width; **every gate type's web rendering** from the provider-neutral `dialog`, including the editable grid (§6.4's grid hint); the **API surface** in `openapi.yaml` terms; **error, empty and loading states**; how a **Slack-started run answered on the web** shows it (§6.2); and **what Phase 0 builds versus what Phase 1 adds**. Wireframes are part of it |
| **1** | **The web provider, end to end — Phase 0.** Spec first in `docs/openapi.yaml`: `GET /gates`, `POST /gates/{runId}/responses`, `GET /inbox` (§4.7). `provider: 'web'` routed by `callback.provider` (§4.6). A site shell that lists waiting gates and answers them. Results reach the site rather than Slack for a web-started run |
| **2** | **A `form` gate as an editable grid** — the shape Slack could not render. Open question §6.4 (the grid hint: row key and column label on the `human_gate` contract) is settled here, and Sprint 13's field `group` heading folds into it |
| **3** | **`manage_budget` (= `edit_budget`, 357 v7) as the Phase 0 workflow** — one column, ~21 rows, the grid's natural first consumer. Its four Sprint 13 findings go to Novia as findings: every save writes all 21 rows; amounts are `text`; `currency: 'USD'` hardcoded in a euro household; grouping by label prefix |
| **4** | **Sign-in for one user.** The site is public-facing, so it needs a real identity even with one user: the browser never holds the internal API key, and identity comes from the token, never the request body (§3.3). Mechanism decided at "start sprint" |
| ~~**5**~~ | ~~Release readiness R1–R3, moved forward~~ — **R1 moved to `docs/backlog.md` at "start sprint" (Javear, 2026-10-22).** R2 is blocked by R1 and held with it. Consequence, accepted: the site is built against prod |
| **6** | **Encryption at rest for PostgreSQL (Javear, 2026-10-22).** RDS `StorageEncrypted` is absent and cannot be switched on in place: snapshot → encrypted copy → restore. Two things make it more than a toggle: `EvoMindDB` is a CloudFormation resource with a custom `DBInstanceIdentifier`, so setting `StorageEncrypted: true` in `template.yaml` asks CloudFormation for a replacement it cannot perform under a custom name; and writes after the snapshot are lost unless the system is quiet during the cut. Plan (endpoint kept by renaming the restored instance to `SYSRDSEvoMind`, template brought back in line with the live instance, KMS key choice — AWS-managed free vs customer-managed ~$1/month) written and agreed before any AWS action. No longer waits for the Aurora decision (R5) |
| **7** | **Novia's prompt cache holds across a session (Javear, 2026-10-24 — added in-sprint).** Oct 24 cost $14.67 for 50 Opus calls: session 1261 had grown to 234K tokens over three days, and 20 of its calls rewrote the whole prefix at $5/M where a read is $0.20/M. Three causes, all Execution: (a) Layer 1 lists every workflow's version inside `instructions`, so each approved `propose_workflow_fix` invalidates the prefix (4 misses, $4.11); (b) a prose reply rebuilds as an assistant message plus a user turn, not as the respond call it stands for, and every round started after one read back only tools + instructions (4 of 4, vs 1 of 1 hit after a respond call; $2.44 on Oct 24); (c) the 5-minute TTL expires between Javear's turns (7 misses, $5.35) — **not fixable on `/v1/agent` (measured 2026-10-24):** the gateway accepts `prompt_cache_options: { ttl: '1h' }` (an unknown field is a 400) but ignores it — the write is billed at the 5-minute rate (1.25×, not 2×) and the identical request 7 minutes later rewrote all 13,171 tokens with no read. (a) and (b) ✅ DONE, deployed (`b6cba4c`) |
| **8** | **`read_workflow_run` — a Novia read tool for run data (Javear, 2026-10-25 — added in-sprint).** She reads runs through `run_sql` today, which carries a trap: `PGC_WorkflowRun.state` is written only at completion, and a live run's state is `stack[top].local_state`. The tool returns the run's status, current step, the waiting gate (with its `gate_id`) and per-step outputs — projected and bounded with provenance, like `read_workflow`'s outline/steps. It is also what a self-test reads after each step of a run she started |
| **9** | **`answer_gate` — Novia answers a gate in a run she started (Javear, 2026-10-25 — added in-sprint).** The first step towards Novia testing her own builds, fixes and enhancements inside the cache TTL, keeping Javear out of the test-troubleshoot-repair loop. Built on scope item 1's provider-neutral `POST /gates/{runId}/responses` with `gate_id`, not a second resume path. Refused for any run she did not start (`triggered_by: 'minds_eye'` in her session) and always for the gates that guard her own gated writes — those remain Javear's. Not in scope: waking her when her run reaches a gate (a run outlives her round budget), and a policy for test data written to prod (she handled it by hand for the receipt test — see session 5) |

## Acceptance Criteria

⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved. **Updated when a criterion's
state changes, not at close.**

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC0** | 🟡 draft `docs/arch-web-app.md` v0.1 + mock-up complete — awaiting Javear's review | `docs/arch-web-app.md` covers every point in scope item 0, with wireframes, and Javear approves it before Phase 0 code starts | [0](#scope) | Approval |
| **AC1** | ⬜ | A run started from the web site suspends at a gate, the gate appears on the site, and answering it there resumes the run to completion — no Slack involved | [1](#scope) | Binary, live |
| **AC2** | ⬜ | `manage_budget` edits all its amounts in one editable grid on the site, grouped by budget type, and one save writes **only the changed rows**, as numbers, in the household's currency | [2](#scope), [3](#scope) | Binary, live |
| **AC3** | ⬜ | The site requires sign-in, and no request from the browser carries the internal API key | [4](#scope) | Binary |
| **AC4** | ⬜ | Slack still works unchanged for a run started from Slack | [1](#scope) | Binary, from Slack |
| ~~**AC5**~~ | ~~⬜~~ | ~~R1 lands~~ — **moved to `docs/backlog.md` with R1 at "start sprint" (Javear, 2026-10-22)** | ~~5~~ | — |
| **AC6** | ⬜ | The prod database is encrypted at rest: `StorageEncrypted: true` on the live instance, `template.yaml` matches the live instance, every table's row count unchanged across the cut, and the Lambdas reach it with no SSM change or with the change made through a version-pinned deploy | [6](#scope) | Binary, verified live |
| **AC7** | 🟡 (a) and (b) deployed 2026-10-24 — awaiting the proc logs from Javear's next Novia session; (c) measured, not fixable on the gateway | A Novia round that follows an approved workflow fix, or a prose reply, reads its prefix back from cache rather than rewriting it; the logged `cacheRead` on the round's first call covers the transcript, not only the 17,270-token tools + instructions block | [7](#scope) | Binary, from the proc logs on a live session |
| **AC8** | ⬜ | Novia reads a live run's status, current step, waiting gate and step outputs with `read_workflow_run`, without `run_sql`; a run in progress shows its live `local_state`, not the completion-only `state` column; the result is bounded and says what it withheld | [8](#scope) | Binary, from a live Novia session |
| **AC9** | ⬜ | Novia answers a gate in a run she started and the run resumes through the same `POST /gates/{runId}/responses` path the web uses; an answer to a run she did not start, or to a gate guarding her own gated write, is refused | [9](#scope), [1](#scope) | Binary, live |

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

### Session 5 — 2026-10-25 — Novia tests her own work

**Javear on Novia's inventory-quantity work (sessions 1261, 1270), on Opus 5.5:** she found the bug
Wren had found, fixed it without new bugs, and supplied a test grocery receipt that exercised her new
code. She cleaned up after the test herself: she stored the before values in memory, reverted
them, and deleted the test row from the test table. Her one cost was Oct 24's spike, part of it
the 6–7 minutes Javear spent testing between her replies (the TTL misses, $5.35 of $14.67).

**Added in-sprint (Javear): scope items 8 and 9, AC8 and AC9** — `read_workflow_run`, and
`answer_gate` on scope item 1's gate-response endpoint: the first step towards Novia testing her
own work inside the TTL. Not scoped: waking her when her run reaches a gate, and a test-data
policy for prod.

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
