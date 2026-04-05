# evolving-mind-ai — Unit Test Setup

## Overview

Unit tests target the intent classification pipeline (`classify-intent-tiers.mjs`) and the HTTP classify-intent endpoint. The tiers module is pure JavaScript with no I/O and is directly testable without network access. The HTTP endpoint tests require a running SERV API to read from PGC tables.

Tests are organised by use case group from `docs/user-intent-use-cases.md`. The first set covers UC 1.1–1.6 (domain CRUD workflows via generic `*_entity` routing).

---

## Tools

| Tool | Purpose |
|---|---|
| **Node.js 22 ESM** | Runtime — matches Lambda environment exactly |
| **node:test** | Built-in Node.js test runner — no additional dependencies |
| **node:assert** | Built-in assertion library |

No Jest, Mocha, or other test frameworks. `node:test` is available natively in Node 18+ and produces TAP-compatible output. This keeps the test suite dependency-free and consistent with the project's minimal-dependency philosophy.

---

## File layout

```
tests/
  unit/
    classify-intent-tiers.test.mjs   ← pure function tests (no network)
  integration/
    classify-intent.test.mjs         ← HTTP endpoint tests (requires SERV_API_URL)
  fixtures/
    intent-map-rows.js               ← mock PGC_IntentMap rows
    domain-help-rows.js              ← mock PGC_DomainHelp rows
    workflow-rows.js                 ← mock PGC_Workflow rows
  .env.test                          ← environment variables (not committed)
  .env.test.template                 ← template — committed to repo
```

---

## Environment variables

### `.env.test.template` (committed)

```properties
# evolving-mind-ai unit test environment
# Copy to .env.test and fill in values — do not commit .env.test

# Required for integration tests only (classify-intent HTTP endpoint)
# Not required for unit tests (classify-intent-tiers pure functions)
SERV_API_URL=https://<api-id>.execute-api.us-east-2.amazonaws.com/Prod

# Required for integration tests that call the classify-intent endpoint directly
# Set to the full proc API base URL
PROC_API_URL=https://<api-id>.execute-api.us-east-2.amazonaws.com/Prod

# Optional — set to skip integration tests when running without network access
# SKIP_INTEGRATION=true
```

### `.env.test` (not committed — add to `.gitignore`)

```properties
SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod
PROC_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod
```

### Loading env vars in tests (cmd.exe — avoids CRLF issues)

```cmd
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && set PROC_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node --test tests/unit/classify-intent-tiers.test.mjs
```

---

## Running tests

### Unit tests only (no network required)

```cmd
node --test tests/unit/classify-intent-tiers.test.mjs
```

### Integration tests (requires SERV_API_URL)

```cmd
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node --test tests/integration/classify-intent.test.mjs
```

### All tests

```cmd
node --test tests/unit/*.test.mjs
```

```cmd
set SERV_API_URL=https://enwwi5aulf.execute-api.us-east-2.amazonaws.com/Prod && node --test tests/**/*.test.mjs
```

### Verbose output

```cmd
node --test --test-reporter=spec tests/unit/classify-intent-tiers.test.mjs
```

---

## Git pre-commit hook

Create `.git/hooks/pre-commit` (Git Bash syntax):

```bash
#!/bin/bash
# Run unit tests before every commit — integration tests skipped (no network in hook)
echo "Running unit tests..."
node --test tests/unit/*.test.mjs
if [ $? -ne 0 ]; then
  echo "Unit tests failed — commit aborted."
  exit 1
fi
echo "Unit tests passed."
exit 0
```

Make executable (Git Bash):

```bash
chmod +x .git/hooks/pre-commit
```

**Note:** The pre-commit hook runs unit tests only. Integration tests require `SERV_API_URL` which is not available in the hook environment. Run integration tests manually before pushing to main.

### Sharing hooks with the team (when applicable)

Git hooks are not committed to the repo by default. To share, add hooks to a `scripts/hooks/` directory and document the setup step:

