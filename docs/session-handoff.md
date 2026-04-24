# evolving-mind-ai -- Session 29 Handoff

**Git tag:** `v3.2-session28-complete`
**Date:** 2026-04-24
**Session 28 focus:** Dev tooling overhaul (idempotent upserts, DB→seed sync, data extraction); research prompt quality analysis and architectural fixes for create_workflow; seed file reconciliation

---

## What was completed in session 28

### Dev tooling -- database and git sync

Four dev scripts rewritten or created. These resolve the seed-DB drift problem that caused the session 27 upsert incident and establish a clean bidirectional sync protocol.

| Script | Status | Change |
|---|---|---|
| `dev_scripts/upsert-prompt.mjs` | Rewritten | Content fingerprint (SHA-256 over prompt_text, model, output_schema, input_variables). No-op on re-run when content matches DB. Skips update when DB version ahead of seed. Deduplicates multi-version seed entries -- only highest version deployed. Never overwrites a newer DB row with older seed content |
| `dev_scripts/upsert-workflow.mjs` | Rewritten | Same fingerprint approach. Version only increments when content diff detected. Eliminates spurious version bumps on re-run |
| `dev_scripts/pull-prompt.mjs` | New | Pulls highest-version DB row per intent_category and writes directly to seed_PGC_Prompt.json in place. Removes old-version cluster entries. Encoding: JSON.stringify produces \uXXXX for non-ASCII (git-stable). Replaces stdout-only version |
| `dev_scripts/extract-run-data.mjs` | New | CLI tool: extract all values matching a relative dot-path from any JSON file. Fans out through intermediate arrays ([] notation accepted). Multiple matches returned as array, single match unwrapped. --raw flag for piping |

**Upsert incident recovery:** The first run of upsert-prompt.mjs (old version) iterated multiple seed entries per intent_category and wrote each to the DB in sequence -- the last write won. DB rows for generate_workflow_steps, analyze_workflow_gaps, design_workflow_process, design_workflow_dialogs were potentially corrupted. Recovered by pulling current DB content back into seed files via pull-prompt.mjs.

### Encoding standard -- FINAL

**Decision:** JSON seed files use `\uXXXX` escape form for all non-ASCII characters. Rationale: immune to JSON.stringify round-trips (the native output form), git-stable (pure ASCII), no Slack display difference (decoded identically at render time). Markdown/YAML docs remain UTF-8 rendered.

Two new repo-root files enforce this:
- `.gitattributes` -- LF line endings for all text files; binary files explicitly marked
- `.editorconfig` -- utf-8, LF, 2-space indent, final newline

### GitHub access protocol -- ESTABLISHED

| URL form | Works | Notes |
|---|---|---|
| `raw.githubusercontent.com/refs/heads/main/<path>` | **Yes** | Pure JSON/text, ~30K tokens per fetch. Use this form for all file reads |
| `github.com/.../blob/main/...` | Yes (limited) | HTML-wrapped, truncates at ~1000 lines |
| `github.com/commits/main/` | No | Blocked by robots.txt |
| Individual commit URLs | Yes (when pasted) | Valid after rate limit window; paste directly in chat |

**Protocol:** Raw URLs in `docs/github-file-index.md` are fetchable directly at session start -- no paste required. Files not in the index require the URL to be pasted once.

### Seed file reconciliation

| Prompt | Before | After | Change |
|---|---|---|---|
| `analyze_workflow_gaps` | v2 (stale) | v4 | DOMAIN MODE A/B/C, Type 4b interactive exemption, flat inputs array rule, model validation |
| `design_workflow_process` | v2 | v3 | Flat loop pattern, state_map documentation |
| `design_workflow_dialogs` | v1 | v2 | choice vs confirm/edit_list options shape distinction |
| `generate_workflow_steps` | v6 (monolith) | v8 | Split three-input contract (process_design + state_map + dialog_designs + user_feedback + simulation_errors) |
| `research_workflow_domain` | v1 | v2 (new) | workflow_mode input, domain_schema input, WORKFLOW MODE CONSTRAINTS section, SCHEMA CONSTRAINTS section, 4-test preference filter, 5-question ceiling |
| `analyze_and_design_workflow` | v10 + v11 (duplicate) | v11 only | Deduped; v10 entry removed |
| `create_workflow` | v18 (seed) | v19 (DB after upsert) | New steps 1a, 1b, 5a; N/A option on preference gates; workflow_mode and domain_schema added to step 2 input |

