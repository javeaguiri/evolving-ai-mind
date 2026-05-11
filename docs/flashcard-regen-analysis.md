# Flashcard Workflow Regeneration Loop — Root Cause Analysis

**Run:** 317 (`create workflow Spanish flashcard quiz`)
**Date:** 2026-05-10
**Symptom:** `generate_workflow_steps` (step 23 of `create_workflow`) regenerated 6 times with the same `unresolved_template_variable` error persisting across every attempt.

---

## Error Observed

```
Step 12: Step '12' references '{{test_result}}' but base key 'test_result'
has not been written by any prior step.
Available keys: ..., loop_state,new_streak,test_result,current_card_id
```

---

## What the LLM Intended

Step 10 is a `js_transform` that updates loop state and returns multiple values at once:

```json
{
  "step": "10",
  "type": "js_transform",
  "expression": "(function() { ... return { loop_state: {...}, new_streak: ..., test_result: response, current_card_id: ... }; })()",
  "output_key": "loop_state,new_streak,test_result,current_card_id",
  "on_success": "next"
}
```

The LLM used a comma-separated `output_key` to express "destructure the returned object into multiple local_state keys." This is a natural pattern but not a supported engine format.

---

## Root Cause 1 — Comma-separated `output_key` is silently mishandled

Both the L1 static analyser and L2 simulator split `output_key` on `.` (dot), not `,` (comma):

```js
// step-executor.mjs:1400  (L1 validation)
const baseOut = s.output_key.split('.')[0];
outputKeysSoFar.add(baseOut);

// step-executor.mjs:1655  (L2 simulation)
const baseOut = currentStep.output_key.split('.')[0];
localState[baseOut] = mockOutput;
```

With `output_key = "loop_state,new_streak,test_result,current_card_id"`, the whole comma-separated string becomes `baseOut` (no dot to split on). The engine registers the literal string as a single key name.

`run-workflow.mjs:1124` (`setPath`) also splits on `.`:

```js
function setPath(obj, path, value) {
  const parts = path.split('.');
  ...
  cur[parts[parts.length - 1]] = value;
}
```

In live execution, `setPath(frame.local_state, "loop_state,new_streak,test_result,current_card_id", returnValue)` creates one key with a comma-laden name and writes the entire return object to it. `local_state.test_result` is never set.

**Effect:** The Available keys list in the L1 error shows `loop_state,new_streak,test_result,current_card_id` as a single entry — the LLM can see `test_result` is "in there" but has no way to access it individually.

---

## Root Cause 2 — Correction instruction blocks the only valid fix

The `generate_workflow_steps` prompt's correction rule for `unresolved_template_variable` reads:

> Fix: correct the template reference to a key that exists at that point.
> **Do NOT change routing, gate_type, or output_key.**

The actual fix requires changing `output_key`. The instruction prohibits it. The LLM is stuck — it cannot fix the template reference (`{{test_result}}`) by referencing any existing key, and it cannot change the `output_key` that is the source of the problem.

Across 6 attempts the LLM tried different workarounds:

| Session | Approach | Why it failed |
|---------|----------|---------------|
| 195 (attempt 1) | Comma-separated `output_key` | Not a supported format — treated as single key |
| 196–199 (attempts 2–5) | Variations on the same pattern | Same root cause |
| 200 (attempt 6) | Changed `output_key` to `"transform_result"`, added step 11 to manually copy keys via `local_state.test_result = result.test_result` | `local_state` in the vm sandbox is a JSON-parsed copy; mutations are lost and never written back to frame state |

The mutation approach (attempt 6) fails because `runSandboxedExpression` passes `local_state` as a serialised copy:

```js
// step-executor.mjs:407
const sandbox = { __ls: JSON.stringify(localState), ... };
const wrapped = `var local_state=JSON.parse(__ls); ...`;
```

Any assignment to `local_state` inside the expression modifies only the deserialized copy inside the vm context. The frame's actual `local_state` is untouched.

---

## Root Cause 3 — Missing `input_key` would cause runtime failure

The LLM generates js_transform steps without an `input_key` field (matching the flat-loop example shown in the prompt, which also omits it). But `executeJsTransform` requires it:

```js
// step-executor.mjs:316
if (!step.input_key) throw new Error('js_transform expression step missing input_key');
```

L1 and L2 do not validate required step fields — they would not catch this. Even if the L1 `unresolved_template_variable` error were resolved, all js_transform steps would throw at runtime.

---

## Proposed Fixes

### Fix 1 — Engine: support comma-separated `output_key` in js_transform