```bash
cp scripts/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

Or configure Git to use a shared hooks directory (Git 2.9+):

```bash
git config core.hooksPath scripts/hooks
```

---

## UC 1.x test fixtures

These are the verified curl results from the live system used as the basis for unit test assertions. The tiers module is tested against mock DB rows that reproduce the live state.

### Mock `PGC_IntentMap` rows (from live DB after create_domain recipes)

```js
// tests/fixtures/intent-map-rows.js
export const intentMapRows = [
  { id: 387, pattern: 'list.recipes|list recipes|list my recipes|show recipes|show my recipes', intent_category: 'list_entity',   action_type: 'workflow' },
  { id: 388, pattern: 'get.recipes|get recipes|get my recipes|show recipe|find recipes|find my recipes|search recipes',           intent_category: 'get_entity',    action_type: 'workflow' },
  { id: 389, pattern: 'add.recipes|add recipes|add my recipes|create recipe|new recipe',        intent_category: 'add_entity',    action_type: 'workflow' },
  { id: 390, pattern: 'update.recipes|update recipes|edit recipes|edit my recipes|modify recipe', intent_category: 'update_entity', action_type: 'workflow' },
  { id: 391, pattern: 'delete.recipes|delete recipes|remove recipes|remove my recipes',         intent_category: 'delete_entity', action_type: 'workflow' },
];
```

### Mock `PGC_DomainHelp` rows

```js
// tests/fixtures/domain-help-rows.js
export const domainHelpRows = [
  { domain: 'recipes', aliases: ['recipes', 'recipe', 'cooking', 'meal'], description: 'Manage your recipes with ingredients and step-by-step cooking instructions.' },
];
```

### Mock `PGC_Workflow` rows (generic workflows — domain: null)

```js
// tests/fixtures/workflow-rows.js
export const workflowRows = [
  { id: 310, name: 'get_entity',    domain: null, intent_keywords: ['get', 'show', 'find', 'fetch', 'look up', 'search'] },
  { id: 311, name: 'list_entity',   domain: null, intent_keywords: ['list', 'show all', 'get all', 'find all', 'all']    },
  { id: 312, name: 'add_entity',    domain: null, intent_keywords: ['add', 'create', 'new', 'insert']                    },
  { id: 313, name: 'update_entity', domain: null, intent_keywords: ['update', 'edit', 'modify', 'change']                },
  { id: 314, name: 'delete_entity', domain: null, intent_keywords: ['delete', 'remove']                                   },
];
```

---

## UC 1.x expected results (from verified curl runs)

| UC | Input | Expected `intent_category` | Expected `action_type` | Expected `confidence` | Expected `workflow_name` | Expected `domain` | Expected `search_term` | Expected `record_id` |
|---|---|---|---|---|---|---|---|---|
| 1.1 | `add recipe pasta carbonara with ingredients and steps` | `add_entity` | `workflow` | `exact` or `keyword_match` | `add_entity` | `recipes` | `null` | `null` |
| 1.2 | `list recipes` | `list_entity` | `workflow` | `exact` | `list_entity` | `recipes` | `null` | `null` |
| 1.3 | `get recipes sweet potato chili` | `get_entity` | `workflow` | `exact` | `get_entity` | `recipes` | `"sweet potato chili"` | `null` |
| 1.4 | `get recipes id=1` | `get_entity` | `workflow` | `exact` | `get_entity` | `recipes` | `null` | `1` |
| 1.5 | `update recipes id=42 difficulty=hard` | `update_entity` | `workflow` | `exact` | `update_entity` | `recipes` | `null` | `null` |
| 1.6 | `delete recipes id=42` | `delete_entity` | `workflow` | `exact` | `delete_entity` | `recipes` | `null` | `null` |

**Note:** UC 1.1 currently returns `action_type: crud` from Tier 2 — this is a known open issue (Pass 2 keyword scan excludes `domain: null` workflows). The expected result in the table above reflects the correct target behaviour after the fix is applied. The test for UC 1.1 should be written to the target, marked pending until the fix lands.

---

## Known open issues before writing tests

1. **UC 1.1 Pass 2 keyword scan gap** — `matchWorkflowByKeywords` filters by `r.domain === domain` which excludes generic workflows (`domain: null`). Fix: also include rows where `r.domain === null`. This must be fixed before UC 1.1 test can pass.

2. **UC 1.5 `record_id` not set** — update with `id=42` returns `record_id: null`. The id is parsed in `handoff()` separately from `extractSearchTerm`, so it does not appear in the classify-intent HTTP response. This is correct behaviour — `record_id` in the response is only set by `extractSearchTerm` for retrieval workflows. The test for UC 1.5 should assert `record_id: null`.