### Research quality analysis (items 4 & 5 from session 28 agenda)

Analysed question data from run 245 (3 runs) and run 220 (27 runs) using extract-run-data.mjs.

**Four root cause classes identified:**
- Class A: Schema-ignorant -- "Where should flashcards come from?" (fixed by domain_schema input + SCHEMA CONSTRAINTS section in research prompt v2)
- Class B: Domain-semantics-ignorant -- "Should the user see the correct answer immediately or after the quiz?" (flashcard flip mechanic unknown to LLM; addressed by N/A option as safety net)
- Class C: Workflow-purpose-ignorant -- "What format? Beginner vs intermediate?" (eliminated by workflow_mode gate step 1a before research runs)
- Class D: Filter failure -- residual bad questions slip through (addressed by N/A option on all preference gates)

**Four decisions implemented (D1-D4):**
- D1: workflow_mode gate (step 1a) -- choice A/B/C/D/E before Phase 1 research; mode injected into research prompt; eliminates Class C entirely
- D2: domain_schema + domain_row_count in step 2 input -- completes Class A fix
- D3: N/A option on every preference gate in step 5 iterator
- D4: Free-text gate (step 5a) after preference iterator -- Skip option; captures domain semantic context LLM doesn't know

**AI chat / PGC_Session evaluation:** Confirmed stateless. callLlm() invocations have no memory between calls. Resumption prompt is single-shot retry, not session memory. Multi-turn design iteration requires PGC_Session + PGC_SessionEntry. Decision: implement free-text gate (D4) as stateless single input box first. Defer PGC_Session until users demonstrate need for back-and-forth.

### docs/github-file-index.md

Updated with raw URLs replacing blob URLs. File now covers all source files including docs added since session 27: perplexity-embeddings.yaml, perplexityLLMS.md, slack-block-kit.md, slack-messaging.md, user-intent-use-cases.md, evolving_mind_use_cases.html.

### Architecture.md

Section 3.4 directory tree: `seed/` corrected to `seeds/`. Header updated to session 28.

---

## What was NOT completed (carried to session 29)

| Item | Reason | Session 29 priority |
|---|---|---|
| Phase 5-6 create_workflow validation | Session consumed by tooling/sync work | HIGH -- primary target |
| handler.mjs monitor-prompt-quality case | Required before self-healing pipeline deploys | HIGH -- prerequisite for sam deploy |
| callback.mjs code review | Deferred; Slack docs being completed by Javear before session 29 | HIGH -- primary feature target |
| Unit tests for callback.mjs | Follows code review | MEDIUM |
| Items 4 & 5 evaluation (design iteration loop, AI chat) | Analysis done; implementation deferred pending more run data post-v18 deployment | MEDIUM |

---

## Session 29 objectives -- in priority order

### 1. Deploy session 28 changes and validate create_workflow Phases 5-6

```cmd
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod

rem Sync seed changes to DB
node dev_scripts/upsert-prompt.mjs research_workflow_domain
node dev_scripts/upsert-workflow.mjs create_workflow

rem Verify all prompts clean (should all print "no changes -- already current")
node dev_scripts/upsert-prompt.mjs generate_workflow_steps
node dev_scripts/upsert-prompt.mjs analyze_workflow_gaps
node dev_scripts/upsert-prompt.mjs design_workflow_process
node dev_scripts/upsert-prompt.mjs design_workflow_dialogs
```

Before sam deploy: add handler.mjs case (see Prerequisites below). Then:
```cmd
sam build && sam deploy
```

Run `/m create workflow spanish flashcard quiz` targeting Phase 5 (simulate) and Phase 6 (registration).

### 2. callback.mjs code review

Javear is completing `docs/slack-block-kit.md` before session 29 with these Block Kit elements:
- `actions` block with multiple `button` elements (choice gate rendering)
- Modal `views.open` payload (full shape including callback_id, submit, close)
- `input` block inside a modal (text_input gate mapping)
- `section` with `overflow_menu` accessory (edit_list remove action)
- `context` block (secondary text/metadata)
- `radio_buttons` element

