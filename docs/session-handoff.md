# evolving-mind-ai — Session 26 Handoff

**Git tag:** `v3.2-session25-complete`
**Session 25 final state:** llm-client.mjs hardened, diagnose_prompt_schema extended to R7,
probe_input on PGC_Prompt, integration test per-prompt, addColumn endpoint live.

---

## What session 26 must accomplish

One track: **Implement pgvector** — permanent fix for domain resolution replacing fragile alias matching.

The alias-patch workaround from the session 25 handoff (Track 1) was applied manually. pgvector is
the architectural fix that makes alias maintenance unnecessary going forward.

Full spec is in `architecture.md` Section 10. Implementation sequence below.

---

## Pre-work — update architecture.md

Before writing any code, Javear will share the current `architecture.md`. Update it to reflect
everything completed in session 25 before pgvector work begins:

- Session 25 summary section
- `llm-client.mjs` — `isSonar` response_format gating (non-sonar models rejected 400 with response_format)
- `llm-client.mjs` — fence extraction regex (leading/trailing prose around fenced JSON)
- `step-executor.mjs` — `"false"` added to executeCondition falsy set
- `diagnose_prompt_schema` — R7 rule (unsupported model names), v3→v4
- `diagnose_prompt_schema` — R2 correction (boolean `true` is valid; only typed-object schemas flagged)
- `diagnose-prompt-schema.mjs` — `model` added to `repair_state`
- `schema.mjs` + `openapi.yaml` — `POST /serv/schema/addColumn` with `schemaOnly` mode
- `PGC_Prompt` — `probe_input jsonb` and `max_output_tokens integer` columns added
- `seed_PGC_Prompt.json` — 12 entries, latest version only, `probe_input` + `max_output_tokens` on all
- `upsert-prompt.mjs` — now writes `probe_input` and `max_output_tokens`
- `tests/integration/llm-prompt-schema.test.mjs` — one `it()` per prompt, `probe_input` substitution

---

## pgvector implementation sequence

### Step 1 — Enable pgvector on RDS

Run directly on the RDS instance via bastion (no Lambda deploy needed):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Step 2 — Add embedding column to PGC_DomainHelp via addColumn endpoint

Use the new `addColumn` endpoint (deployed this session) — this handles both the physical DDL
and the PGC_Schema metadata update atomically:

```cmd
curl -s -X POST https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/serv/schema/addColumn -H "Content-Type: application/json" -d "{\"tableName\":\"PGC_DomainHelp\",\"column\":{\"name\":\"embedding\",\"type\":\"vector\",\"nullable\":true}}"
```

**Note:** `vector` is not currently in `ALLOWED_TYPES` in `schema.mjs` — this call will fail until
Step 3 is deployed. Deploy Step 3 first.

### Step 3 — Add `vector` to ALLOWED_TYPES in schema.mjs

Request current `schema.mjs`. Add `'vector'` to the `ALLOWED_TYPES` set. Deploy:

```cmd
sam build && sam deploy
```

Then run the Step 2 curl above.

### Step 4 — Write src/shared/embed-client.mjs

New file. Wraps OpenAI `text-embedding-3-small`, reads API key from SSM SecureString:

```js
export async function embedText(text, traceId) {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-2' });
  const { Parameter } = await ssm.send(new GetParameterCommand({
    Name: process.env.OPENAI_API_KEY_PARAM,
    WithDecryption: true,
  }));
  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Parameter.Value}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!resp.ok) throw new Error(`OpenAI embeddings API error ${resp.status}`);
  const data = await resp.json();
  return data.data[0].embedding; // float[], 1536 dimensions
}
```

Add `OPENAI_API_KEY_PARAM` to the PROC Lambda environment block in `template.yaml`. Store the
OpenAI key in SSM as a SecureString at the agreed parameter name.

### Step 5 — Write dev_scripts/backfill-embeddings.mjs

One-shot script. Reads all `PGC_DomainHelp` rows where `embedding IS NULL`, calls `embedText`
with `domain + " " + description + " " + aliases.join(" ")` for each, writes the vector back
via SERV `updateRows`. Run once after Steps 1–4 are deployed.

### Step 6 — Update classify-intent-tiers.mjs

Add semantic fallback alongside the existing exact alias check. Only called when
`matchDomainAlias()` returns null:

```js
export async function semanticDomainMatch(userInput, domainRows) {
  const populated = domainRows.filter(r => r.embedding);
  if (!populated.length) return null;
  const queryVec = await embedText(userInput);
  let best = null, bestSim = 0;
  for (const row of populated) {
    const sim = cosineSimilarity(queryVec, row.embedding);
    if (sim > bestSim) { bestSim = sim; best = row; }
  }
  const threshold = 0.75; // read from PGC_SystemContext.pgvector_config when available
  return bestSim >= threshold ? { domain: best.domain, confidence: 'semantic_match' } : null;
}
```

