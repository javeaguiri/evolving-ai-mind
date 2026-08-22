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
| **Implement** | Commit to branch using conventional format. Unit tests must pass before each push. |
| **Review** | Push branch. User reviews via `git diff` and commit messages. No merge without explicit approval. |
| **Close** | Merge to main → deploy → update all docs (see checklist below). |

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

### Monitoring (tail all Lambda logs live)

**Step 1** — Start tailing (single Bash call, all four lambdas → `/tmp/lambda-logs.txt`):

```bash
truncate -s 0 /tmp/lambda-logs.txt 2>/dev/null || touch /tmp/lambda-logs.txt; nohup bash -c 'aws logs tail /aws/lambda/evolving-mind-ai-slackbot --follow --format short --region us-east-2 2>&1 | sed "s/^/[slackbot] /" >> /tmp/lambda-logs.txt' > /dev/null 2>&1 & nohup bash -c 'aws logs tail /aws/lambda/evolving-mind-ai-proc --follow --format short --region us-east-2 2>&1 | sed "s/^/[proc] /" >> /tmp/lambda-logs.txt' > /dev/null 2>&1 & nohup bash -c 'aws logs tail /aws/lambda/evolving-mind-ai-serv --follow --format short --region us-east-2 2>&1 | sed "s/^/[serv] /" >> /tmp/lambda-logs.txt' > /dev/null 2>&1 & nohup bash -c 'aws logs tail /aws/lambda/evolving-mind-ai-slack-callback-listener --follow --format short --region us-east-2 2>&1 | sed "s/^/[callback] /" >> /tmp/lambda-logs.txt' > /dev/null 2>&1 &
```

**Step 2** — Start a Monitor on the file (use the Monitor tool with `persistent: true`):

```
command: tail -f /tmp/lambda-logs.txt | grep --line-buffered -E "<pattern>"
```

Use a grep pattern that covers both success and failure signals, e.g.:
```
step-executor|run-workflow|HUMAN_GATE|WORKFLOW_ERROR|workflow.*complete|failed|error|step [0-9]|workflowRunId
```

This produces per-event notifications in the conversation as each matching log line arrives.

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

**Sprint 7 closed 2026-07-12 (branch `sprint/07-mvp-functionality-gaps`).** MVP functionality gaps. All ACs met except one carried item (D3). Highlights: `serv_upsert` step type + L2 data-flow trace; `form` gate type (a widget is a field type, not a gate type) and `text_input` retired from the instruction layer; `choice` renders as a dropdown past five options; `list_selection` markdown-table rendering with grouped `static_select`; view infrastructure (`PGC_Schema.type`/`select_sql`, `createView`); `PGC_IntentMap` one row per phrase; `/explain` step-selection gate; Novia SOP library. Late-sprint work concentrated on **silent failure**: repair loops that regenerated without being told what failed, a renderer that posted messages Slack rejected, and a schema registry that lied.

**Sprint 8 closed 2026-07-25 (branch `sprint/08-replay-harness`).** Replay harness & cost stop. The sprint's thesis is proven — the `create_workflow` development loop is free. The **LLM replay harness** (`docs/arch-replay.md`) serves a recorded response from `PGC_SessionEntry` instead of calling Perplexity, keyed by a **content fingerprint of the assembled request** (seven component hashes + composite; `fingerprint.mjs`/`replay-corpus.mjs`/`replay.mjs`) computed at the `callLlm` seam; gates stay real, SERV is not stubbed. Measured: runs 720+721 = 16 `llm_call`s, **0 live**; a full dev cycle costs **$0** — one paid build ≈ $1.42 (run 729), then free forever. New: `awaiting_llm_break` run status; `resume_llm`/`REPLAY`/`REPLAY_RESUME` SQS; `/proc/replay` endpoints; `/replay` + `/shutdown <runId>`-reaches-break; break drift report (component + per-`input`-key + `local_state` diff + blast radius + disposition); Block Kit break resolution; `dev_scripts/replay.mjs`; L1 gate-size check. Experience/procedure partition **swept clean** — every standard-markdown gap closed in `callback.mjs` code (`toSlackMrkdwn`), zero Slack/mrkdwn references across 24 prompts + 36 context rows. **AC6/AC7 dropped, AC11→backlog; AC10 partial** — the `edit_budget` build validated (registered, id 356), but the generated workflow's runtime surfaced create_workflow design-quality defects that carry to Sprint 9.