Review scope (from session 28 agenda item 6):
- Evaluate whether `postX` functions can be consolidated via `dialogToBlocks()` universal renderer
- Review all string-to-block conversions for 3000-character Slack section block hard limit
- Identify hardcoded message formats that should be data-driven
- Confirm `review_object` gate serialisation guard (object values must not fall through to String(value))

### 3. Unit tests for callback.mjs

After code review:
- Each gate type with representative local_state fixture
- `review_object` with array-of-step-objects input (the `[object Object]` regression)
- `choice` gate option rendering (value vs action distinction)
- 3000-char limit chunking

### 4. Items 4 & 5 -- iterative design evaluation (after Phase 5-6 run data available)

Run several create_workflow sessions post-deployment, extract question data:
```cmd
node dev_scripts/extract-run-data.mjs <run-state.json> preference_questions.question
```
Compare against pre-D1-D4 data (run 245). If question quality is materially improved, items 4 & 5 are lower priority. If questions are still poor, escalate D2 (domain_row_count) and reassess D4 free-text gate scope.

---

## Session 29 prerequisites

**handler.mjs addition (required before sam deploy):**
```js
import { handle as monitorHandle } from './monitor-prompt-quality.mjs'
// HTTP switch:
case 'monitor-prompt-quality': return monitorHandle(req)
// SQS switch:
case 'MONITOR_PROMPT_QUALITY': return monitorHandle(buildReqFromSqs(message))
```

Fetch current handler.mjs:
```
https://raw.githubusercontent.com/javeaguiri/evolving-ai-mind/refs/heads/main/src/proc/handler.mjs
```

---

## Session 29 startup checklist

1. Fetch `session-handoff.md` and `architecture.md` via raw GitHub URLs (no upload needed)
2. Confirm git tag `v3.2-session28-complete`
3. Javear shares `docs/slack-block-kit.md` status -- confirm it has the 6 element types needed for callback.mjs review
4. Fetch `src/ui/slackbot/callback.mjs` and `src/proc/handler.mjs` for the session's primary tasks
5. Run deployment sequence (item 1 above) before any code review

---

## Known open issues -- updated

### 1. research_workflow_domain -- domain_row_count not yet added (Low)
D2 partially implemented (domain_schema added). Row count would further suppress "where does data come from?" questions in read-mode workflows with existing data. Deferred to session 29 evaluation.

### 2. Phase 5-6 not yet validated (High -- session 29 primary target)
Steps 17 (generate_workflow_mocks), 18 (generate_workflow_paths), 19 (simulate Level 2+3), 20-23 (registration) have not completed a successful run.

### 3. create_domain auto-embed not verified (Low)
If a new domain is created and `embedding` is null on the `PGC_DomainHelp` row, run `backfill-embeddings.mjs`.

### 4. Pass 2 keyword scan excludes domain:null workflows (Low)
System workflows unreachable via Pass 2. Unnecessary Tier 2 sonar calls for known system commands.

### 5. Architecture doc size (Backlog)
At ~136KB the architecture doc exceeds the 30K-token raw fetch limit. Verbose sections (6.3 Intent Preprocessor I/O contracts, 6.5.x execution subsystems) are candidates for extraction into separate docs. Target: architecture.md under 50KB covering decisions and rationale only. Verbose reference sections move to dedicated docs fetchable on demand.

### 6. seed_PGC_Prompt.json legacy entries (Low)
`analyze_and_design_workflow` v10 removed this session. Confirm no other multi-version clusters remain after running `pull-prompt.mjs` for all categories.

---

## Backlog (unchanged from prior sessions)

- `PGC_Session` / `PGC_SessionEntry` -- conversational memory (Section 4.3.4)
- pgvector semantic search -- Pass 2 Backlog extension (Section 6.3)
- `backfill-embeddings.mjs` -- not yet implemented
- `embed-client.mjs` -- not yet implemented
- Pass 2 domain:null workflow keyword scan (system workflow reachability)
- Alias management workflow (`/mind edit aliases for <domain>`)
- External API Registry (`/register-api` with SSM SecureString credential storage)
- GitHub visibility (README, architecture doc surfacing, topic tags)
- Developer session workflow automation
