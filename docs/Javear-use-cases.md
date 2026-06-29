# evolving-mind-ai — Javear Use Cases
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

Version: 1.1
Status: Active — Sprint 6 closed
Last updated: 2026-06-29

---

## How to read this document

Use cases are organised by domain, ordered easy to hard within each domain.
Each use case specifies the user-facing intent, the system behaviour, and the
capabilities required. A **Backlog** section at the end captures deferred items
that are architecturally understood but not scheduled for MVP delivery.

This document is a roadmap for development, not a sprint plan. It informs
session handoffs and architecture decisions. It does not drive individual
sessions directly.

**Input conventions used across all domains:**
- Natural language commands via `/m` (Slack)
- Bulk data upload via Excel → direct PostgreSQL insert (bypasses the workflow
  engine entirely — handled at the DB level before the brain is involved)
- Receipt data from Apple Photos → scraped text pasted into `/m` command

---

## Domain 1 — Recipes

*Complexity: Low. Core CRUD is already working. Gaps are workflow extensions.*

### UC-R1 Add a recipe in natural language
**Input:** `/m add recipe Pasta Carbonara with ingredients and cooking steps`
**Behaviour:** LLM parses natural language into structured recipe with
ingredients (name, quantity, unit) and steps (order, instruction). User reviews
parsed result in a confirmation gate before insert. Root row inserted into
`PGD_Recipes`, child rows into `PGD_RecipeIngredients` and `PGD_RecipeSteps`.
**Status:** ✅ Working (add_entity workflow)

### UC-R2 List all recipes
**Input:** `/m list recipes`
**Behaviour:** Returns a formatted list of recipe names with ids.
**Status:** ✅ Working (list_entity workflow)

### UC-R3 Get a recipe by name
**Input:** `/m get recipes pasta carbonara`
**Behaviour:** Returns the full recipe including ingredients and steps.
**Status:** ✅ Working (get_entity workflow, name LIKE search)

### UC-R4 Get a recipe by id
**Input:** `/m get recipes id=1`
**Behaviour:** Returns the full recipe for that id.
**Status:** ⬜ Requires UC 1.4 fix — get_entity currently posts an instructive
error for id-based lookup. get_entity step 1 needs an id vs name branch.

### UC-R5 Update a recipe field
**Input:** `/m update recipes id=3 servings=6`
**Behaviour:** Confirmation gate → updates the specified field on the root
recipe row. Child rows (ingredients, steps) are not affected.
**Status:** ✅ Working (update_entity workflow). Guard for missing field=value
pairs is a pending fix (tech debt).

### UC-R6 Delete a recipe
**Input:** `/m delete recipes id=3`
**Behaviour:** Confirmation gate → deletes the root recipe row. Child rows
deleted via ON DELETE CASCADE.
**Status:** ✅ Working (delete_entity workflow)

### Recipes Domain — Table Schemas

Created via `create_domain` in Sprint 6 (recreated with hardened prompts). Domain slug: `recipes`.

**`PGD_Ingredients`** — Shared ingredient lookup table (canonical names, deduplicated).
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | varchar NOT NULL | |
| name_embedding | vector(2560) | auto-embedded from `name` |

**`PGD_Recipes`** — Root recipe record.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| title | varchar NOT NULL | primary label column |
| title_embedding | vector(2560) | auto-embedded from `title` |
| description | text | |
| description_embedding | vector(2560) | auto-embedded from `description` |
| servings | integer | |
| prep_time_minutes | integer | |
| cook_time_minutes | integer | |
| category | varchar | e.g. "Italian", "Vegetarian" |
| difficulty_level | varchar | |
| source_url | text | |
| personal_notes | text | |

**`PGD_RecipeIngredients`** — Junction: recipe ↔ ingredient with quantity.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| recipe_id | integer FK → PGD_Recipes ON DELETE CASCADE | |
| ingredient_id | integer FK → PGD_Ingredients | |
| quantity | numeric | |
| unit | varchar | |
| preparation_note | varchar | e.g. "diced", "room temperature" |

