# evolving-mind-ai — Session 25 Handoff

**Git tag:** `v3.2-session24-complete`
**Session 24 final state:** create_workflow routing fixed, Tier 1b self-repair deployed, R1–R6 schema compatibility enforced, repair loop guard in place.

---

## What session 25 must accomplish

Two tracks, in dependency order:

1. **Fix domain resolution for `create_workflow`** — immediate unblock
2. **Implement pgvector** — permanent fix replacing alias matching

Both are required. Track 1 is a short-term data fix that unblocks testing. Track 2 is the architectural fix that makes Track 1 unnecessary going forward.

---

## Track 1 — domain_schema fix for create_workflow (immediate)

### Root cause (confirmed across runs 228, 233)

`create_workflow` receives `input.domain = null` on every run. This is because `matchDomainAlias("Spanish flashcard quiz", domainRows)` returns null — the alias list for `spanish_flashcards` contains `"flashcards"` (plural) but not `"flashcard"` (singular) or `"quiz"`.

When `domain = null`, step 1 (`serv_query PGC_Schema WHERE domain = null`) returns `[]`. The `analyze_and_design_workflow` LLM call receives `domain_schema: []` and invents tables that already exist (`PGD_Flashcards`, `PGD_FlashcardSets`, etc.). This sets `schema_changes[0].blocking = true` → `routing_flags.needs_schema = 1` → step 10b gate fires → user sees "tables don't exist" message that is incorrect.

**Confirm:** `generate_workflow_steps` was never reached in these runs. The issue is entirely in `analyze_and_design_workflow` receiving empty schema, not in step generation.

### Data fix (apply immediately to unblock)

Add `"flashcard"` and `"quiz"` to `PGC_DomainHelp.aliases` for `spanish_flashcards`:

```cmd
curl -s -X POST https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod/api/v1/serv/table/updateRows -H "Content-Type: application/json" -d "{\"tableName\":\"PGC_DomainHelp\",\"filters\":[{\"column\":\"domain\",\"op\":\"eq\",\"value\":\"spanish_flashcards\"}],\"updates\":{\"aliases\":[\"spanish_flashcards\",\"spanish flashcards\",\"spanishflashcard\",\"flashcards\",\"flashcard\",\"quiz\",\"flashcard quiz\",\"spanish quiz\"]}}"
```

### Why this is still wrong long-term

See Track 2. The alias list will keep failing for any phrasing not anticipated at domain-creation time. This is a structural problem with token matching, not a data maintenance problem.

---

## Track 2 — pgvector implementation (permanent fix)

Full spec is in `architecture.md` Section 10. Here is the implementation sequence.

### Step 1 — Enable pgvector on RDS

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Run this directly on the RDS instance. No Lambda deploy needed.

### Step 2 — Add embedding column to PGC_DomainHelp

```sql
ALTER TABLE "PGC_DomainHelp" ADD COLUMN embedding vector(1536);
```

Also update `PGC_Schema` jsonb for the `PGC_DomainHelp` table to include the new column — otherwise `serv_update` validation will reject writes to it.

```sql
UPDATE "PGC_Schema"
SET columns = columns || '[{"name":"embedding","type":"vector","nullable":true}]'::jsonb
WHERE table_name = 'PGC_DomainHelp';
```

### Step 3 — Add `vector` to ALLOWED_TYPES in schema.mjs

Request current `schema.mjs` from the repo. Add `'vector'` to the `ALLOWED_TYPES` set.

### Step 4 — Write embed-client.mjs

New file: `src/shared/embed-client.mjs`

```js
// src/shared/embed-client.mjs
// OpenAI text-embedding-3-small wrapper
// Credentials: SSM SecureString at OPENAI_API_KEY_PARAM env var
// Returns: float[] of 1536 dimensions

export async function embedText(text, traceId) {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-2' });
  const { Parameter } = await ssm.send(new GetParameterCommand({
    Name: process.env.OPENAI_API_KEY_PARAM,
    WithDecryption: true,
  }));
  const apiKey = Parameter.Value;

  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  if (!resp.ok) throw new Error(`OpenAI embeddings API error ${resp.status}`);
  const data = await resp.json();
  return data.data[0].embedding; // float[]
}
```

Add `OPENAI_API_KEY_PARAM` environment variable to the PROC Lambda in `template.yaml`. Store the actual key in SSM as a SecureString at the agreed parameter name.

### Step 5 — Write backfill-embeddings.mjs

New file: `dev_scripts/backfill-embeddings.mjs`

Reads all `PGC_DomainHelp` rows where `embedding IS NULL`, embeds `domain + " " + description + " " + aliases.join(" ")` for each, writes vector via SERV updateRows. Run once after Steps 1–4 are deployed.

