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
