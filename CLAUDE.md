# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**CRITICAL:** Read `docs/architecture.md` at the start of every session. It contains every architectural decision, their rationale, and decisions explicitly marked final. Never suggest alternatives to decisions marked as final.

---

## Project Identity

**evolving-mind-ai** is a standalone secondary brain for individuals and households with a low cost of ownership. It builds memory structures through a `create_domain` workflow and stores them in PostgreSQL tables with a `PGD_` prefix. Complex processing is handled by user-defined workflows that are then reused with minimal or no AI.

### L/R Brain

LLM prompts are divided into Left-brain (analytical, structured reasoning) and Right-brain (environmental awareness, surfacing general subject matter content) activities. Maintain this division in new prompts.

### Static System vs Evolving Artifacts

**This boundary is the most important architectural constraint in the codebase.**

| Category | Examples |
|----------|---------|
| **Static system** (code) | `run-workflow.mjs`, `step-executor.mjs`, `classify-intent.mjs`, all Lambda handlers, shared utilities |
| **Evolving artifacts** (data) | `PGC_Workflow` rows, `PGC_Prompt` rows, `PGC_SystemContext` rows, `PGC_DomainHelp` rows, `PGC_IntentMap` rows, all `PGD_*` tables |

Rules:
- Never hard-code evolving artifact content inside system code.
- New system behaviours = new step types in `step-executor.mjs`. New business logic = updated workflow JSON in `PGC_Workflow`.
- **When unclear whether something belongs in system code or an artifact: ask, or default to treating it as an evolving artifact.**
- **User domain data must never appear in system artifacts.** Labels, placeholders, examples, and descriptions in system-level workflows (`create_workflow`, `create_domain`, `ping_core`), prompts, and seed files must be generic. References to specific user domains, table names, entity types, or workflow subjects (e.g. "Spanish flashcard", "Holdings", "Recipes") belong only in `PGD_*` tables and user-created `PGC_Workflow` rows — never in the system's own seed data or code.

### Extending the Harness to Accept Standard LLM Output

As generated workflows are tested in production, LLMs will produce outputs that are logically valid but in a form the harness does not yet accept. The correct response is to **extend system code to accept the standard form** — not to add prompt rules forcing LLMs to produce a proprietary format.

**The test:** Is the LLM's output an instance of an established standard — JSONPath, SQL syntax, standard JSON structures? If yes, extend the harness.

Examples of correct extensions:
- `orderBy: "col ASC"` — standard SQL `ORDER BY` syntax → `normalizeOrderBy` accepts both string and object forms
- `{{cards[*].id}}` — standard JSONPath wildcard → `tokenizePath` normalises bracket notation before path resolution

**The violation pattern** is the inverse: inventing a custom syntax or proprietary object shape, then adding prompt rules to force LLMs to use it. If you find yourself writing a new prompt rule to constrain LLM output format, ask first: should the harness accept what the LLM naturally produces instead?

This principle extends to all system code boundaries: `step-executor.mjs`, `template-resolver.mjs`, `table.mjs`, `review-output.mjs`, `serv-client.mjs`. When a generated workflow hits an unexpected format error, the diagnosis question is: **is the LLM's output reasonable and standard?** If yes, fix the harness, not the prompt.

### Bug Fix Philosophy

Unless the change is in **system code** (a genuine engine defect), bug fixes must be made **indirectly** — by enhancing the system's self-correction and improvement capabilities (L/R brain prompts, workflow updates, system context updates). Never patch evolving artifact behaviour by adding `if` branches to system code.

### Experience Layer vs Procedure Layer Partitioning

The boundary is about the backend (`/proc`) giving the experience layer sufficient information so content can be rendered in a suitable and pleasant way for the user. There is no web frontend today — Slack fills the experience-layer role — but `/proc` may work with a different experience layer in the future. `/ui/slack` must be given UI-agnostic instructions that it translates into Slack-specific rendering; a different experience layer could do the same from the same instructions.

| Category | Examples |
|----------|---------|
| **Procedure layer** (`/proc`) | workflows, `step-executor.mjs`, `js_transform` content formatting (`formatted_markdown`, report text) |
| **Experience layer** (`/ui/slack`) | `callback.mjs`, `dialogToBlocks`, Block Kit rendering |

