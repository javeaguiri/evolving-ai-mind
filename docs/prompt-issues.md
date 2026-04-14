# evolving-mind-ai — Prompt Issues Log

Tracks observed LLM prompt quality problems for future analysis and improvement.
Each entry records what was observed, the failure pattern, and what a fix would need to address.
This doc feeds the Prompt Performance Monitor backlog item — do not patch prompts directly
from this log without going through the right-brain improvement workflow.

---

## Issue 1 — `research_workflow_domain` — oversized output, validation failures

**Prompt id:** (seed entry, model: `perplexity/sonar`)
**Observed:** Sessions 23
**Failure pattern:** Consistently returning 2500–2900 output tokens. Hitting Perplexity's
default 8192 output token ceiling when combined with correction attempt. Multiple validation
failures (2–11 errors) on attempt 1 requiring correction loop. One JSON parse failure
(unterminated string at position 1262) indicating mid-response truncation on a prior ceiling.
**Root cause:** Prompt instructed LLM to "research what is known" and "cover all design-relevant
aspects" with no scope constraints. `perplexity/sonar` performs web research and produces a
comprehensive essay rather than a compact JSON object.
**Action taken:** Prompt rewritten with explicit scope constraints (max 3 findings, max 3
preference questions, per-field token budgets). Output schema `maxItems`/`maxLength` added.
`max_output_tokens: 2000` set on the prompt record.
**Remaining risk:** LLM still produces ~600–1000 tokens on average (acceptable). Occasionally
returns invalid JSON (position 1262 error) — likely a sonar web-search mid-response interruption.
**Monitor threshold:** `validation_fail_rate > 0.2`, `avg_duration_ms > 30000`

---

## Issue 2 — `analyze_and_design_workflow` — severe schema mismatch

**Prompt id:** 25 (model: `anthropic/claude-sonnet-4-5`)
**Observed:** Session 23
**Failure pattern:** Both validation attempts failed. Attempt 1: 26 errors. Attempt 2: 37 errors.
Attempt 3 (correction): 115 errors — correction made things worse.
Error details logged to `PGC_Prompt.error_log` for prompt id 25.
**Root cause:** LLM producing output with entirely wrong field names:
- `step_id` instead of `step_label` in `process_design` and `dialog_designs`
- `order`, `label`, `prompt_category`, `reads_state`, `writes_state`, `on_success`, `on_error`
  as extra fields in `process_design` items (all rejected by `additionalProperties: false`)
- `gaps_found` at root level (not in schema)
- `state_map` as wrong type
- `gate_type` values outside the allowed enum
- `context_key`, `output_key` as wrong type in `dialog_designs`
The LLM appears to be using its own interpretation of a workflow design spec schema rather
than following the declared output_schema. The correction prompt made things worse (115 errors
vs 37) indicating the model is not reading the schema constraints correctly from the correction
message.
**Input size:** 18,859 input tokens — the prompt + step_type_contracts injection is very large.
At this size the model may be ignoring schema details in the correction prompt.
**Action needed:**
1. Review `analyze_and_design_workflow` output_schema — verify field names match what the prompt
   instructs the LLM to produce. There may be a drift between prompt instructions and schema.
2. Add `max_output_tokens` to cap output and reduce context pressure on correction attempt.
3. Consider whether `step_type_contracts` injection (full PGC_StepType rows) is necessary here —
   this is a design step, not a step generation step. Removing it would significantly reduce
   input token count and may improve schema compliance.
4. The correction loop receiving 37→115 error growth suggests the correction message format
   is not effective for this prompt. May need a different correction strategy (e.g. provide
   the schema inline in the correction rather than just listing errors).
**Monitor threshold:** `validation_fail_rate > 0.5`, `avg_duration_ms > 60000`

---

## Issue 3 — `fix_workflow_steps` — output too large, produces full step array instead of partial

**Prompt id:** (seed entry, model: `anthropic/claude-sonnet-4-5`)
**Observed:** Session 23
**Failure pattern:** LLM returns `corrected_steps` containing all 27 steps of `create_workflow`
when only 4 condition steps needed fixing. Output token counts: 5049, 5275, 5338, 5426 across
multiple runs. One run hit the 8192 token ceiling producing truncated JSON (`Unterminated string
at position 25722`).
**Root cause:** Prompt instructs LLM to "produce a fully corrected step array (complete array —
not a diff)". With 27 steps this produces excessive output. The LLM also receives the full
step array as `broken_steps` input (before the step 3 filter was fixed).
**Action taken:**
- `fix_workflow` step 3 `js_transform` now filters `broken_steps` to only issue-referenced
  steps before sending to LLM — reduces input from 27 to 4 steps.
- `fix_workflow` step 4b merge `js_transform` patches corrected steps back into full array —
  LLM no longer needs to return the full array.
- `max_output_tokens` can now be set lower on this prompt since output is 4 steps not 27.
**Remaining:** Prompt still says "complete array — not a diff". Should be updated to say
"return only the steps you changed" now that step 4b handles the merge. This eliminates
remaining token waste and reduces risk of the LLM returning unrequested steps.
**Monitor threshold:** `output_tokens > 3000` (should be well under 1000 with filter + merge)

---

## Issue 4 — `research_workflow_domain` — occasional invalid JSON (sonar web search interruption)

**Prompt id:** (seed entry, model: `perplexity/sonar`)
**Observed:** Session 23
**Failure pattern:** `Expected ',' or ']' after array element in JSON at position 1262`.
Output was 1071 tokens — well within the 2000 ceiling. The JSON was syntactically invalid
mid-array, suggesting a sonar web-search result was injected into the output stream and
corrupted the JSON structure.
**Root cause:** `perplexity/sonar` performs live web searches and may inject search result
snippets or citations into the response stream, breaking JSON structure. This is a known
sonar behaviour when web search is not explicitly disabled.
**Action needed:** Investigate whether the Perplexity Agent API supports disabling web search
for this call (e.g. `tools: []` with no `web_search` tool). If sonar is only needed for
reasoning (not live search), disabling web search would eliminate this failure class.
Alternatively, consider switching `research_workflow_domain` to `anthropic/claude-sonnet-4-5`
which does not perform web searches and produces more predictable JSON.
**Monitor threshold:** Track `error_type: invalid_json` in `PGC_Prompt.error_log`

---

## Backlog — Prompt Performance Monitor

When implemented, this monitor should:
- Read `PGC_Prompt.error_log` and `PGC_WorkflowRunStep` duration data per `intent_category`
- Compute: `validation_fail_rate`, `avg_duration_ms`, `avg_output_tokens`, `max_output_tokens_hit`
- Trigger prompt improvement workflow when thresholds exceeded (per-prompt thresholds above)
- On `max_output_tokens` hit: auto-bump ceiling by 25% and log, flag for human review
- On `validation_fail_rate > threshold`: propose prompt rewrite targeting the specific error
  class, present at human gate before applying
- On `avg_duration_ms > threshold`: propose scope reduction or model switch

Priority order for first monitor pass: Issue 2 (analyze_and_design_workflow) → Issue 3
(fix_workflow_steps prompt text update) → Issue 4 (sonar web search)
