# evolving-mind-ai -- Session 28 Handoff

**Git tag:** `v3.2-session27-complete`
**Date:** 2026-04-23
**Session 27 focus:** create_workflow v14 end-to-end validation; self-healing pipeline (resumption prompt, prompt_quality_monitor); iterative workflow design loop

---

## What was completed in session 27

### create_workflow -- Phase 0-4 validated end-to-end

All phases now reach step 15 (user review gate) reliably. Run 245 confirmed:

| Phase | Steps | Status |
|---|---|---|
| 0 -- bootstrap | 1-3b | Confirmed clean across all runs |
| 1 -- gap analysis | 7-11a | analyze_workflow_gaps v2 valid on attempt 2; confidence: "complete"; routing_flags all 0 |
| 2 -- routing | 8-11b | Falls through to step 12 with no gates firing |
| 3 -- design | 12 (design_workflow_process v2), 13 (design_workflow_dialogs v1) | Both valid attempt 1 |
| 4 -- generate | 14 (generate_workflow_steps v7) | Valid after AJV schema fix |
| 5 -- review + simulate | 15, 16 | Step 15 renders correctly; simulate fires |

Phases 5-6 (simulation, registration) are next to fully validate in session 28.

### Bugs fixed this session

| Bug | Root cause | Fix |
|---|---|---|
| `analyze_workflow_gaps` confidence=blocked | No Mode A instruction -- LLM treated interactive quiz as needing non-existent UI capability | Added DOMAIN MODE section to v2, interactive patterns explicitly mapped to human_gate + js_transform + condition |
| JSON parse error in blocked_reason | Unescaped double-quotes in LLM string values | Added `parseErr.rawOutput` to thrown error; correction loop retry via `callLlmWithCorrection` |
| `generate_workflow_steps` AJV: 24 errors | `output_schema.steps.items.required` included `on_failure`, `on_success`, `on_complete` -- invalid for `end`, `condition`, `notify` step types | Reduced required to `["step", "type"]` only |
| `analyze_workflow_gaps` AJV: inputs as objects | `prompts_needed[].inputs` spec ambiguous -- LLM returned `[{name, type}]` instead of `["string"]` | Added explicit CRITICAL clause with correct/wrong example in v3 |
| `design_workflow_process` JSON truncated at position 6707 | `max_output_tokens: 2000` too low for complex domain process designs | Raised to 4000 in v3 |
| `analyze_workflow_gaps` JSON truncated at position 5508 | `max_output_tokens: 1500` too low | Raised to 2500 in v4 |
| `[object Object]` in step 15 review_object | `item_primary_key` defaulted to "tableName", `item_secondary_key` to "columns" -- workflow step objects have neither | Added `item_label_template: "Step {{step}} ({{type}})"` and `item_secondary_key: "description"` to step 15 |
| Step 15 -> 16 endless loop | `simulate on_failure: "step:15"` routed back to review gate with no fix path | Added steps 16a (js_transform: format errors) and 16b (human_gate: show errors, offer Regenerate or Cancel) |
| text_input modal not opening | "Regenerate with feedback" click advanced workflow to step 15a via SQS, but trigger_id was expired by the time callback.mjs tried to open modal | Added `modal` descriptor to option definition -- `interactive.mjs` opens modal synchronously on the button click within the 3-second trigger_id window |
| `[object Object]` in callback.mjs review_object | Plain object values fell through to `String(item.value)` | Added `else if (typeof item.value === 'object')` branch with `JSON.stringify` |

### create_workflow seed -- version history

| Version | Steps | Key change |
|---|---|---|
| v14 | 31 | Three-call left brain (gap analysis + process design + dialog design + step generation) |
| v15 | 33 | Added steps 16a, 16b (simulation error display + user choice) |
| v16 | 34 | Added step 15a (text_input feedback gate); step 14 now receives user_feedback + simulation_errors |
| v17 | 34 | Added `modal` descriptor to "Regenerate with feedback" in steps 15 and 16b |

### Prompt version history (session 27)