Rules:
- Procedure layer determines what decision the user must make and what data they need. For system workflow artifacts (e.g. `list_entity`, `add_entity`), the domain/schema knowledge required — labels, enum-driven formatting, currency, length-based reveal/no-reveal thresholds — should be handled deterministically via `js_transform`.
- For domain-specific workflows, formatted content is acceptable and encouraged (`formatted_markdown`, for example); raw data should not be left for the experience layer to interpret and format.
- Experience layer determines Slack-specific rendering mechanics: which block type wraps a piece of content, button/list/modal assembly, layout, ordering.
- **Never put domain vocabulary in `/ui/slack`.** If a rendering decision requires knowing what a field means or what a value implies, that decision belongs in a workflow step, not the shared renderer.
- Novia's direct markdown output to the user, and workflow-generated reports formatted for a human_gate, are both instances of the rule above, not exceptions to it — the domain knowledge needed to format them lives in `/proc`.

### Fault Domain Triage

When a bug surfaces, identify the fault domain before reaching for a fix. Fix in that domain only — a fix applied to the wrong domain masks the root cause and creates new bugs.

| Fault Domain | Covers | Correct fix |
|---|---|---|
| **Contract** | Wrong column type, constraint, or data shape | Update prompt instruction (e.g. `design_table`) |
| **Instruction** | Prompt rule vague, wrong default, missing example | PGC_Prompt update |
| **Generation** | LLM made a subjective but wrong call given correct instructions | Novia correction or targeted prompt example |
| **Validation** | L1/L2 should have caught this but didn't | Extend `simulation-engine.mjs` |
| **Execution** | Harness can't handle standard LLM output | Extend system code (extend-not-prompt principle) |

**Before writing any fix, state the fault domain.** If unclear, ask — don't guess and code.

Sprint 4 examples: `real` vs `numeric(4,2)` for ease_factor → Contract bug from an Instruction failure in `design_table`. `runRoutingValueRules` false positives → Validation fix in the wrong domain; correct fix was removing the function entirely.

---

## Development Process — Sprint Cycles

### Session start
Read `docs/sprints/CURRENT.md` (if it exists) alongside `docs/architecture.md` and `docs/arch-data.md` §5.5 (curl cookbook). `CURRENT.md` contains the active sprint goal, branch, acceptance criteria, and test scenarios. `arch-data.md` §5.5 contains the canonical curl commands for all SERV routes — read it before making any API calls, never guess route names.

### Sprint lifecycle

| Phase | Steps |
|-------|-------|
| **Retro** | What required multiple L1/L2 correction cycles? What broke post-simulation? What backlog items aged? Each finding maps to a prompt update, context update, or new L1 check. |
| **Scope** | Review `docs/backlog.md`. Select items. Write `docs/sprints/CURRENT.md` with goal, branch name, acceptance criteria, out-of-scope list. |
| **Prep** | Review and update relevant PGC_SystemContext rows, PGC_Prompt entries, and PGC_StepType contracts *before* writing code. Fix system self-knowledge first. |
| **Branch** | `git checkout -b sprint/NN-short-slug` |
| **Implement** | Commit to branch using conventional format. Unit tests must pass before each push. **Update the acceptance-criteria table whenever a criterion's state changes** — see below. |
| **Review** | Push branch. User reviews via `git diff` and commit messages. No merge without explicit approval. |
| **Close** | Merge to main → deploy → update all docs (see checklist below). |

### The acceptance-criteria table is the sprint's status board

`CURRENT.md`'s AC table is how the sprint's position is read at a glance, so it is maintained
**during** the sprint, not written at close. Every criterion carries:

| Column | Contents |
|---|---|
| **Status** | ⬜ not started · 🟡 in progress · ✅ met · ~~struck~~ withdrawn or moved, with the reason inline |
| **Criterion** | What must be true, and how it is evidenced |
| **Scope** | A link to the scope item or track that delivers it — every AC names its work, every scope item is reachable from an AC |
| **Threshold** | What counts as met |

**Update it in the same turn the state changes**, alongside the ✅ DONE marks on scope items —
never deferred to session close. A withdrawn or moved criterion is struck through and keeps its
reason, so the record shows what was decided rather than what quietly vanished.