**Sprint 9 closed 2026-08-06 (branch `sprint/09-novia-builds-workflows`).** Novia builds workflows. **6 of 9 ACs met.** The sprint's question was whether conventions alone are enough for an agent that can already write code — and the answer, on the build, is yes: `edit_budget` (id 357) was designed in Slack conversation, simulated clean, and registered via `register_workflow` with **no `create_workflow` involvement at any point**. The **convention bridge** (`PGC_SystemContext` id 45, loaded on demand) was fetched *unprompted as session 1121's first action*, and `PGC_StepType` queried before designing — AC1/AC2 confirmed live rather than by inspection. New: **L0** shape validation as a `level` selector on `runSimulation` (composed from `input_contract`, never hand-authored; `skeleton` flag gone; `step-type-registry.mjs` added); **`register_workflow`** gated write tool that refuses any array failing L0+L1+L2; **`option_source`** (`static | dynamic`) on the `human_gate` contract with divergent render bounds in `callback.mjs` (AC7 — both gates confirmed live under one deployment, which a threshold bump cannot produce); **L1 numeric-index check**, plus a template walk that finally descends the whole step input rather than its top level. 725 → 774 unit tests.

**What did not come free is the finding.** AC5's runtime half needed repairs made outside the Novia path. AC9 measured **$2.73** to build against the **$1.42** `create_workflow` baseline, plus **$3.40** for a repair session that did not complete — so the cost evidence the dissolution decision is gated on **does not yet favour the Novia path**, and should be re-measured after the transcript fix. AC6 was moved from partial to **not met** on discovering the binding budget was never `turn_limit`: the round runs inside one 240s Lambda. The single largest defect found: **Novia could not see her own work** — `buildUserMessage` dropped a tool entry's `params`, so every step array she submitted was persisted and invisible to her, and she rebuilt all 23 steps from reasoning each turn.

**Sprint 10 closed 2026-08-22 (branch `sprint/10-viability-checkpoints`).** Viability checkpoints — a make-or-break sprint whose deliverable was a written go/no-go, with every threshold fixed in the sprint doc **before** any number was observed. **Outcome: GO** — 9 PASS, 2 MARGINAL, 2 NOT MEASURED across 13 ACs. Novia replaces `create_workflow` as the way workflows are built: **$1.376** to build `process_receipt` registered-to-registered against the $1.42 `create_workflow` baseline, and **$0.672** to diagnose and repair a defect unaided from a symptom alone. Checkpoint 1 (~$21/mo AWS) and Checkpoint 2 pass; **Checkpoint 3 passes on its binary threshold** — a raw-Spanish grocery receipt and a restaurant receipt both route correctly from Slack with no hand-repair. Shipped: **native function calling** for Novia's loop (`callLlmWithTools`, 29 tool schemas, `ACTION_SCHEMA` deleted) with `cacheRead` = the previous turn's entire `inputTokens`; `serv_query` `vectorSearch` + `columns` pass-through; **capability and scheduling tools on EventBridge Scheduler**, built for real; `addForeignKey`/`addUniqueConstraint`. 823 → 997 unit tests.

**The load-bearing finding: never append a user message mid-round** — one trailing user item forfeits the whole prefix credit for that turn, measured twice with everything else held constant. Fixed on the `respond`-tool path; still open on the prose-reply path and on gate resume, together **58%** of one session's spend.