| Prompt | Version | Key change |
|---|---|---|
| `analyze_workflow_gaps` | v2 | Added DOMAIN MODE (A/B/C); Type 4b guidance; apostrophes-not-quotes rule |
| `analyze_workflow_gaps` | v3 | Added CRITICAL clause for inputs format (strings not objects) |
| `analyze_workflow_gaps` | v4 | max_output_tokens 1500 -> 2500 |
| `design_workflow_process` | v2 | Mode A/B/C; flat loop pattern 8-step guide; no dialog field instruction |
| `design_workflow_process` | v3 | max_output_tokens 2000 -> 4000 |
| `design_workflow_dialogs` | v2 | max_output_tokens 2000 -> 3000 |
| `generate_workflow_steps` | v7 | Three-input contract (process_design + state_map + dialog_designs) replacing monolith |
| `generate_workflow_steps` | v8 | Added user_feedback and simulation_errors input variables |

### Self-healing pipeline -- implemented (not yet deployed in production)

Four new/modified files ready for deployment in session 28:

| File | Status | Change summary |
|---|---|---|
| `src/shared/llm-client.mjs` | Modified | Captures output_tokens; sets parseErr.isTruncated when ceiling hit; adds callLlmWithResumption (1.5x budget, max 8000) |
| `src/proc/step-executor.mjs` | Modified | Branches on isTruncated -> callLlmWithResumption; logs token_truncation on resumption failure; passes priorErrorType to validate() |
| `src/proc/review-output.mjs` | Modified | Exports logPromptError; adds classifyAjvErrors(); adds priorErrorType param; fires monitor-prompt-quality fire-and-forget after 2-attempt failure |
| `src/proc/monitor-prompt-quality.mjs` | New | Classifies consecutive failure patterns; auto-patches token ceiling (2+ consecutive truncations); 24h cooldown; advisory-only for schema errors |

Architecture documented in Section 6.6 (expanded) and Section 6.5.1 (right-brain hook reference added).

**handler.mjs addition still needed before monitor is reachable via HTTP/SQS:**
```js
import { handle as monitorHandle } from './monitor-prompt-quality.mjs'
// HTTP:
case 'monitor-prompt-quality': return monitorHandle(req)
// SQS:
case 'MONITOR_PROMPT_QUALITY': return monitorHandle(buildReqFromSqs(message))
```

---

## Session 28 objectives -- evaluated in priority order

Before deploying the self-healing pipeline, session 28 evaluates and resolves the following issues. Items are ordered by technical dependency; items 1-2 are prerequisites for clean code management, items 3-5 are feature work, items 6-8 are code quality.

### 1. Character set issues -- encoding consistency across the codebase

**Symptom:** Em dash and other non-ASCII characters render inconsistently in git
diffs and in prompt seed files. When prompt seed files are modified, characters
oscillate between UTF-8 rendered (`--`) and JSON unicode escape (`\u2014`), and
between sessions the same character may appear differently in git.

**Evaluation tasks:**
- Confirm the repo's `.gitattributes` and editor settings enforce UTF-8 + LF line endings end-to-end
- Audit `seed_PGC_Prompt.json` and `seed_PGC_Workflow.json` for mixed encoding
- Determine whether the Perplexity/Claude LLM APIs return unicode escapes or rendered characters in JSON string values, and whether this matters for prompt text display in Slack
- Evaluate whether all prompt text should standardise on `\u2014` (JSON-safe, git-stable) or on UTF-8 rendered characters (human-readable in seed files)
- Confirm `.editorconfig` or similar tooling is in place to prevent future drift

**Decision needed:** establish the authoritative encoding standard and write it into the code review checklist.

### 2. Code collaboration and tooling improvements

**Symptom:** Claude cannot access the GitHub repo directly. Stale snapshot files in `/mnt/project` have caused incorrect edits in prior sessions. Lines untouched by a change have been inadvertently modified. Prior session changes have been overwritten.

**Evaluation tasks:**
- Assess whether the public GitHub repo URL (`https://github.com/javeaguiri/evolving-ai-mind`) can now be accessed via web_fetch, which would allow reading raw file contents without manual sharing
- Evaluate storing raw GitHub file URLs for key system files in `architecture.md` so Claude can fetch the current deployed version before modifying it, rather than requiring manual upload each session
- Evaluate whether Claude's str_replace editing approach (replace a unique string with a new string) is sufficiently precise given the stale-file incidents -- should every session start with a mandatory "share these files" checklist
- Assess whether the current `view_range` + `str_replace` pattern adequately prevents touching unchanged lines, or whether a diff-generation approach would be safer

**Decision needed:** update the session startup checklist in `architecture.md` and establish the file-sharing protocol that prevents stale-snapshot incidents.