When `output_key` contains commas, treat it as a multi-output descriptor. Expect the return value to be an object and write each listed key separately to `local_state`.

**`run-workflow.mjs` (actual execution, ~line 360):**
```js
if (step.output_key && result.outputValue !== null && result.outputValue !== undefined) {
  const keys = step.output_key.split(',').map(k => k.trim());
  if (keys.length > 1 && typeof result.outputValue === 'object' && result.outputValue !== null) {
    for (const key of keys) {
      if (key in result.outputValue) setPath(frame.local_state, key, result.outputValue[key]);
    }
  } else {
    setPath(frame.local_state, step.output_key, result.outputValue);
  }
}
```

**`step-executor.mjs` L1 validation (~line 1399):**
```js
if (s.output_key && typeof s.output_key === 'string') {
  for (const rawKey of s.output_key.split(',')) {
    const baseOut = rawKey.trim().split('.')[0];
    outputKeysSoFar.add(baseOut);
    stepWrites.add(baseOut);
    if (!writtenByStep[baseOut]) writtenByStep[baseOut] = stepKey;
  }
}
```

**`step-executor.mjs` L2 simulation (~line 1654):**
```js
if (currentStep.output_key && typeof currentStep.output_key === 'string' && mockOutput !== null) {
  for (const rawKey of currentStep.output_key.split(',')) {
    const baseOut = rawKey.trim().split('.')[0];
    if (!localState[baseOut]) {
      localState[baseOut] = mockOutput;
      transition.keys_added.push(baseOut);
    }
  }
}
```

### Fix 2 — Engine: make `input_key` optional in `executeJsTransform`

If `input_key` is absent, pass `null` as `items`. The expression can read everything it needs from `local_state` directly.

**`step-executor.mjs` (~line 316):**
```js
// Remove the throw; make input_key optional.
const items  = step.input_key ? resolvePath(localState, step.input_key) : null;
const result = runSandboxedExpression(expression, items, localState, traceId);
```

### Fix 3 — Artifact: update the `unresolved_template_variable` correction rule

In `seed_PGC_Prompt.json` (prompt `generate_workflow_steps`), change:

> Do NOT change routing, gate_type, or output_key.

to:

> Do NOT change routing or gate_type. You MAY change output_key only when the key referenced was never written by any prior step and the output_key is the source of the mismatch.

### Fix 4 — Artifact: update js_transform step type contract

In `seed_PGC_StepType.json`, update `js_transform`:

- `input_key`: change `"required": true` to `"required": false`; add note: "Optional — if absent, items is null; access all prior output via local_state directly."
- `output_key`: update description: "Dot-path where the result is written. Comma-separate multiple keys (e.g. `\"a,b,c\"`) to destructure an object return value into multiple local_state keys simultaneously."

---

## Files to Change

| File | Change |
|------|--------|
| `src/proc/run-workflow.mjs` | Multi-output destructuring on comma-separated output_key |
| `src/proc/step-executor.mjs` | L1 and L2 comma-split; make input_key optional |
| `dev_scripts/seed_PGC_Prompt.json` | Fix correction rule for unresolved_template_variable |
| `dev_scripts/seed_PGC_StepType.json` | Update js_transform input_key + output_key contracts |

After deploying code changes: run `node dev_scripts/upsert-prompt.mjs generate_workflow_steps` and `node dev_scripts/upsert-step-type.mjs` to push artifact updates to the DB. Run 317 should be cancelled and the Spanish flashcard quiz workflow re-created from scratch.

---

## Implementation Status (2026-05-11)

All four fixes implemented, deployed, and pushed in commit `a0a939d`. Artifacts pushed to DB via upsert scripts. Unit tests: 18 pre-existing failures remain; 10 tests that were previously failing now pass as a side-effect of the engine fix. Zero regressions.

---

## Workflow Readiness Assessment

**Short answer: the core logic is correct and about 70% of the way to a working runtime workflow.** The engine fix resolves the blocker that was causing the regeneration loop. However, two further issues exist in the generated step array that will surface on the next attempt.

### What works well

The overall structure from session 195 (attempt 1) is well-designed:

- Load sets → user picks set → load cards → create study session (steps 1–4)
- js_transform initialises loop state with sorted/weakest-first subset (step 5)
- Condition guards mastery exit (step 6) and end-of-subset (step 7)
- js_transform resets/filters subset when index wraps (step 8)
- human_gate presents the card to the user (step 9)
- js_transform updates streak, counters, and records result (step 10) ← fixed by engine
- serv_update and serv_insert persist results (steps 11–12)
- Loop closes back to the mastery guard (step 6)
- Study session completed, notify user (steps 13–14)