### Step 6 — Update classify-intent-tiers.mjs

Replace `matchDomainAlias()` with a two-pass approach:

```js
// Pass A — zero-cost exact alias check (unchanged)
export function matchDomainAlias(userInput, domainRows) { ... }

// Pass B — semantic similarity (new)
export async function semanticDomainMatch(userInput, domainRows) {
  // Only called when matchDomainAlias returns null
  // domainRows already loaded — no extra DB query
  const populated = domainRows.filter(r => r.embedding);
  if (!populated.length) return null;

  const queryVec = await embedText(userInput);
  let best = null, bestSim = 0;
  for (const row of populated) {
    const sim = cosineSimilarity(queryVec, row.embedding);
    if (sim > bestSim) { bestSim = sim; best = row; }
  }
  const threshold = 0.75; // TODO: read from PGC_SystemContext.pgvector_config
  return bestSim >= threshold ? { domain: best.domain, confidence: 'semantic_match' } : null;
}

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; magA += a[i]*a[i]; magB += b[i]*b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
```

In `classify-intent.mjs`, update the `CREATE_WORKFLOW` domain resolution block (lines 483–491) and Pass 2 domain match (line 227) to call `semanticDomainMatch()` when `matchDomainAlias()` returns null.

### Step 7 — Update create_domain workflow

After the step that inserts the `PGC_DomainHelp` row, add an embedding step. The simplest approach given the current step types: add a new SERV endpoint `POST /serv/embed/domain-help` that takes `{ id }`, reads the row, embeds `domain + description + aliases.join(" ")`, and writes the vector back. Invoke via a `serv_query`-style step in the workflow.

Alternatively, if a `capability_call` step type exists by then, register the embed operation as a capability.

---

## Files needed at session start

Request these from the repo before writing any code:

- `architecture.md` (already updated this session — use session 25's version)
- `src/proc/classify-intent.mjs`
- `src/proc/classify-intent-tiers.mjs`
- `src/shared/embed-client.mjs` (will not exist — create new)
- `template.yaml` (to add OPENAI_API_KEY_PARAM env var)
- `src/serv/schema.mjs` (to add vector to ALLOWED_TYPES)
- `seed_PGC_Workflow.json` (current deployed version — for create_domain update)

---

## Session 24 completed items (do not redo)

- `run-workflow.mjs` — iterator suspending-gate resume fix, DIAGNOSE_PROMPT_SCHEMA dispatch, `SYSTEM_REPAIR_WORKFLOWS` guard
- `llm-client.mjs` — `parseInt(max_output_tokens)` fix
- `diagnose-prompt-schema.mjs` — new Tier 1b PROC module (thin launcher)
- `diagnose_prompt_schema` workflow — 16 steps with R1–R6 as independent `js_transform` rules; step 1 `input_key: "input.repair_state"` (critical — NOT `"repair_state"`)
- `handler.mjs` — DIAGNOSE_PROMPT_SCHEMA SQS case + HTTP route
- `seed_PGC_Prompt.json` — `analyze_and_design_workflow` v9 (R1–R6 clean, options items schema), `generate_workflow_steps` v4 (R1–R6 clean), `fix_workflow_steps` v2 (R1–R6 clean)
- `seed_PGC_Workflow.json` — `create_workflow` step 8 flags as `1/0`, step 9a message fixed; `diagnose_prompt_schema` workflow added
- `seed_PGC_SystemContext.json` — `output_schema_constraints` row added (R1–R6 docs injected into LLM prompts)
- `architecture.md` — Session 24 updates, Section 10 pgvector promoted to active

## Pending deploys (from session 24)

```cmd
sam build && sam deploy

node dev_scripts/upsert-workflow.mjs diagnose_prompt_schema
node dev_scripts/upsert-workflow.mjs create_workflow
node dev_scripts/upsert-prompt.mjs analyze_and_design_workflow
node dev_scripts/upsert-prompt.mjs generate_workflow_steps
node dev_scripts/upsert-prompt.mjs fix_workflow_steps
node dev_scripts/upsert-system-context.mjs output_schema_constraints
```

## Known open issues carried forward

| Issue | Status |
|---|---|
| `generate_workflow_steps` — not yet validated end-to-end (blocked by domain null) | Unblock via Track 1 alias patch, then re-run |
| `create_domain` step 6–12 — limited end-to-end run history | Still open |
| Session layer `PGC_Session` / `PGC_SessionEntry` | Backlog |
| `sub_workflow` and `capability_call` step types | Backlog |
| Guard 3 cycle detector backward reference handling | Medium priority |
| `serv_update` and `serv_delete` step types | Deferred |

## Git tag suggestion

`v3.2-session24-complete`