### Sprint close checklist (enforce before merge)
- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] Simulate Level 1+2 pass on any new or modified workflows
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated if any architectural decisions were made **or any `.mjs` file was added/removed/renamed**
- [ ] `docs/arch-data.md` updated if any schema changes
- [ ] `README.md` updated if environment setup, bootstrap steps, or infrastructure changed
- [ ] `docs/backlog.md` updated — items completed, new items added
- [ ] `docs/sprints/CURRENT.md` renamed to `docs/sprints/sprint-NN.md` with outcome notes

> **No test environment (interim process):** deploy branch to prod → validate end-to-end → then merge to main. Main must always reflect what is actually running in prod. Once a test environment exists, this flips: deploy to test → validate → merge to main → deploy to prod.

> **Deployment = code + seeds.** `sam deploy` only updates Lambda code. After every deploy, run `git diff main...HEAD -- src/serv/templates/pgc/seeds/` to identify changed seed files, then upsert each one: `node dev_scripts/upsert-workflow.mjs`, `node dev_scripts/upsert-step-type.mjs`, `node dev_scripts/upsert-prompt.mjs`, `node dev_scripts/upsert-system-context.mjs`. Seeds not upserted means the DB is still running the old definitions.

### Interaction shorthands
- **"add to todo"** — Claude gives a 2–3 sentence perspective on the item, then adds it to `docs/backlog.md`.
- **"add to sprint"** — Claude adds the item to `docs/sprints/CURRENT.md` scope (in-session sprint adjustment).

### Enforcement
Claude enforces sprint discipline. If any of the following are skipped, Claude calls it out before proceeding:
- Branching before implementation starts
- Unit tests before pushing
- Doc updates before merge
- Retro before scoping a new sprint
- The AC table's status column left stale while work lands

This applies even if the user does not mention it. The checklist is a hard gate, not a suggestion.

---

## Final Decisions (non-negotiable)

Never suggest changing:
- ESM module format (`.mjs`)
- esbuild bundler
- Shared `LambdaExecutionRole`
- Lambda-outside-VPC architecture
- SSM `String` parameters (not `SecureString`)

---

## Commands

```bash
# Install dependencies
npm install

# Run unit tests (Node.js native test runner — no Jest/Mocha)
node --test tests/unit/*.test.mjs

# Run a single unit test file
node --test tests/unit/step-executor.test.mjs

# Run integration tests (requires env vars from .env.test.template)
node --test tests/integration/*.test.mjs

# Deploy (esbuild bundling happens inside SAM at deploy time)
sam build && sam deploy
```

No linter or formatter is configured. Code review is done against `docs/code-review-checklist.md`.

### Dev scripts (run manually)

| Script | Purpose |
|--------|---------|
| `node dev_scripts/upsert-workflow.mjs` | Push all workflow definitions to PGC_Workflow |
| `node dev_scripts/upsert-workflow.mjs ping_core` | Push one named workflow (any `name` from seed file) |
| `node dev_scripts/upsert-prompt.mjs` | Push prompts to PGC_Prompt |
| `node dev_scripts/upsert-step-type.mjs` | Push step type definitions |
| `node dev_scripts/upsert-system-context.mjs` | Push system context |
| `node dev_scripts/pull-prompt.mjs` | Pull prompts from DB to seed file |
| `node dev_scripts/backfill-embeddings.mjs` | Embed PGC_DomainHelp rows |

Bootstrap (install-time only, NOT on Lambda cold start): `POST /api/v1/serv/bootstrap`

### Monitoring (read Lambda logs on demand)

Read logs when something has happened, scoped by time. Each command returns. Run all four in parallel:

```bash
aws logs tail /aws/lambda/evolving-mind-ai-proc --since 10m --format short --region us-east-2
```

Repeat for `-slackbot`, `-serv` and `-slack-callback-listener`. Widen `--since` if needed, and narrow the output with `| grep -E "<pattern>"` if you want.