**What the GO does not claim, and this is the sprint's largest evidence gap: that cost per receipt falls with use.** Every part of the alias-learning machine is built and proven live — per-item `vectorSearch` on both tables, same-language alias matching, 84 aliases persisted as raw receipt strings — and **AC9 is unmeasured**. Run 782's four items were entirely new vocabulary (`auto_matched: 0`), so the 2.4× per-item drop it showed is attributable to two engine fixes, not to learning. The measurement protocol was pre-registered in git before that run precisely so the distinction could be drawn afterwards rather than argued about. It closes on one ordinary shopping trip whose items overlap the alias table.

**Every significant defect this sprint was found by running the system, not by reading it** — seven engine defects on 2026-08-16, two on 2026-08-19, and a third on 2026-08-22 that surfaced only because the backlog entry said *re-probe rather than trust the response shape*.

**Sprint 11 scoped 2026-08-22 (branch `sprint/11-usability-and-admin`).** Read `docs/sprints/sprint-10.md` (retro) and `docs/sprints/CURRENT.md`.

### Open Work (carry-forward to Sprint 11)

1. **`/help` shows a domain's CRUD commands and never its workflows** — everything Novia builds is undiscoverable. The panel is composed from `PGC_DomainHelp.commands` alone and never reads `PGC_Workflow`, so it drifts in **both** directions: `inventory` never mentions `process_receipt`, `budgets_expenses` never mentions `edit_budget`, and `flashcards` advertises two commands that route nowhere. **Sprint 11's opening item.** See backlog High Priority.
2. **The inventory correction workflow** — rename an item, merge a duplicate, recategorise, and fix an alias. This is not a nicety: matching at an uncalibrated 0.4 has persisted **wrong** aliases (`PAN MOLD INT ALTEZ` → *Rustic Sliced Bread*), and `PGD_Inventory` 25 is a red wine recorded as "Ink Cartridge". Errors compound on every shop. Aliases must be keyed on the **raw receipt string**, never on the wrong English.
3. **AC7 — the vector thresholds, assigned to Novia.** Two to calibrate, not one: step 8 is English→English on `name_embedding`, step 8c is raw-string→raw-string on `alias_name_embedding`. Memory 298's bands were measured against neither pairing. Three wrong merges across runs 780/782 are the specimens.
4. **AC9 — a standing observation, not a task.** Resolves on the next same-merchant receipt with vocabulary overlap. Protocol pre-registered: per-item step-10 input tokens against the **831** baseline, per-item cost against **$0.0073**, auto-matched count as support.
5. **Human-dialog usability, surfaced by the administrative workflows** — a table in a reveal window scrolls left/right but **not up/down**; and there is no route to recategorise or aggregate an inventory item's category.
6. **Retest `edit_budget`** (357 v6) end-to-end through the Novia path.
7. **AC13 / Checkpoint 4** — waits on the friend's availability. Nothing on this side unblocks it.
8. **Output tokens are now ~48% of a receipt run's spend.** Input-side optimisation has largely done its work; the next material cost reduction is not on the input side.
9. **The prefix forfeit on the prose-reply path and on gate resume.** See backlog High Priority.
10. **`create_domain` emits derived-field maintenance rules with no consumer.** Sequence *do not denormalize* first. See backlog High Priority.
11. **Release-readiness** — test environment, README bootstrap, log hygiene. **Deferred five sprints running (7, 8, 9, 10, 11).** The GO removed the stated reason for deferring it; the fifth deferral is a decision, not an outcome.
12. `register_workflow` should refuse a domain workflow with no `intent_keywords`. See backlog.
13. Validate every `llm_call` step supplies every `{{token}}` its prompt declares. See backlog.
14. A render failure in the Experience tier should fail the run, not just report it. See backlog.
15. `/chat` dead code removal (deletion undecided). See backlog High Priority.

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