The flat-loop pattern is applied correctly; the state_map is coherent; routing is logically sound.

### Remaining issue A — Dynamic index in `message_template` (will cause L1 or runtime failure)

Step 9's `message_template` contains:

```
{{loop_state.subset.{{loop_state.index}}.term}}
```

The template resolver does not support nested `{{}}` tokens — it resolves tokens linearly via regex. `{{loop_state.index}}` would be extracted as one token and `loop_state.subset.` left as a literal fragment. The card term and definition will never render correctly.

**Fix required:** Add a `js_transform` step before step 9 that extracts the current card from the subset and writes it to a flat key:

```json
{
  "step": "8b",
  "type": "js_transform",
  "description": "Extract current card from loop_state.subset at current index.",
  "expression": "(function(){ return local_state.loop_state.subset[local_state.loop_state.index]; })()",
  "output_key": "current_card",
  "on_success": "next"
}
```

Then step 9's `message_template` can use `{{current_card.term}}` and `{{current_card.definition}}` safely.

### Remaining issue B — Conditional increment in `serv_update` input (will fail at runtime)

Step 11's `serv_update` input uses JS ternary expressions as template values:

```json
"total_passed": "{{test_result === 'correct' ? '++' : 'current'}}"
```

Template resolution only substitutes `{{key}}` tokens — it does not evaluate expressions. This would set the column to the literal string `"correct === 'correct' ? '++' : 'current'"` or similar.

**Fix required:** Compute the actual increment values in step 10's `js_transform` and write them as `total_passed_delta` and `total_failed_delta` (integers 0 or 1), then reference `{{total_passed_delta}}` in the `serv_update`. Or compute new absolute values and pass them directly.

### Summary

| Issue | Caught by | Action needed |
|-------|-----------|---------------|
| Comma-separated `output_key` (step 10) | L1 | **Fixed** — engine now supports multi-output |
| Missing `input_key` on js_transform steps | Runtime | **Fixed** — `input_key` now optional |
| Nested dynamic template `{{subset.{{index}}.prop}}` (step 9) | L1 or runtime | New `current_card` extraction step needed |
| JS ternary in `serv_update` input (step 11) | Runtime | Pre-compute delta values in js_transform |

---

## Run 320 — Schema Validation False Positive (2026-05-11)

**Symptom:** `generate_workflow_steps` (step 23) failed validation after 2 attempts with 2 schema errors per attempt. Different failure mode than run 317 — not a template variable error but a `schema_violation` pattern.

### Root Cause — `review-output.mjs` wrong field name in cancel check

`runRoutingValueRules` checked `o.action === 'cancel'` to verify that every `human_gate` had a cancel option. Human gate options use `on_select` for routing — there is no `action` field on options. Every cancel button the LLM correctly generated with `on_select: "cancel"` was rejected as a false positive.

```js
// Before fix — wrong field
const hasCancel = (s.options ?? []).some(o => o.action === 'cancel');

// After fix — correct field
const hasCancel = (s.options ?? []).some(o => o.on_select === 'cancel');
```

**Correction attempt behavior:** The LLM received the error message "has no option with action 'cancel'" and on attempt 2 introduced a `special_buttons` array (not a real schema concept) with `action: "cancel"`. This added a second schema violation rather than fixing the first. Both attempts failed for the same underlying reason.

**Fix:** Commit `beb99c7` — `review-output.mjs` corrected to check `o.on_select`. Also fixed the options loop error-message label from `opt.action` (always `undefined`) to `opt.label ?? opt.value`.

**System implication logged in backlog:** L1 static analysis should detect nested `{{...{{...}}...}}` template tokens before the workflow is registered.

---

## Run 321 — Successful Registration (2026-05-11)

**Result:** ✅ `spanish_flashcard_quiz` registered and ready (`domain: spanish_flashcards`, 13 steps).

### What self-corrected vs run 317

| Issue from Readiness Assessment | Outcome in run 321 |
|---|---|
| Comma-separated `output_key` (engine fix) | ✅ Working — step 8 uses `output_key: "quiz_state,card_updates"` correctly |
| Missing `input_key` (engine fix) | ✅ Working — step 8 has no `input_key`; engine treats it as optional |
| JS ternary in `serv_update` | ✅ Self-corrected — LLM pre-computed delta values in step 8 js_transform, writing `card_updates.total_passed` / `card_updates.total_failed` as flat integers; step 9 references them directly |
| Nested dynamic template (step 7) | ⚠️ Still present — different token form but same problem (see below) |