**Never pipe a `--follow` stream into a file** (`nohup`, background jobs, Monitor on `/tmp/lambda-logs.txt`). The writers in that chain block-buffer: `sed` writing to a file and the `aws` CLI writing to a pipe hold low-volume lines until ~4 KB accumulates. The file lags, and reads return stale logs during a live diagnosis.

For workflow diagnosis, `PGC_WorkflowRunStep` and `PGC_WorkflowRun` are usually the better evidence.

---

## Architecture Reference

Full architecture: `docs/architecture.md` — tier structure, transport-agnostic pattern, SQS queues, Step Processor, step types, all decisions and invariants.
Component quick reference (impact index, fault triage map): `docs/architecture.md` Section 1.5.
Full data/SERV API + curl cookbook: `docs/arch-data.md` — PGC schema, SERV endpoints, filter operators, common queries.

---

## Key Conventions

- **Copyright header** required on every `.mjs` file (lines 1–3):
  ```js
  // Copyright (c) 2026 Javea Guiri. All rights reserved.
  // Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
  // See LICENSE file in the project root for full license terms.
  ```
- **Spec first:** Add entries to `openapi.yaml` before implementing new endpoints. Update `docs/architecture.md` for new SQS message types, step types, and gate types. Update `docs/arch-data.md` for new or modified PGC tables.
- **Seed files** use `\uXXXX` escape sequences (native `JSON.stringify` output). `.gitattributes` enforces LF line endings.
- **Template JSON files** in `src/serv/templates/pgc/*.json` are ES module static imports bundled by esbuild — not read via `fs` at runtime.
- **Environment:** All secrets are in AWS SSM Parameter Store. No `.env` files at runtime. Use `.env.test.template` for local test setup.
- **Human Gate flow:** Step Processor suspends → `HUMAN_GATE` SQS → SlackCallbackListenerFunction renders Block Kit → user clicks → `/interactive` → `resume_gate` SQS → Step Processor resumes.
- **Seed file updates:** Never write directly to the database to update seeded values. Edit `seed_PGC_Workflow.json` or `seed_PGC_Prompt.json` then run the corresponding `dev_scripts/upsert-*.mjs` script.
- **New PGC_SystemContext entries:** When adding a row with `inject_for`, every listed `intent_category` must have a matching `{{key}}` token in the corresponding prompt text. `inject_for` alone does nothing — `assembleInstructions` substitutes inline tokens only. Verify the token is present before upsetting.
- **New PGC_StepType entries:** The step type name must appear in the `known system prompts` list inside `generate_workflow_steps` prompt text, or in `step_type_contracts` if that token is injected into the relevant prompts. A step type not referenced in any prompt is invisible to the LLM during workflow generation.
- **DB connections:** All `pg` connections use `ssl: { rejectUnauthorized: false }` — never change this. The 13 PGC system tables are bootstrapped and seeded — do not recreate them.
- **Diagnose before coding:** After reading logs or curl output, present findings and agree on the fault domain and fix before writing any code. Wrong diagnoses produce wrong code.
- **Commit and push after each meaningful change:** Do not batch unrelated changes across a session. Push to the branch so changes are visible on GitHub for review.
- **Propose before implementing:** On complex tasks, propose the approach and wait for confirmation before writing code.
- **No whitespace drift:** Do not add whitespace to lines or comments not affected by a change. Keeps diffs and git logs clean.
- **No defensive code:** Do not add error handling, guards, or workarounds for problems that are symptoms of a missing architectural piece. Identify the root cause and the correct fix. Defer only usability/cosmetic items to the tech debt register.
- **No file content inference:** Always read the actual file before modifying it. Never reconstruct contents from memory or prior session context.
- **Reuse before adding:** Check existing patterns in the codebase before introducing new utilities or abstractions. Propose extracting common code when duplication is found.

---

## Current State

Sprints 7–12: see `docs/sprints/sprint-07.md` through `docs/sprints/sprint-12.md` (outcome, validation, retro).

**Sprint 12 closed 2026-09-22 → 19 sessions, branch `sprint/12-repair-loop-and-release`. 1044 → 1177 unit tests.** The repair loop and release readiness. **Two ACs met, two withdrawn, two moved, one carried — and that undersells it**, because as in Sprint 11 most of what shipped was never an AC.