### 3. Data inspection dev script for PGC_WorkflowRun analysis

**Purpose:** Enable rapid analysis of json data (particularly Phase 1 `research_workflow_domain` data obtained by command line curl to /serv/table(getRows))

**Specification:**
- Script: `dev_scripts/extract-run-data.mjs`
- Usage: `node dev_scripts/extract-run-data.mjs <JsonDataFilename> <jsonPath>`
- `jsonPath` is a dot-path into json data contained in JsonDataFilename file (e.g. `right_brain_research`, `process_spec.process_design`)
- Extracts the value at the given path. The path may be a relative path not anchored to the root node of the json file. 
  The code will have to traverse recursively the entire document.
- Outputs to stdout as formatted and valid JSON document (`JSON.stringify(value, null, 2)`)
- Optional `--raw` flag to skip JSON formatting (for piping)

**Primary use case:** Inspect Phase 1 research outputs to evaluate whether `research_workflow_domain` is producing useful design questions versus irrelevant app-architecture questions (known issue #1 from session 26 handoff).

### 4. Design iteration loop in Phase 1 (research_workflow_domain)

**Current state:** Phase 1 presents the right-brain research summary and a single preference gate (one question at a time via iterator). The user selects from pre-defined options. There is no mechanism to give free-text input at this stage, and no way to signal that a question is not applicable.

**Evaluation tasks:**
- Add N/A option to each preference gate in the iterator (step 5) -- `on_select: "next"`, does not write to `user_preferences`, signals the question was irrelevant
- Add Cancel option to each preference gate (already present in some but should be universal)
- Add a free-text human gate after the preference iterator (similar to step 15a in create_workflow) -- allows the user to add context that the right-brain did not surface as a structured question
- Evaluate whether the design iteration loop belongs in Phase 1 (before gap analysis) or Phase 3 (after process design) -- the two locations serve different purposes:
  - Phase 1 free text: "here's what matters to me about how this workflow should behave"
  - Phase 3 free text (step 15a): "change these specific generated steps"
- Evaluate whether `research_workflow_domain` should receive `domain_schema` as input (known issue #1 from session 26 -- without it, the right brain treats the request as greenfield even when domain tables exist)

**Decision needed:** confirm scope and routing before implementing seed changes.

### 5. AI chat as standalone and design iteration vehicle

**Concept:** A `/chat` Slack command that opens a stateful LLM conversation, usable standalone or as the free-text input mechanism for workflow design iteration (item 4 above).

**Evaluation tasks:**
- Assess whether `PGC_Session` and `PGC_SessionEntry` (currently Backlog -- Section 4.3.4) are required prerequisites for a meaningful chat implementation, or whether a stateless single-turn chat is useful without them
- Evaluate the interaction model: does the user type multiple turns in Slack (thread replies), or is each `/chat` invocation a single-turn exchange?
- Evaluate whether chat and workflow design iteration should share the same session context, or whether they are structurally separate
- Assess the cost model: chat calls the LLM on every turn; at household scale this is acceptable but should be documented
- Determine the minimum viable implementation scope before committing to `PGC_Session` infrastructure

**Decision needed:** MVP scope and session model before any code is written.

### 6. Code review -- rendering bugs and general quality

**Tasks in priority order:**

1. Update `docs/code-review-checklist.md` before beginning the code review:
   - Add rendering check: `review_object` gate -- verify `item_primary_key` and `item_secondary_key` are appropriate for the actual data type at `context_key` (not defaulting to "tableName"/"columns" for non-table data)
   - Add rendering check: any `review_object` or `description_list` value that could be an object must pass through a serialisation guard
   - Add check: `on_failure` routing in simulated steps must not route back to the same gate without a fix path available to the user
   - Add check: every workflow iterating over a preference array must have N/A and Cancel options on each item gate

2. Review `src/ui/slackbot/callback.mjs`:
   - Evaluate whether the large number of `postX` functions per message type is necessary or whether `dialogToBlocks()` can be the universal renderer (item 7 below)
   - Review all string-to-block conversions for the 3000-character Slack section block hard limit
   - Identify any hardcoded message formats that should be data-driven

3. Write unit tests for `buildDialog()` in `step-executor.mjs`:
   - Each gate type with a representative local_state fixture
   - Specifically test `review_object` with array-of-step-objects input (the `[object Object]` regression)
   - Test `choice` gate option rendering (value vs action distinction)

### 7. callback.mjs message type consolidation

**Current state:** `callback.mjs` has 10+ `postX` functions (`postPingSqsResult`, `postPingE2eResult`, `postCreateDomainResult`, `postDesignDomainGate`, `postDesignDomainError`, `postHelpGate`, `postHelpResult`, etc.), each with its own Block Kit construction logic. `dialogToBlocks()` already provides a generic Block Kit renderer for `WORKFLOW_GATE` messages.

**Evaluation questions:**
- Which message types carry structured dialog data that `dialogToBlocks()` could render vs. which carry truly bespoke layouts that require dedicated renderers?
- Can `WORKFLOW_NOTIFY` and `WORKFLOW_ERROR` be simplified to use a common text-to-blocks pattern rather than per-type formatting logic?
- Should all free-form text strings be run through a `textToBlocks(text)` utility that handles the 3000-character limit automatically, rather than per-function chunking logic?
- What is the correct scope for the Experience tier: should it be block-construction-free (PROC builds blocks, EXP just posts them) or is it acceptable for EXP to own some block construction for UI-specific messages like ping results?

**Decision needed:** confirm architectural boundary before refactoring.

### 8. Slack API capability review

**Purpose:** Ensure `callback.mjs` and `buildDialog()` correctly implement all Slack Block Kit elements needed for current and near-future workflows.

**Items to review against Slack API documentation (to be provided):**
- Button element: `style`, `confirm` dialog, `url` property
- Checkboxes: multi-select pattern for future `select_many` gate type
- Date/time pickers: potential use in workflow scheduling features
- File input: evaluate for future document/attachment upload flows
- Multi-select menu vs static_select: when each is appropriate
- Number input: evaluate for quantity fields in domain data entry workflows
- Plain-text input: max length constraints; single vs multiline
- Section block with accessory vs separate actions block: layout implications
- Rich text blocks: evaluate for formatted workflow notifications
- Table block (if available): evaluate for `review_object` tabular display

**Output:** Document supported elements and their correct Block Kit construction in `docs/slack-block-kit-reference.md` (new file). Reference from `callback.mjs` header.

---

## Deployment checklist for session 28

```cmd
rem Deploy code changes (self-healing pipeline -- session 27 output)
rem PREREQUISITE: add handler.mjs case for monitor-prompt-quality (handler.mjs not yet shared)
sam build && sam deploy

rem Upsert prompts (already deployed during session 27 manual testing)
node dev_scripts/upsert-prompt.mjs analyze_workflow_gaps
node dev_scripts/upsert-prompt.mjs design_workflow_process
node dev_scripts/upsert-prompt.mjs design_workflow_dialogs
node dev_scripts/upsert-prompt.mjs generate_workflow_steps

rem Upsert create_workflow v17
node dev_scripts/upsert-workflow.mjs create_workflow

rem Validate end-to-end -- Phase 5 and 6 are the primary targets
rem (Phases 0-4 confirmed working in session 27)
```

## Session 28 startup checklist

1. Share `architecture.md` from session 27 outputs
2. Confirm git tag `v3.2-session27-complete`
3. Before any code: request `handler.mjs` to add the `monitor-prompt-quality` case
4. Run `/m create workflow spanish flashcard quiz` -- target: reach Phase 6 (workflow registration)
5. Begin session 28 evaluation items in order: character encoding -> file sharing -> dev script -> iterate

## Known open issues carried from session 26

### 1. research_workflow_domain -- no domain_schema input (Medium)
Right brain treats all requests as greenfield. Fix: add `"domain_schema": "{{domain_schema}}"` to step 2 input; add Mode A instruction to `research_workflow_domain` v2.

### 2. Phase 5-6 not yet validated end-to-end (High -- primary session 28 target)
Steps 17 (generate_workflow_mocks), 18 (generate_workflow_paths), 19 (simulate Level 2+3), 20-23 (registration) have not completed a successful run.

### 3. create_domain auto-embed not verified (Low)
If a new domain is created and `embedding` is null on the `PGC_DomainHelp` row, run `backfill-embeddings.mjs`.

### 4. Pass 2 keyword scan excludes domain:null workflows (Low)
System workflows (create_workflow, help, ping, shutdown) are unreachable via Pass 2 keyword scan. Causes unnecessary Tier 2 sonar calls for known system commands.