### Registered Workflow — Step Array Analysis

**Structure (13 steps):**
1. `serv_query` — load active flashcard sets ordered by name
2. `human_gate` (choice) — user picks set (options A–E hardcoded to indices 0–4; cancel present)
3. `serv_query` — load all cards for selected set
4. `serv_insert` — create StudySession record
5. `js_transform` — initialize `quiz_state` (shuffled cards, index=0, counters)
6. `condition` — if `index >= cards_array.length` → step 11 (finalize), else → step 7
7. `human_gate` (choice) — present card, collect correct/incorrect/cancel
8. `js_transform` — advance index, compute `card_updates`, set done flag; `output_key: "quiz_state,card_updates"`
9. `serv_update` — update flashcard streak/counters from `card_updates`
10. `serv_insert` — write TestLog; `on_success/on_failure: "step:6"` (loop)
11. `serv_update` — finalize StudySession with completion metrics
12. `notify` — post quiz completion summary
13. `end`

**Good:** Flat-loop pattern applied correctly. Multi-output step 8 uses the engine fix. Conditional increment Issue B self-resolved. All routing targets exist.

### Remaining Issue — Nested Template in Step 7 (runtime blocker)

Step 7's `message_template`:
```
{{quiz_state.cards_array.{{quiz_state.index}}.term}}
```

The `design_workflow_dialogs` step (22) generated a bracket-notation form `.[quiz_state.index]` which is also unsupported. `generate_workflow_steps` (step 23) then re-expressed it as nested `{{}}`. Neither form works with the template resolver, which processes tokens in a single linear pass using `/\{\{([^}]+)\}\}/g`.

**Runtime behavior:** The inner token `{{quiz_state.index}}` may be extracted as a match, leaving `quiz_state.cards_array.` and `.term}}` as literal fragments. The card term will never render.

**Fix required (artifact repair — do not regenerate the whole workflow):** Insert a `js_transform` step 6b before step 7:
```json
{
  "step": "6b",
  "type": "js_transform",
  "expression": "(() => local_state.quiz_state.cards_array[local_state.quiz_state.index])()",
  "output_key": "current_card",
  "on_success": "next"
}
```
Then replace `{{quiz_state.cards_array.{{quiz_state.index}}.term}}` with `{{current_card.term}}` and `{{quiz_state.cards_array.{{quiz_state.index}}.card_type}}` with `{{current_card.card_type}}` in step 7's `message_template`.

**L1 miss:** L1 did not detect the nested template syntax. A system-level fix (add `/\{\{[^}]*\{\{/` scan in L1) is tracked in `docs/backlog.md` under High Priority.

### Additional Observations

- **Step 2 hardcoded set slots:** Options A–E hardcode `flashcard_sets.0` through `flashcard_sets.4`. If the user has fewer than 5 active sets, unused options will render `undefined`. Not a blocker for initial use but degrades the experience.
- **Step 9 `on_failure: "next"`:** The flashcard stat update failing silently and continuing is intentional tolerance — acceptable.
- **`quiz_state.cards_array.length` in step 11:** Accesses `.length` via dot-path template — works correctly since the resolver traverses via `obj[key]` which returns the native array length property.

---

## spanish_flashcards Domain — Deferred Feature Enhancements

From `gap_analysis.deferred` in run 321 (`PGC_WorkflowRun` id 321). These are user artifact improvements — new workflows or domain schema changes — not system work.

| Enhancement | Description | How to implement |
|---|---|---|
| Timer-based response tracking | Capture `response_time_seconds` per test; visual countdown during card presentation | `js_transform` before TestLog insert captures elapsed time via `Date.now()` delta stored in `quiz_state`. Add `response_time_seconds` column to `PGD_TestLogs`. |
| Spaced repetition scheduling | Surface cards at scientifically determined review intervals rather than user-initiated sessions | Add `next_review_date` column to `PGD_Flashcards`. New scheduled workflow calculates intervals from forgetting curves and posts review notifications. |
| Session comparison analytics | Visualize learning trends by comparing pass rates across multiple sessions | New workflow queries `PGD_StudySessions` with date-range filters and aggregates metrics into a visual summary report posted to Slack. |

On the next `/m create workflow Spanish flashcard quiz` the engine fixes will allow the multi-output step 10 to work and L1 will pass that check. The LLM will then need to solve the remaining two issues — issue A should surface in L1 as `unsupported_handlebars_syntax`, which the prompt handles correctly. Issue B may pass L1/L2 silently and only fail at runtime, so it may require an additional regeneration cycle or manual inspection.