**AC1 met twice live.** `propose_workflow_fix` now takes a patch of complete steps merged by `step` identifier, so repairing one step no longer means resubmitting all 38. The second case (session 1199) was unrehearsed: patch-mode `simulate_workflow` before proposing, `baseVersion: 5`, two steps replaced, diff exact. That removed the requirement behind the whole 2026-08-27 defect class rather than patching its instances. **AC6 met** — replay **declined** (a developer tool; it performs real SERV writes), `preview_step` **adopted** and specified as a new tool.

**Unscoped, and the larger half:** the `human_gate` gate-contract repair; gate options that carry a `condition`; the L1 `expression_reads_unwritten_key` check plus `add_entity` v24 (step 2a read a `local_state.domain` nothing writes, so every reference-enrichment run got a blank domain); three simulator read-divergences fixed, leaving **every registered workflow passing L2**; `capOutput` improvements with system prompt v35/v36; `review_inventory` 359 → v8 with a working pager; Novia's own memory corrected twice.

**Two ACs were withdrawn because the work was wrong, not because time ran out.** AC4's premise inverted under its own probes: steps 8/8c of workflow 358 are `serv_query` **retrieval**, so **no value of either 0.4 threshold decides a merge** — the merge is decided by step 10's prompt. The specimens turned out to be **wrong alias rows**, proven by aliases 41 and 89 resolving `PAN M(.)100%INT FAM` correctly to inventory 36 while **81** (`PAN MOLD INT ALTEZ`) points at 17. AC2 was withdrawn for a different reason: release readiness had lost to code work in five consecutive sprints, so it left the sprint container entirely.

**Release readiness is now a standing workstream — `docs/ops-release-readiness.md`**, branch prefix `ops/<slug>`, reviewed at every sprint boundary and scoped into none. It carries **R1**, the finding that `template.yaml` cannot stand up a second environment: four literal `FunctionName`s, four literal `QueueName`s, `UsagePlanName` and `RoleName: LambdaExecutionRole` all collide account-wide, and **all 12 SSM references are hardcoded to prod's paths with pinned versions** — so a dev stack would come up green, pointed at prod's database, posting as prod's Slack bot. **Aurora Serverless v2 is R5: an option, undecided.** It had been written into four places as decided, from one session's analysis, by the analyst rather than the decider; the measurement stands, the adoption does not.

**Decided 2026-09-22: no `table_edit` gate type.** A bulk record edit renders identically to the existing `form` gate, and `gate_type` governs rendering only. The mechanism already exists and had never been used — `resolveFormFields` takes `step.fields` as a `{{template}}` resolving out of `local_state`, `collectFormValues` returns every field on one click, and the live `human_gate` contract **already** tells Novia to reach for it. The ceiling is **50 blocks, not 100** (form gates are messages via `chat.postMessage`; only `text_input` uses `views.open`), which the contract states as ~40 fields with the fields-by-rows multiplication. **The one real gap is paging past that ceiling** — the contract says filter or narrow, never page, and `nav_state` appears in no seed.

Read `docs/sprints/sprint-12.md` (outcome, validation, retro) before adding anything to Sprint 13.

### Open Work (Sprint 13 — `docs/sprints/CURRENT.md`)

1. **The bulk-edit pattern**, and the paging remedy past the ~40-field ceiling. Scope items 1–5.
2. **`edit_budget` (357 v6)** — Novia converts it to the pattern, **then** it is retested once. Scope item 6, carried from Sprints 9 and 11.
3. **The inventory correction workflow** — rename, merge, recategorise, fix an alias. Scope item 7, moved whole from Sprint 12 Track C. Its three specimens are live: aliases **81**, **60**, **59**. Aliases must be keyed on the **raw receipt string**, never the English rendering.
4. **`manage_expenses`** — designed by Novia and evaluated, not built. **Two corrections must precede the build** because they destroy data during the troubleshooting session itself: the `payment_method` vocabulary mismatch (an unrepresented stored value yields no `initial_option`, so `extractFieldValue` returns **null** and the column is **blanked** on save — ~18 `debit` rows), and the hard delete against a `deleted_at` that has never been written. The missing `cancel` self-corrects (`missing_cancel_option` is a live L1 check). **Currency is not closed by converting the data** — the column is NOT NULL default `'USD'`.
5. **Standing observations, not tasks:** AC9 (per-receipt cost falls with use), AC13 (the friend), workflow 358's never-executed v6/v7 fixes, and **pooled candidate attribution** — steps 8b/8d keep the maximum similarity across all receipt items, so the number step 10 reads is not per-pair. Real Contract defect, deliberately unworked. **Trigger: if wrong merges persist after 81, 60 and 59 are corrected, this is the cause.**
6. **Release readiness** is *not* Sprint 13 work — `docs/ops-release-readiness.md`, reviewed at this sprint's boundary.