**`PGD_RecipeSteps`** — Ordered cooking instructions.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| recipe_id | integer FK → PGD_Recipes ON DELETE CASCADE | |
| step_number | integer NOT NULL | ordering |
| instruction_text | text NOT NULL | |
| duration_minutes | integer | |

---

## Domain 2 — Pantry / Inventory

*Complexity: Low for CRUD. Medium for receipt parsing and unit conversion.*

### UC-P1 Add a pantry item manually
**Input:** `/m add pantry olive oil quantity=2 unit=bottle`
**Behaviour:** Inserts a pantry item with name, quantity, unit, and optional
category. LLM parses natural language description.
**Status:** ✅ Working once pantry domain is created (add_entity workflow)

### UC-P2 List pantry items
**Input:** `/m list pantry`
**Behaviour:** Returns all pantry items with current quantities and units.
**Status:** ✅ Working (list_entity workflow)

### UC-P3 Update a pantry item quantity
**Input:** `/m update pantry id=5 quantity=3`
**Behaviour:** Updates the quantity field on the pantry item.
**Status:** ✅ Working (update_entity workflow)

### UC-P4 Parse a grocery receipt and update pantry
**Input:** `/m receipt [pasted Apple Photos OCR text]`
**Behaviour:** Receipt text from Apple Photos is pasted into the `/m` command.
An `llm_call` step translates cryptic grocery store item names (e.g. "EVOO
32OZ") to pantry item names ("olive oil, 32 oz"). User reviews the parsed
mapping in a confirmation gate. Each matched pantry item is updated (quantity
incremented); unmatched items are created as new pantry rows. Unresolvable
items are flagged for manual review.
**Requires:** `create_workflow` working end-to-end to generate the receipt
parsing workflow. The translation step is an `llm_call` that receives the raw
receipt text and the current pantry item list (from `serv_entity_query`) and
returns a structured mapping.
**Status:** ⬜ Requires `create_workflow` test and delivery

### UC-P5 Subtract ingredients from pantry when making a recipe
**Input:** `/m made recipes id=3`
**Behaviour:** Reads the recipe ingredients for that recipe id. For each
ingredient, resolves the pantry item by name and performs unit conversion
(tablespoons → oz, slices → loaf fraction, etc.) to decrement the correct
quantity. Items that would go negative are flagged. User reviews the deduction
list in a confirmation gate before any writes.
**Requires:** Cross-domain read (recipes + pantry), unit conversion logic as
a `js_transform` built-in (or `llm_call` for ambiguous conversions), and a
multi-step workflow that the user creates via `create_workflow`.
**Status:** ⬜ Requires `js_transform` generic sandbox (acorn + vm) for unit
conversion, and cross-domain serv_entity_query capability.

---

## Domain 3 — Menu Planning and Shopping

*Complexity: Medium. Depends on Recipes and Pantry domains being operational.*

### UC-M1 Plan a weekly menu
**Input:** `/m plan menu for the week`
**Behaviour:** An `llm_call` step reads the available recipes from the recipe
domain and proposes a 7-day menu plan. The user reviews and can request
changes. The confirmed plan is stored in a `PGD_MenuPlan` table with date and
recipe id per day.
**Requires:** `create_workflow` to generate the menu planning workflow. The
`llm_call` step receives the recipe list and produces a structured plan.
**Status:** ⬜ Requires `create_workflow` test and delivery

### UC-M2 Generate a shopping list from a menu plan
**Input:** `/m shopping list for this week's menu`
**Behaviour:** Reads the weekly menu plan, aggregates all recipe ingredients,
compares against current pantry quantities (with unit conversion), and produces
a shopping list of items that need replenishment. List is formatted and posted
to Slack.
**Requires:** Cross-domain workflow (MenuPlan + Recipes + Pantry), unit
conversion, aggregation across multiple recipe ingredient lists.
**Status:** ⬜ Requires cross-domain step capability and `js_transform` sandbox

### UC-M3 Shopping list with frequency-based suggestions
**Input:** `/m shopping list` (without a specific menu plan)
**Behaviour:** Analyses pantry update history to identify items frequently
depleted (high replacement frequency). Suggests these items on the shopping
list even if current quantity is above zero. User can accept or dismiss
each suggestion.
**Requires:** Analytics on pantry history. Deferred to backlog — requires
`PGC_WorkflowStats`-style history or a dedicated update history table.
**Status:** ⬜ Backlog — see Deferred section

---

## Domain 4 — Expenses and Budget

*Complexity: Medium. CRUD is straightforward; reporting and receipt parsing are the gaps.*

### UC-E1 Add an expense manually
**Input:** `/m add expense Whole Foods groceries amount=87.50 category=groceries`
**Behaviour:** Inserts an expense record with merchant, category, amount, date,
and optional notes. LLM parses natural language; ref FK to `PGD_SpendingCategories`
resolved by name.
**Status:** ✅ Working (add_entity workflow, validated from Slack)

### UC-E2 List expenses for the current month
**Input:** `/m list expenses`
**Behaviour:** Returns all expense records for the current calendar month,
formatted with merchant, category, and amount.
**Status:** ✅ Working (list_entity workflow; entity resolution chain selects `Expense`
schema when multiple entity types exist in the domain)

### UC-E3 Parse a receipt and add expense
**Input:** `/m expense [pasted Apple Photos OCR text]`
**Behaviour:** Receipt OCR text pasted via `/m add expense`. `parse_entity_input`
applies spatial layout rules (separate item and price blocks, European number
format, summary-line stripping), extracts merchant name, total, date, and
category. Category ref FK resolved to `PGD_SpendingCategories` by name. User
reviews in a confirmation gate before insert into `PGD_Expenses`. No child
line-item table — `PGD_SpendingCategories` provides the budget classification layer.
**Status:** ✅ Working (add_entity workflow, pharmacy receipt validated from Slack)

### UC-E4 Run a budget report for the current month
**Input:** `/m budget report`
**Behaviour:** Reads all expenses for the current month, groups by category,
compares totals to budget limits in `PGD_Budgets`, and posts a formatted
report showing spend vs budget per category with a total.
**Requires:** `PGD_MonthlyExpensesByCategory` DB view (GROUP BY category_id,
SUM(amount) WHERE current month) registered in PGC_Schema + PGC_TableMap;
reporting workflow via `create_workflow`. LLM used for formatting only — all
arithmetic at DB level via the view.
**Status:** ⬜ Blocked on data — Sprint 7

---

### Expenses Domain — Table Schemas

Created via `create_domain` in Sprint 6. Domain slug: `budgets_expenses`.

**`PGD_SpendingCategories`** — Reference table; lookup for budget and expense categories.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| name | varchar NOT NULL | e.g. "Pharmacy", "Groceries", "Utilities" |
| description | text | |
| deleted_at | timestamptz | soft delete |

**`PGD_Expenses`** — Individual expense transactions.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| date | date NOT NULL | transaction date |
| title | varchar NOT NULL | merchant/description |
| title_embedding | vector(2560) | auto-embedded from `title` |
| amount | numeric NOT NULL | positive for spend |
| currency | varchar DEFAULT 'USD' | |
| category_id | integer FK → PGD_SpendingCategories | |
| payment_method | varchar | |
| description | text | |
| description_embedding | vector(2560) | auto-embedded from `description` |
| deleted_at | timestamptz | soft delete |

**`PGD_Budgets`** — Monthly budget allocations by category.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| year | integer NOT NULL | CHECK 2000–2100 |
| month | integer NOT NULL | CHECK 1–12 |
| category_id | integer FK → PGD_SpendingCategories | |
| planned_amount | numeric NOT NULL | |
| currency | varchar DEFAULT 'USD' | |
| type | varchar NOT NULL | CHECK IN ('income','discretionary','non_discretionary','savings') |
| notes | text | |
| notes_embedding | vector(2560) | auto-embedded from `notes` |
| deleted_at | timestamptz | soft delete |

**`PGD_RecurringExpenses`** — Templates for recurring expenses.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| title | varchar NOT NULL | |
| title_embedding | vector(2560) | auto-embedded from `title` |
| amount | numeric NOT NULL | |
| currency | varchar DEFAULT 'USD' | |
| category_id | integer FK → PGD_SpendingCategories | |
| payment_method | varchar | |
| frequency | varchar NOT NULL | e.g. "monthly", "annual" |
| next_due_date | date NOT NULL | |
| description | text | |
| description_embedding | vector(2560) | auto-embedded from `description` |
| deleted_at | timestamptz | soft delete |

---

## Domain 5 — Stock Portfolios

*Complexity: Medium for portfolio management. High for index comparison.*

**Data loading note:** Stock holdings data (ticker, shares, cost basis, sector,
industry, country) is bulk-loaded from Excel directly to PostgreSQL. The brain
does not own the initial data import. Excel functions handle current price
updates, sector and industry classification, and index composition data. The
brain owns natural language queries, comparisons, and reports against this
pre-loaded data.

### UC-S1 List portfolio holdings
**Input:** `/m list portfolio`
**Behaviour:** Returns all holdings with ticker, shares, sector, industry,
current value (from the Excel-updated price field), and gain/loss.
**Status:** ✅ Working once portfolio domain is created and data is loaded
(list_entity workflow)

### UC-S2 Get a specific holding
**Input:** `/m get portfolio AAPL`
**Behaviour:** Returns the full record for that ticker.
**Status:** ⬜ Requires UC 1.4 id lookup fix (or name-based get_entity
which works today if ticker is the name field)

### UC-S3 Update a holding
**Input:** `/m update portfolio id=12 shares=150`
**Behaviour:** Updates share count or other fields on a holding record.
**Status:** ✅ Working (update_entity workflow)

### UC-S4 View portfolio by sector
**Input:** `/m portfolio by sector`
**Behaviour:** Aggregates holdings by sector, showing total value and
percentage of portfolio per sector. Posted as a formatted Slack message.
**Requires:** A user-defined view workflow. This is the first instance of the
aggregate view pattern — a workflow that reads all holdings, groups by a
field, and computes percentages. Requires either `serv_aggregate` step type
or `js_transform` generic sandbox for the computation.
**Status:** ⬜ Requires aggregate view capability (see structural gap below)

### UC-S5 Compare portfolio sector weights to an index
**Input:** `/m compare portfolio to S&P 500 by sector`
**Behaviour:** Reads portfolio sector weights (UC-S4) and index sector weights
(stored in a separate `PGD_IndexComposition` table loaded from Excel).
Computes overweight/underweight per sector and posts a comparison report.
**Requires:** Cross-domain read (portfolio + index composition) and
aggregation. A `create_workflow`-generated comparison workflow.
**Status:** ⬜ Requires `create_workflow`, cross-domain reads, and aggregation

---

## Domain 6 — Language Learning

*Complexity: Low for data management. Medium for quiz workflow.*

### UC-L1 Add vocabulary items
**Input:** `/m add vocabulary hablar means to speak, verb, present: hablo hablas habla`
**Behaviour:** LLM parses the natural language description into a structured
vocabulary record with Spanish word, English translation, part of speech,
conjugation table (as a child table), and example sentences.
**Status:** ✅ Working once vocabulary domain is created (add_entity workflow)

### UC-L2 Bulk load vocabulary from Excel
**Behaviour:** Vocabulary data (word, translation, part of speech,
conjugations) loaded directly from Excel to PostgreSQL. Same pattern as
stock portfolio bulk load. No brain workflow involved in the initial import.
**Status:** ✅ Available (direct DB load, no system changes needed)

### UC-L3 List vocabulary by category
**Input:** `/m list vocabulary`
**Behaviour:** Returns vocabulary items, optionally filtered by part of speech
or topic.
**Status:** ✅ Working (list_entity workflow)

### UC-L4 Run a vocabulary quiz
**Input:** `/m quiz me on Spanish vocabulary`
**Behaviour:** A quiz workflow presents one word at a time via a Slack
`human_gate`. User responds with the translation. An `llm_call` step evaluates
the response (handling spelling variations and synonyms). Results are recorded.
The workflow loops through a configurable number of words (e.g. 10), then
posts a summary score.
**Requires:** `create_workflow` to generate the quiz workflow. The loop pattern
(present word → receive response → evaluate → next word) requires the
`iterator` step type or a `step:N` backward reference with a human gate as the
loop anchor (satisfying Guard 3's cycle-safety rule).
**Status:** ⬜ Requires `create_workflow` test and delivery. This is the
recommended first `create_workflow` test case — self-contained, no external
data, no cross-domain logic.

### UC-L5 Track quiz results over time
**Input:** Automatic — quiz workflow writes results to `PGD_QuizResults`
**Behaviour:** Each quiz session inserts a result record with date, words
tested, words correct, and score percentage. User can request a history report.
**Status:** ⬜ Requires quiz workflow (UC-L4) to exist first

### UC-L6 Adaptive quiz based on past performance
**Input:** `/m quiz me on words I struggle with`
**Behaviour:** Reads quiz history, identifies words with low correct-response
rate, and prioritises those in the next quiz session.
**Requires:** Analytics on quiz history + a `create_workflow`-generated
adaptive selection step.
**Status:** ⬜ Backlog — see Deferred section

---

## Domain 7 — Flashcards / Spaced Repetition

*Complexity: Medium. Core CRUD and quiz workflow working. SM-2 algorithm runs in `js_transform`.*

Used as the primary `create_workflow` test vehicle throughout Sprint 6. Domain slug: `flashcards`.

### UC-FL1 Add a flashcard
**Input:** `/m add flashcard front="What is the capital of France?" back="Paris" deck="Geography"`
**Behaviour:** LLM parses input; deck resolved by name (find-or-create); card inserted into
`PGD_Cards` with SM-2 initial values (`easiness_factor=2.5`, `interval=1`).
**Status:** ✅ Working (add_entity workflow)

### UC-FL2 Quiz flashcards (SM-2 spaced repetition)
**Input:** `/m quiz me on Spanish vocabulary`
**Behaviour:** `quiz_flashcards` workflow — presents due cards one at a time via Slack choice gates
(0=complete blackout → 5=perfect recall). SM-2 algorithm runs as `js_transform` to compute new
`easiness_factor` and `interval`. ReviewLog row inserted per card. Session ends with score summary.
**Status:** ✅ Working (quiz_flashcards workflow, SM-2 validated)

### UC-FL3 Study (browse) flashcards
**Input:** `/m study Spanish vocabulary`
**Behaviour:** `study_flashcards` workflow — presents cards one at a time for review without
grading. Useful for initial learning before spaced repetition begins.
**Status:** ✅ Working (study_flashcards workflow)

### Flashcard Domain — Table Schemas

**`PGD_Decks`** — Deck of flashcards; supports hierarchical parent/child decks.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| title | text NOT NULL | primary label column |
| title_embedding | vector(2560) | auto-embedded from `title` |
| description | text | |
| parent_id | integer FK → PGD_Decks (self-referential) | nullable; NULL = root deck |
| card_count | integer | denormalized count |
| learned_count | integer | cards with `interval > 0` |
| due_count | integer | cards where `next_review_date <= NOW()` |
| last_review_date | timestamptz | |

**`PGD_Cards`** — Individual flashcard with SM-2 SRS metadata.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| deck_id | integer FK → PGD_Decks ON DELETE CASCADE | |
| front | text NOT NULL | question side |
| front_embedding | vector(2560) | auto-embedded from `front` |
| back | text NOT NULL | answer side |
| back_embedding | vector(2560) | auto-embedded from `back` |
| front_image_path | text | |
| back_image_path | text | |
| front_audio_path | text | |
| back_audio_path | text | |
| interval | integer DEFAULT 1 | days until next review (SM-2) |
| easiness_factor | numeric(4,2) DEFAULT 2.5 | SM-2 EF; floor 1.3 |
| next_review_date | timestamptz | nullable; NULL = never reviewed |
| tags | text | comma-separated |
| category | text | |
| source | text | |

**`PGD_ReviewLog`** — Per-card review history; one row per quiz session per card.
| Column | Type | Notes |
|---|---|---|
| id | serial PK | |
| card_id | integer FK → PGD_Cards ON DELETE CASCADE | |
| review_date | timestamptz NOT NULL | |
| grade | integer NOT NULL | 0–5 (SM-2 scale) |
| time_spent_seconds | integer | |
| interval_before | integer | EF and interval before this review |
| easiness_factor_before | numeric(4,2) | |

---

## Structural capabilities required for MVP

These are not use cases — they are engineering capabilities that multiple use
cases depend on. They must be delivered in dependency order before the use
cases that require them.

| Capability | Required by | Notes |
|---|---|---|
| `create_workflow` end-to-end | UC-P4, UC-M1, UC-E3, UC-E4, UC-L4, UC-S4, UC-S5 | The highest-leverage item. UC-L4 is the recommended first test case |
| `js_transform` generic sandbox (acorn AST + vm) | UC-P5, UC-M2, UC-S4 | Required for unit conversion and aggregation logic. Deferring this means workflows that need computation must use `llm_call` as a workaround — those workflows will need to be rewritten when the sandbox lands |
| `serv_aggregate` step type | UC-E4, UC-S4, UC-S5 | GROUP BY + SUM at the DB level. Alternative to `llm_call` for arithmetic. Required for reliable budget and portfolio reports |
| Cross-domain `serv_entity_query` | UC-P5, UC-M2, UC-S5 | Reading from two entity schemas in one workflow. Requires either a new step variant or a workflow pattern that calls `serv_entity_query` twice with results merged by a `js_transform` step |
| User-defined aggregate views | UC-S4, UC-E4 | A workflow pattern (not a new step type) that reads a domain, groups by a field, and computes percentages. Enabled by `js_transform` sandbox |
| UC 1.4 id lookup fix in `get_entity` | UC-R4, UC-S2 | Small fix — get_entity step 1 branches on `input.id` vs `input.search` |
| `update_entity` missing fields guard | All mutation use cases | Small fix — post instructive error when `parsedId` set but `parsedUpdates` null |

---

## Backlog — Deferred items

These are understood architecturally but not scheduled for MVP delivery.

### Finnhub / live market data integration
`capability_call` step type + external API registry + SSM credential storage.
Required for live price feeds. Deferred because Excel handles price updates
for the MVP. See architecture Section 15.1 for the full design.

### Shopping list frequency-based suggestions (UC-M3)
Requires pantry update history analytics. Needs either a dedicated history
table on the pantry domain or a `PGC_WorkflowStats`-style audit trail at the
domain data level. Deferred until pantry CRUD and receipt parsing are proven.

### Adaptive vocabulary quiz (UC-L6)
Requires quiz result history analytics. Deferred until UC-L4 and UC-L5
are working and producing history data.

### Session layer — conversational memory
`PGC_Session` + `PGC_SessionEntry`. Enables short-form commands within a
Slack thread (e.g. "add carbonara" resolving to the recipes domain without
repeating the domain name). Phase 3. Does not block any MVP use case.

### Right-brain feedback loop
`PGC_WorkflowStats` view + `PGC_Prompt.error_log` analysis + prompt evolution.
Phase 3. The left brain must be stable before the right brain is useful.

### Alias management workflow
`/mind edit aliases for <domain>`. Currently aliases are updated directly
via SERV. Deferred until the core domain workflows are proven.

### `simulate` step type validation for user-generated workflows
Level 2 and Level 3 simulation is implemented but not proven end-to-end with
`create_workflow`. Will be exercised during `create_workflow` testing.

### Index comparison with live data (UC-S5 full version)
Full sector/industry/country comparison against live S&P 500 and Russell
index composition requires Finnhub or a similar data source. The Excel-based
MVP version (UC-S5) handles this with pre-loaded static data.