Update `classify-intent.mjs` — `CREATE_WORKFLOW` domain resolution block and Pass 2 domain
match to call `semanticDomainMatch()` when `matchDomainAlias()` returns null.

### Step 7 — Update create_domain workflow to embed on domain creation

After the step that inserts the `PGC_DomainHelp` row, add an embedding step. Two options:

**Option A** (simpler, no new endpoint): add a `capability_call` step once that step type exists.

**Option B** (available now): add a new SERV endpoint `POST /serv/embed/domain-help` that takes
`{ id }`, reads the row, calls `embedText`, writes the vector back. Invoke via `serv_query`-style
step in the `create_domain` workflow. Requires openapi.yaml update first (spec-first rule).

Decide at session start which option to use based on whether `capability_call` is available.

---

## Files needed at session start

Request these from the repo before writing any code:

- `architecture.md` — share first; update before anything else
- `src/serv/schema.mjs` — to add `vector` to ALLOWED_TYPES
- `template.yaml` — to add OPENAI_API_KEY_PARAM env var to PROC Lambda
- `src/proc/classify-intent.mjs` — for domain resolution update
- `src/proc/classify-intent-tiers.mjs` — for semantic fallback addition
- `src/serv/openapi.yaml` — if Option B chosen for Step 7
- `seed_PGC_Workflow.json` — for create_domain update in Step 7

---

## Session 25 completed items (do not redo)

**System fixes:**
- `llm-client.mjs` — `isSonar` guard: `response_format` only sent to sonar models; non-sonar models return HTTP 400 with it present
- `llm-client.mjs` — fence extraction: `rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)` handles leading preamble and trailing explanations
- `step-executor.mjs` — `"false"` added to `executeCondition` falsy set; fixes `diagnose_prompt_schema` step 8 routing
- `seed_PGC_Workflow.json` — `diagnose_prompt_schema` R2 fix (v2→v3): boolean `true` no longer flagged

**New capability:**
- `schema.mjs` + `openapi.yaml` — `POST /serv/schema/addColumn` with `schemaOnly: true` mode for metadata-only sync
- `PGC_Prompt.json` — `probe_input jsonb` and `max_output_tokens integer` columns
- `diagnose_prompt_schema` v4: R7 rule (unsupported model names), step 10 patches `model` field, step 12 actionable guidance
- `diagnose-prompt-schema.mjs` — `model` added to `repair_state`

**Evolving-mind artifacts:**
- `seed_PGC_Prompt.json` — 12 entries, one per intent_category (latest version only); `probe_input` + `max_output_tokens` on all; `analyze_and_design_workflow` v10 constrains `prompts_needed.model` to supported values
- `upsert-prompt.mjs` — writes `probe_input` and `max_output_tokens` in both update and insert paths
- `prompt-issues.md` — Issue 5 R2 corrected; Issue 6 (unsupported model names); Issue 7 (prose around fenced JSON)

**Integration test:**
- `tests/integration/llm-prompt-schema.test.mjs` — one `it()` per prompt via ESM top-level await; `probe_input` substitution mirrors `step-executor.mjs`; HTTP 400 always hard fail; non-400 hard fail only when `probe_input` present

## Pending deploys going into session 26

```cmd
sam build && sam deploy

node dev_scripts/upsert-workflow.mjs diagnose_prompt_schema
node dev_scripts/upsert-prompt.mjs create_domain
node dev_scripts/upsert-prompt.mjs generate_crud_workflows
node dev_scripts/upsert-prompt.mjs analyze_and_design_workflow
node dev_scripts/upsert-prompt.mjs generate_workflow_steps
node dev_scripts/upsert-prompt.mjs fix_workflow_steps
node dev_scripts/upsert-prompt.mjs research_workflow_domain
node dev_scripts/upsert-prompt.mjs design_table
node dev_scripts/upsert-prompt.mjs classify_intent_tier2
node dev_scripts/upsert-prompt.mjs classify_workflow_intent
node dev_scripts/upsert-prompt.mjs generate_workflow_mocks
node dev_scripts/upsert-prompt.mjs generate_workflow_paths
node dev_scripts/upsert-prompt.mjs parse_entity_input
```

## Known open issues carried forward

| Issue | Status |
|---|---|
| pgvector / semantic domain matching | **Primary session 26 goal** |
| `create_workflow` end-to-end validation with Spanish flashcards | Unblocked after pgvector — retry after Step 6 |
| `create_domain` step 6–12 — limited end-to-end run history | Still open |
| Session layer `PGC_Session` / `PGC_SessionEntry` | Backlog |
| `sub_workflow` and `capability_call` step types | Backlog |
| Guard 3 cycle detector backward reference handling | Medium priority |
| `serv_update` and `serv_delete` step types | Deferred |
| Flashcard domain artifact prompts missing `probe_input` (`grade_flashcard_answer`, `generate_flashcard_quiz_spec`) | Patch via `updateRows` before next test run |

## Git tag suggestion

`v3.2-session25-complete`