### Deferred

- `soft_drift` and `dev_scripts/replay.mjs`'s own file-loop — built but never exercised live (no memory drift between corpora to trigger `soft_drift`; AC3 was driven directly against the endpoints).
- Richer episodic memory content (distil session outcomes vs generic one-liners)
- `PGC_Memory` semantic deduplication / TTL cleanup
- Pass 2 keyword scan excludes `domain: null` workflows (unnecessary Tier 2 LLM calls)
- `design-domain.mjs` Phase 4 — HUMAN_GATE refactor

> Full tech debt register: `docs/backlog.md`

---

## Key Reference Files

### Architecture (read the narrowest doc that covers your task)

| Doc | What's in it |
|---|---|
| `docs/architecture.md` | System overview, component quick ref (§1.5), tier structure, SQS queues, directory structure, inter-module call rules, PGC config table roles |
| `docs/arch-intent.md` | Intent classification pipeline — Pass 1a/1b/1c/2/3, I/O contracts, handoff() routing, generic CRUD workflows |
| `docs/arch-step-types.md` | Step type reference — every field, schema, and example for `llm_call`, `serv_*`, `iterator`, `human_gate`, `condition`, `js_transform`, `simulate`, `write_memory`, `notify`, `end` |
| `docs/arch-step-processor.md` | Step Processor execution engine — PGC_WorkflowRun, execution stack, local_state, human gate lifecycle |
| `docs/arch-simulation-engine.md` | Simulation engine (`simulation-engine.mjs`) — L1/L2a/L2b/L2c validation levels, data-flow trace, result structure, standalone `/proc/simulate-workflow` endpoint. Consumer-agnostic: used by `create_workflow`/`fix_workflow`, Novia's `simulate_workflow` tool, `troubleshoot-workflow.mjs`, and `upsert-workflow.mjs`'s pre-write guard |
| `docs/arch-workflow-patterns.md` | Output validation, workflow authoring, session, memory layer, self-repair, monitoring |
| `docs/arch-data.md` | PGC/PGD schema (all 18 tables), SERV API reference, **curl cookbook (§5.5)** |
| `docs/arch-security.md` | Threat model, Slack signing, PROC/SERV API key enforcement |
| `docs/arch-create-domain.md` | `create_domain` workflow — annotated step-by-step design reference (live v33) |
| `docs/arch-create-workflow.md` | `create_workflow` workflow — full design reference, LLM call chain, L1/L2 validation |
| `docs/arch-memory.md` | Memory layer design — PGC_Memory schema, write paths, retrieval, scope, provenance |
| `docs/arch-session.md` | Session and chat design — PGC_Session/PGC_SessionEntry, `/chat`, `/explain`, diagnostics |
| `docs/arch-minds-eye.md` | Minds-eye agent — tool catalog, use cases, agentic loop, implementation sequence (Sprint 5) |

### Process and reference

- `docs/backlog.md` — tech debt register, tangential feature designs
- `docs/arch-prompt-rules.md` — decision framework for where rules go (prompt vs system context); full migration backlog; contradiction log
- `docs/code-review-checklist.md` — enforced patterns and anti-patterns
- `openapi.yaml` — all HTTP endpoint specs
- `template.yaml` — SAM/CloudFormation infrastructure

---

## AWS Environment

- **Stack:** `evomind-infrastructure`, region `us-east-2`
- **API base:** `https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod`
- **Lambda functions:** `evolving-mind-ai-slackbot`, `evolving-mind-ai-proc`, `evolving-mind-ai-serv`, `evolving-mind-ai-slack-callback-listener`
