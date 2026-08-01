# Step Type Reference
<!-- Copyright (c) 2026 Javea Guiri. All rights reserved. -->

> Part of the evolving-mind-ai architecture. Main doc: `docs/architecture.md`. See also: `docs/arch-step-processor.md` for execution engine internals, `docs/arch-intent.md` for classification, `docs/arch-workflow-patterns.md` for output validation and workflow creation.

### 6.5.1 Step types — the instruction set

Every step in a workflow is one instruction from this set. The Step Processor has
one handler per type. No workflow-specific code lives in the Step Processor.

#### Step definition schema

Every step follows this shape:

```json
{
  "step":             "1",
  "type":             "<step_type>",
  "description":      "Human-readable description for workflow authors and right-brain",
  "input":            {},
  "output_key":       "key_in_local_state",
  "on_success":       "next | end | step:3a",
  "on_else":       "cancel | step:<key>"
}
```

**Step keys are always strings.** `"1"`, `"3"`, `"3a"`, `"3b"`, `"3d"` are all
valid step keys. `on_success: "step:3a"` is a forward or backward jump. The Step
Processor resolves step keys by string equality — `parseInt` is never used.

#### Step type reference

```
╔══════════════╦══════════════════════════════════════════════════════╦══════════════════╗
║ Type         ║ What it does                                         ║ Status           ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ llm_call     ║ Load prompt from PGC_Prompt, call LLM, run           ║ ✅ Implemented   ║
║              ║ review-output validation (2-attempt correction loop) ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ js_transform ║ Run a named built-in transform on local_state data   ║ ✅ Implemented   ║
║              ║ (depricated), or evaluate a sandboxed JS expression  ║                  ║
║              ║ via acorn AST gate + vm.runInNewContext. Built-ins:  ║                  ║
║              ║ columnSummary,buildHelpOptions, resolveHelpContent,  ║                  ║
║              ║ formatRecordList, buildChildInserts.                 ║                  ║
║              ║ Generic expression field: Session 19.                ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ human_gate   ║ Suspend stack, present dialog to user, resume on     ║ ✅ Implemented   ║
║              ║ response. Gate types: confirm, list_selection,       ║                  ║
║              ║ text_input, review_object, choice, followup_prompt.  ║                  ║
║              ║ (select_one, select_many Backlog)                    ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_schema  ║ Create a PGD table via SERV createTable              ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_insert  ║ INSERT one row into a PGD table via SERV             ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_query   ║ SELECT rows from a PGD table via SERV                ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ LIST assembled entities via SERV-Entity listEntities ║ ✅ Implemented   ║
║ query        ║ — root columns + jsonb_agg child arrays. Use instead ║                  ║
║              ║ of serv_query for domains with child tables.         ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ FETCH one assembled entity by id via SERV-Entity     ║ ✅ Implemented   ║
║ get          ║ getEntity. Returns root columns + child arrays.      ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_update  ║ UPDATE rows in a PGD table via SERV                  ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_delete  ║ DELETE rows from a PGD table via SERV                ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_upsert  ║ INSERT or UPDATE rows in a PGD table via SERV —      ║ ✅ Sprint 7      ║
║              ║ matches on matchColumns, else inserts                ║                 ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ notify       ║ Resolve message_template from local_state, enqueue   ║ ✅ Implemented   ║
║              ║ HUMAN_NOTIFICATION to callback                          ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ iterator     ║ Loop over an array in local_state, execute item_step ║ ✅ Implemented   ║
║              ║ for each item sequentially                           ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ end          ║ Mark run completed, stop                             ║ ✅ Implemented   ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ serv_entity_ ║ Load full entity schema: reads PGC_EntitySchema for   ║ ✅ Implemented   ║
║ schema       ║ join topology + PGC_Schema for live column defs.     ║ Session 19       ║
║              ║ Collapses the serv_query + buildEntitySchema          ║                  ║
║              ║ two-step pattern into one step. See Section 6.5.1.    ║                  ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ sub_workflow ║ Push child workflow frame, inherit local_state        ║ ⬜ Backlog       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ condition    ║ Evaluate {{expression}} against local_state, route   ║ ✅ Implemented   ║
║              ║ to on_success / on_else step keys. No I/O.           ║ Session 19       ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ capability_call ║ Call a registered capability from PGC_Capability  ║ ⬜ Backlog       ║
╠══════════════╣══════════════════════════════════════════════════════╣══════════════════╣
║ simulate       ║ Dry-run a workflow step array against named         ║ ✅ live          ║
║               ║ execution paths using injected mock outputs.         ║ v3.2-create-    ║
║               ║ Static analysis, routing matrix, data-flow trace,    ║ workflow-       ║
║               ║ legacy path execution (informational). Sec 6.5.6.   ║ complete        ║
╠══════════════╬══════════════════════════════════════════════════════╬══════════════════╣
║ write_memory  ║ Persist a PGC_Memory row. Reads content string from  ║ ✅ Sprint 3      ║
║               ║ local_state[content_key]. Never fails the run —      ║                  ║
║               ║ errors logged only. See Section 6.13.                ║                  ║
╚══════════════╩══════════════════════════════════════════════════════╩══════════════════╝
```

#### Step-specific schema fields by type

##### **`llm_call`**
```json
{
  "step": "1", "type": "llm_call",
  "input": {
    "prompt":    "create_domain",
    "userInput": "{{input.userInput}}"
  },
  "output_key": "proposed_scaffold",
  "on_success": "next",
  "on_else": "cancel"
}
```
`input.prompt` is the `intent_category` key into `PGC_Prompt`. All other `input`
fields are available to the prompt template via `{{variable}}` substitution.
Output is the parsed JSON object from the LLM, stored at `output_key` in `local_state`.

**Right-brain hooks in `llm_call`.** Every `llm_call` step has two right-brain
mechanisms wired into it by the Step Processor — no workflow definition changes needed:

1. **Validation and correction loop** (Section 6.6): After the LLM responds, `review-output.mjs`
   runs Ajv + semantic validation. On failure, a correction prompt is sent automatically.
   If both attempts fail, the structured errors are written to `PGC_Prompt.error_log`.

2. **Truncation-aware resumption** (Section 6.6): If the response is cut off mid-JSON because
   `max_output_tokens` was reached (`output_tokens === ceiling`), a resumption prompt
   regenerates from scratch at double the token budget, rather than sending the broken
   partial output to the correction loop. If resumption also fails, `token_truncation` is
   logged to `PGC_Prompt.error_log`.

3. **Prompt quality monitor** (Section 6.6): After any 2-attempt failure is written to
   `error_log`, `monitor-prompt-quality.mjs` fires asynchronously. It classifies the
   failure pattern and, for `token_truncation` with 2+ consecutive occurrences, inserts
   a new `PGC_Prompt` version with a raised ceiling automatically. No human intervention
   required. Schema errors are logged as advisory for the Phase 3 right-brain loop.

4. **Memory write** (Section 6.13): When `save_to_memory` is set on the step definition,
   `llm-harness.mjs` appends a `reasoning` instruction to the prompt, extracts and strips
   the `reasoning` field from the LLM output before schema validation, and writes it to
   `PGC_Memory`. Zero additional LLM calls — the reasoning content is part of the existing
   call. `save_to_memory` fields: `memory_type`, `scope` (supports `{{template}}` tokens),
   `tags`, `priority`.

5. **Memory retrieval** (Section 6.13): When `PGC_Prompt.memory_config.memory_budget_tokens > 0`,
   `llm-harness.mjs` calls `memory-client.mjs` to retrieve scope-matching `PGC_Memory` rows
   within the token budget, then appends the formatted memory block to the system instructions.

##### `js_transform`

Every `js_transform` step requires an `expression` field — a pure synchronous JavaScript
value expression executed in a sandboxed `vm.runInNewContext` context. Two bindings are
available in the sandbox:

- **`items`** — the resolved value of `input_key` from `local_state`
- **`local_state`** — the full local_state object, enabling cross-key reads

The `expression` must evaluate to a value (no `return` keyword, no semicolons at top level).
Wrap multi-statement logic in an IIFE: `(function() { ... })()`

```json
{
  "step": "2", "type": "js_transform",
  "description": "Enrich table list with columnSummary and domain field.",
  "input_key": "proposed_scaffold.tables",
  "output_key": "proposed_scaffold.tables",
  "expression": "(function() { var SYS = new Set(['id','created_at','updated_at']); function enrich(tables, domain) { return tables.map(function(t) { if (!t.columns) return t; var cols = t.columns.filter(function(c){ return !SYS.has(c.name); }).slice(0,4).map(function(c){ return c.name; }); return Object.assign({}, t, { columnSummary: cols.join(', '), domain: domain }); }); } return enrich(items, local_state.proposed_scaffold.domain); })()",
  "on_success": "next",
  "on_else": "cancel"
}
```

Reading cross-key values via `local_state` — used when the primary input is insufficient:

```json
{
  "step": "3c", "type": "js_transform",
  "input_key": "proposed_scaffold.tables",
  "output_key": "proposed_scaffold.tables",
  "expression": "(function() { var newTable = local_state.new_table; var merged = newTable ? items.concat([newTable]) : items; return merged; })()"
}
```

**Sandbox constraints:** pure synchronous transforms only — no `require`, no `import`, no
async, no network, no filesystem. Timeout: 200ms. Safe globals available: `JSON`, `Math`,
`Array`, `Object`, `String`, `Number`, `Boolean`, `Date`.

**`transform_type` built-ins removed (Session 20).** All five named built-ins
(`columnSummary`, `buildHelpOptions`, `resolveHelpContent`, `formatRecordList`,
`buildChildInserts`) have been replaced by self-contained `expression` steps in the seed
workflows. Any step using `transform_type` now throws a hard error at runtime — no silent
fallback.

The constraint boundary: `js_transform` is restricted to **pure synchronous data transformation** —
##### `human_gate`
```json
{
  "step": "3", "type": "human_gate",
  "gate_type":        "confirm",
  "message_template": "Here's my plan for domain {{proposed_scaffold.domain}}.",
  "options": [
    { "label": "Looks good", "action": "confirm", "on_select": "step:3d" },
    { "label": "Cancel",     "action": "cancel",  "on_select": "cancel"  }
  ],
  "on_success": "next",
  "on_else": "cancel"
}
```
###### Context key 
`context_key` is a dot-path into `local_state` — the data bound to the dialog.
`options[].on_select` drives routing after the gate resolves — `"step:3d"` is a
jump; `"next"` advances to the sequentially next step; `"cancel"` cancels the run.

###### `action_key` — recording *which* option was chosen

`output_key` records the gate's **payload**: the typed text, the selected value, the
clicked row, or — on a `form` — the field values. It does **not** record which button
was pressed. `on_select` routes on the click and then discards it.

`action_key` is the local_state key that captures the click itself (an option's `value`
on `choice` gates, its `action` on all others). Set it when a **later** step must know
the gate's outcome.

The case that requires it is a **save-and-continue loop**: *"Save persists and re-shows
the form; Done persists and exits."* Both buttons run the **same** write and diverge only
*after* it, so the decision has to survive the write and be read by a `condition`
downstream. There is no workaround — routing the two buttons to separate chains
duplicates the write, and making Done skip the write loses the user's edits.

When `action_key` is set, **every option must carry a distinct `action`** (`"save"`,
`"done"`, `"cancel"`). Two buttons both using the conventional `"confirm"` are
indistinguishable to everything downstream. `action_key` is independent of `output_key`:
a `form` gate uses both.

```json
{
  "step": "10", "type": "human_gate", "gate_type": "form",
  "fields": "{{budget_fields}}",
  "output_key": "budget_edits",
  "action_key": "edit_action",
  "options": [
    { "label": "Save", "action": "save", "on_select": "step:11" },
    { "label": "Done", "action": "done", "on_select": "step:11" },
    { "label": "Cancel", "action": "cancel", "on_select": "cancel" }
  ],
  "on_cancel": "cancel", "on_success": "step:11"
}
```

L1 counts `action_key` as a **write** in the state-flow trace, so a downstream
`{{edit_action}}` resolves. Without that it would be rejected as never written — which is
exactly how run 719 failed before this existed.

###### `option_source` — where the option set came from

`authored | derived`. A statement about the set, not about the widget that draws it.

An **authored** set was written at design time: its length is a property of the design,
and the simultaneous visibility of every value *is* the interaction — a fixed rating scale
is one click to answer and three interactions once it is a dropdown. A **derived** set is
built from runtime data and may hold three entries or three hundred, so collapsing it into
one control past a handful is a fair trade.

`buildDialog` resolves this onto every dialog it emits, so the experience layer always has
it. Absent an explicit declaration it is read off the step, where the fact is already
stated: `options` given as a `{{template}}` reference, or an option carrying `iterator`,
are derived by definition of where their entries come from. Declare it only to override
that reading.

The renderer applies its own mechanics and its own limits to the answer — *derived and
numerous collapses; authored stays inline until Slack's cap on one actions block forces
it* — and a workflow can raise neither bound. This is the `form` rule below applied one
level up: a field's `type` names what is collected, an option set's `option_source` names
where it came from, and neither names a widget.

###### `form` gate_type

Collects any number of typed values in **one** gate and writes them to `output_key`
as a single object keyed by field name.

**This is the gate type that stops gate types multiplying.** A widget is a *field
type*, not a gate type — so `select_one`, `select_many`, `date_input`,
`number_input` and every future picker are `fields[].type` values, not new entries
in the `gate_type` enum. Adding a widget means adding one row to
`buildInputElement()` in `callback.mjs`. It never means touching the procedure layer.

A field's `type` states **what is being collected**, never which widget draws it:

| `type` | Collects | Slack element (chosen by `/ui/slack`) | Limit |
|---|---|---|---|
| `text` / `textarea` | A string | `plain_text_input` | — |
| `select` | One value | `static_select` | 100 options |
| `multi_select` | An **array** | `multi_static_select` | 100 options |
| `radio` | One value | `radio_buttons` | 10 options |
| `checkbox` | An **array** | `checkboxes` | 10 options |
| `date` | `"YYYY-MM-DD"` | `datepicker` | — |
| `time` | `"HH:mm"` | `timepicker` | — |
| `datetime` | Epoch seconds | `datetimepicker` | — |

`number`, `email`, `url` and `file` are deliberately absent — Slack supports those
elements only in modals. Collect `text` and validate in a `js_transform`.

`default` pre-fills a field, so a user amends an existing record rather than retyping
it (`"YYYY-MM-DD"` for `date`; the option's `value` for `select`/`radio`). It is named
`default` — the standard term in JSON Schema and HTML forms — because that is what an
LLM emits unprompted; run 695 was rejected for using it against a schema that had
invented `initial` instead. The dialog still carries it to Slack as `initial`, which is
Slack's own name for the same thing.

**Data-driven field lists.** `fields` may be a `{{state_key}}` reference to an array a
preceding `js_transform` built, exactly as `options` and `reveals` may be. That is how a
form carries **one field per data row** — an amount box and a type dropdown for *each*
budget category, each pre-filled via `default` — which a fixed field list cannot express.
The transform must be a real step in `process_design`: it cannot be introduced at
translation time, because the routing skeleton is already locked by then.

Size is a real constraint: every field is one Slack input block and a message holds at
most 50. For a long or unbounded row list, use `list_selection` to pick one row and then
a small form to edit it, rather than one giant form over every row.

Options for `select`/`multi_select`/`radio`/`checkbox` come from either `options`
(a fixed list) or **`options_key`** (a dot-path into `local_state`), the latter
letting a dropdown offer rows the workflow has already queried:

```json
{
  "step": "1", "type": "human_gate",
  "gate_type":        "form",
  "message_template": "Which month do you want to edit?",
  "fields": [
    { "name": "period",      "type": "date",   "label": "Budget month" },
    { "name": "category_id", "type": "select", "label": "Category",
      "options_key": "categories", "option_value_key": "id", "option_label_key": "name" },
    { "name": "notes",       "type": "textarea", "label": "Notes", "optional": true }
  ],
  "output_key": "budget_target",
  "options": [
    { "label": "Submit", "action": "confirm", "on_select": "next"   },
    { "label": "Cancel", "action": "cancel",  "on_select": "cancel" }
  ],
  "on_success": "next",
  "on_else": "cancel"
}
```

→ `local_state.budget_target = { period: "2026-07-01", category_id: "3", notes: null }`

**The rule this exists to enforce:** never collect a date, or a value from an
enumerable set, as free text and then add an `llm_call` to parse it. A picker is
deterministic; parsing prose costs a model call and can misread the user. `text_input`
is for genuinely open-ended prose only.

**Required fields are enforced on resume, not by Slack.** Slack honours a field's
`optional` flag only on *modal* submit — a message's Submit button performs no
validation. `resumeGate` re-checks required fields and re-renders the gate with a
"Please complete: …" line rather than advancing with a hole in the data. An
unanswered optional field arrives as `null`, never missing, so a workflow always
sees every field it asked for.

###### `list_selection` gate_type

Renders all `context_key` items as a single Slack `markdown` table (`ID` plus
one column per distinct field key across every item), plus one shared
selection control and one Select button (labeled/styled from `item_action`)
below it — one block for the whole list regardless of row count, no per-row
block cost. The selection control is a `static_select` dropdown of every
selectable row, grouped into one `option_group` per source table when a level
spans more than one; past Slack's 100-option cap it falls back to a plain
id text box. The table itself is uncapped under either control. **This gate_type is only concerned with rendering.** What
selecting a row *does* is entirely the calling workflow's concern, expressed
through `item_action`'s own config — never a different gate_type for a
different action semantic (Sprint 7 Track D2: this merges what were briefly
two separate gate types, `edit_list`/`row_list`, back into one — rendering
the same thing two ways for two action semantics was exactly the one-off
duplication this project avoids elsewhere).

`context_key` items must arrive **pre-formatted** as `{ id, fields?,
secondaryAction?, responseData? }` — `fields` is a plain object of column
name -> value (the record's own cleaned fields, passed through as-is; no
forced Name/Title synthesis) rendered as one table column per distinct key
across every item. Column headers are formatted purely from the key itself —
no workflow-level naming is needed: snake_case is title-cased (`ease_factor`
-> `Ease Factor`), and a key ending in `_id` whose values are no longer
numeric (the workflow already resolved that FK to its label, keeping the
original column name — this is `callback.mjs`'s call to make, not the
workflow's) drops the suffix and reads as `<Prefix> Name` (`deck_id` ->
`Deck Name`). An `_id` column still holding raw numeric ids is left as a
plain title-cased `Deck Id`. Building the `fields` shape itself is a
workflow-level (`js_transform`)
concern. An item may carry its own fully custom `secondaryAction` (e.g.
omitted for a referenced parent table that can't be removed) that overrides
`step.item_action` entirely for that one row.

**`responseData` (optional, per item)** — lets a row carry a structured
payload beyond the bare id (e.g. `{ table: 'PGD_SomeTable', id: 7, hasChildren: true }`)
through to `output_key` on click. When an item omits it, `callback.mjs` falls
back to the legacy `{ tableName: item.id }` shape every existing consumer
expects — this is additive, not a breaking change to older workflows. See
`list_entity`'s recursive navigation loop (`docs/arch-workflow-patterns.md`
§6.17) for the pattern this exists to support: a row needs to say which table
it belongs to and whether it can be drilled into further, not just its id.

**Behavior is driven by `item_action`, never by gate_type.** Selecting a row writes
that row to `output_key` and routes via `item_action.on_select` — what selecting
*means* is expressed through where `on_select` points, never through a different
gate_type for a different action semantic.

`item_action.confirm_template` (per-item confirm text, resolved against
`{...localState, item}`) is still computed by `buildDialog` but has no
current renderer — the single shared Select button has no specific row bound
to it until after submission, so there's no click surface left to attach a
native Slack confirm popup to. Not currently used by any live workflow.
`item_action.label` defaults to `"Select"`; `.style` has no default (Slack rejects
`style: "default"`, and only `danger`/`primary` are forwarded).

*Advance* (`item_action.on_select` set) — writes the selected row to `output_key`,
pops the gate frame, routes elsewhere (e.g. drill-down into a back-edge step that
fetches and displays that one record):

```json
{
  "step": "9c", "type": "human_gate",
  "gate_type":        "list_selection",
  "message_template": "Found {{entity_display_data.entities.length}} record(s). Click View for details on one, or Done to finish.",
  "context_key":      "row_items",
  "item_action":       { "action": "view_record", "label": "View", "style": "default", "on_select": "step:20" },
  "output_key":       "selected_record_id",
  "options": [
    { "label": "Done", "action": "cancel", "on_select": "cancel" }
  ],
  "on_success": "next",
  "on_else":    "cancel",
  "on_cancel":  "cancel"
}
```

**`item_action.on_select` is resolved directly — never via a matching `options[]`
entry.** Every `options[]` entry also renders as its own real, visible bottom
button; since every row shares the same `item_action.action` (e.g. `view_record`),
putting it in `options[]` too would render a redundant duplicate Select button.
`options[]` should only ever list buttons meant to be genuinely visible at the
bottom (here, just "Done"). Note `style: "default"` is set explicitly here —
the shared default is `"danger"` (matching the remove-item case above), which
would render the Select button as a destructive-looking red button if left
unset. Slack itself has no `"default"` style value; the harness omits the
field entirely rather than sending the literal string.

**Identifying the selected row:** the table has no per-row click target — the
user picks a row in the shared selection control and clicks Select.
`callback.mjs` sends only `{ workflowRunId, action }` on the button itself; the
row identity rides in Slack's `state.values` (harvested by `interactive.mjs`).
From the dropdown that is `responseData.selectedValue`, a JSON `{id, table}`
payload built from the chosen option — the source table travels with the id, so
a level spanning more than one child table cannot resolve an id that collides
across both to the wrong table's row. On the text-box fallback it is
`responseData.inputValue`, a bare id with no table, where a collision still
resolves first-hit.

`run-workflow.mjs`'s `resumeGate` resolves either form against `context_key`'s
fully-resolved items (via `buildDialog`, so the id-to-row mapping is computed in
exactly one place) before writing to `output_key` and routing via
`item_action.on_select`. A selection that doesn't match a selectable row
re-renders the same gate in place with an error line — the gate never advances
on an unresolved value. When the matched row never set its own `responseData`,
the legacy bare scalar (`responseData.tableName`) is written, matching every
pre-existing consumer.
When the row set a `responseData` object without a `tableName` key (the
recursive drill-down case above), the whole object is written through instead
— see `list_entity`'s navigation loop in `docs/arch-workflow-patterns.md`
§6.17 for the live example (a shared loop entry step reads
`{{selected_row.table}}`/`{{selected_row.id}}`/`{{selected_row.hasChildren}}`
off exactly this payload).

###### `reveal` / `reveals` (optional, all gate types)

Renders one or more collapsible `container` blocks above the gate buttons. Panels are
always visible (collapsed by default) — no click required to know they exist, only
to expand them. The gate remains suspended; panels are read-only.

**`reveal`** — single panel (object):

```json
"reveal": {
  "button_label": "Show Definition",
  "content": "{{some.template}}"
}
```

**`reveals`** — data-driven panels (string template, plural):

```json
"reveals": "{{parent_reveals}}"
```

`reveals` resolves to an array of `{ button_label, content }` objects at runtime —
one `container` panel per array entry. Use `reveals` when the number of panels is
driven by data.

**`content` rendering** — resolved via `resolveInput` before the HUMAN_GATE SQS
message is built:

| Resolved type | Rendered as |
|---|---|
| string | the container's `section`/`mrkdwn` child block text, directly |
| array of strings | the same child block text, one `• ` bullet per line |

`button_label` becomes the container's `title`. Both fields are required and must be
non-empty — L1 validation rejects steps where either is missing. `callback.mjs`
renders each panel with `randomUUID()` in `block_id`, `is_collapsible: true`,
`default_collapsed: true`, posted directly in the gate message. See
`docs/slack-block-kit.md`'s `container` reference for the full field/limit details.

**Example — accordion hierarchy** (parent categories with bulleted child items):

```json
{
  "step_type": "human_gate",
  "gate_type": "choice",
  "message_template": "Select an item:",
  "reveals": "{{parent_reveals}}",
  "options": "{{leaf_options}}",
  "output_key": "selected_id"
}
```

`parent_reveals` in `local_state`:
```json
[
  { "button_label": "Category A", "content": ["Item A1 - 2026-01-15", "Item A2 - 2026-03-10"] },
  { "button_label": "Category B", "content": ["Item B1 - 2026-04-01"] }
]
```

Each panel expands to show its children as a bulleted list. The selectable leaf
nodes are always in `options` — never inside `reveal` content.

###### `iterator` on options (choice gate only)

Any option in a `choice` gate may carry `iterator: '<local_state_key>'`. At runtime
`buildDialog` expands that option into **one button per item** in
`localState[iterator]`, resolving `label`, `value`, and `description` tokens against
`{...localState, ...item}` for each element. Only one option object per gate should
carry `iterator`. A Cancel option without `iterator` must always appear as a separate
entry. The `iterator` field is stripped from the rendered buttons.

```json
{
  "step": "3", "type": "human_gate", "gate_type": "choice",
  "message_template": "Select a deck to quiz:\n{{decks_list}}",
  "output_key": "selected_deck_id",
  "options": [
    { "value": "{{id}}", "label": "{{name}}", "description": "{{card_count}} cards",
      "on_select": "next", "iterator": "decks" },
    { "value": "cancel", "label": "Cancel", "description": "Stop", "on_select": "cancel" }
  ],
  "on_success": "next", "on_else": "cancel"
}
```

Use `iterator` instead of a preceding `js_transform` step when gate options come
from a variable-length array. L1 validation skips the unresolved-key check for
options that carry `iterator` (tokens resolve at runtime against each item).

###### Template syntax

Templates appear in `message_template`, `input` values, and `context_key`. The
template resolver (`template-resolver.mjs`) supports:

```
{{key}}              → local_state["key"]
{{key.field}}        → local_state["key"]["field"]
{{key.0.field}}      → local_state["key"][0]["field"]
{{item}}             → current iterator item (inside item_step only)
{{item.field}}       → field on current iterator item
{{input.field}}      → run.input["field"] — original input to the workflow
```

Unresolved templates (key not found in local_state) resolve to the empty string
`""` — they do not throw. This means a workflow author must ensure that every
template reference has a corresponding `output_key` written by a prior step.

##### `iterator`
```json
{
  "step": "5", "type": "iterator",
  "items_key":      "proposed_scaffold.tables",
  "item_step":      { "type": "serv_schema", "input": { "table": "{{item}}" } },
  "output_key":     "created_tables",
  "execution_mode": "sequential",
  "on_complete":    "next"
}
```
`items_key` is a dot-path to an array in `local_state`. `item_step` is executed
once per item — the current item is available as `{{item}}` and `{{item.field}}`
inside `item_step.input`. Results are collected into an array at `output_key`.
`execution_mode: "sequential"` is **always required** — omitting it is a workflow defect.

#### Iterator taxonomy — non-suspending vs suspending

Two categories of iterator exist based on whether the `item_step` suspends execution.

**Non-suspending iterator** — `item_step` is a service step (`serv_schema`, `serv_insert`,
`serv_update`, `serv_delete`, `serv_query`, `llm_call`, `js_transform`). All items execute
inline within a single Lambda invocation in `executeIteratorInline`. No SQS hop per item.
This is the common case — `create_domain` step 5 (DDL), step 9, step 10b are all
non-suspending iterators.

**Suspending iterator** — `item_step` is `human_gate`. Each item requires one full
suspend/resume cycle: the iterator breaks after building the gate, a gate frame is pushed,
the run suspends. When the user responds, `resume_gate` pops the gate frame and the iterator
frame becomes the top frame. `resumeGate` detects `parentFrame.type === 'iterator'` and:
1. Strips the `item` binding from `localState` before merging state back onto the iterator frame
   (prevents `item` from leaking into the frame-level state).
2. Increments `parentFrame.current_index` — advancing to the next item.
3. Does **not** set `current_step` — iterator frames use `current_index`, not `current_step`.

The next `execute_top` re-enters `executeIteratorInline` at the incremented index.

`step_ref.options` is resolved from the template string (e.g. `"{{item.options}}"`) to a live
array before the gate frame is persisted — required because `resume_gate` calls
`options.find()` to match the user's response value.

**When to use a suspending iterator vs the flat loop pattern:**

| | Suspending iterator | Flat loop (backward step reference) |
|---|---|---|
| Use when | Fixed list of independent questions, each needing one answer | Loop with inter-item state (score, accumulated data, conditional branching per item) |
| Output | Results array at `output_key` | State accumulated in `local_state` via `js_transform` |
| Loop control | Iterator exhausts automatically | Explicit index + condition step |
| Guard 3 safety | N/A — no backward reference | Requires `human_gate` on every loop path |

Prefer the flat loop pattern when each iteration needs to read results from previous
iterations, or when loop termination depends on accumulated state. See `create_domain_example`
in `PGC_SystemContext` for a complete flat loop example (Spanish vocabulary quiz).

##### `serv_query` / `serv_insert` / `serv_update` / `serv_delete`**
```json
{
  "step": "1", "type": "serv_query",
  "input": {
    "tableName": "PGD_Recipes",
    "filters":   [{ "column": "id", "op": "eq", "value": "{{input.id}}" }]
  },
  "output_key": "results",
  "on_success": "next",
  "on_else": "cancel"
}
```

##### `serv_upsert`
```json
{
  "step": "1", "type": "serv_upsert",
  "input": {
    "tableName":    "PGD_Budgets",
    "matchColumns": ["year", "month", "category_id"],
    "rows":         "{{budget_records_with_ids}}"
  },
  "output_key": "upsert_result",
  "on_success": "next",
  "on_else": "cancel"
}
```
For each row in `rows`, updates the existing row if one matches all `matchColumns`
values, otherwise inserts a new row. `matchColumns` is always a flat array of
column name strings — never per-row filter objects. Replaces the
query-existing-rows + diff-into-insert/update-lists pattern (a `serv_query` with
`filters` built from a preceding `js_transform`, then a `condition`/iterator
choosing `serv_insert` vs `serv_update` per record) for the common case of
importing or syncing a batch of records that may already exist.
`output_key` receives `{ tableName, inserted: [...], updated: [...] }`.

Workaround upsert, not a native `INSERT ... ON CONFLICT` — no table currently
declares a compound unique constraint on `matchColumns` (Sprint 8 backlog item
adds constraint inference to `design_table`/`create_domain` and upgrades
`serv_upsert` to use `ON CONFLICT` where a constraint exists). Matching today is
query-then-write: SERV selects the first row satisfying `matchColumns` and
inserts or updates accordingly, inside one transaction per call.

##### `serv_entity_query` / `serv_entity_get`
```json
{
  "step": "1", "type": "serv_entity_query",
  "input": {
    "entityName": "Recipe",
    "filters":    [{ "column": "name", "op": "like", "value": "{{input.search}}" }],
    # orderBy removed — hardcoded "name" column is domain-specific assumption
    "limit":      20
  },
  "output_key": "results",
  "on_success": "next",
  "on_else": "cancel"
}
```
`entityName` is the PascalCase singular name from `PGC_EntitySchema.entity_name` — e.g. `Recipe`, not `Recipes`.
Returns assembled entities with root columns plus child arrays (`ingredients`, `steps`, etc.).
Use instead of `serv_query` for domains with child tables or when full entity display is needed.

`serv_entity_get` fetches a single entity by id:
```json
{
  "step": "1", "type": "serv_entity_get",
  "input": { "entityName": "Recipe", "id": "{{input.id}}" },
  "output_key": "result",
  "on_success": "next",
  "on_else": "cancel"
}
```

##### `notify`
```json
{
  "step": "11", "type": "notify",
  "message_template": "Domain {{proposed_scaffold.domain}} created. Try: {{generated.domainHelp.commands.0.syntax}}",
  "notify_type": "HUMAN_NOTIFICATION",
  "on_success": "next"
}
```

**`reveal` / `reveals` (optional, Sprint 7 Track D2)** — same shape and resolution as `human_gate`'s (see §"`reveal` / `reveals`" below): `reveal` is a single `{ button_label, content }` object; `reveals` is an inline array or a `{{template}}` reference to a `local_state` array of the same shape. Rendered by `postHumanNotification` via the shared `buildRevealBlock()` helper, appended after the message content.

```json
{
  "step": "13", "type": "notify",
  "message_template": "{{formatted_display.formatted_markdown}}",
  "reveals": "{{formatted_display.reveals}}",
  "on_success": "end"
}
```

`message_template` supports standard markdown headings (`#`–`######`) — `markdownToBlocks()` (`callback.mjs`) splits heading lines into real Slack `header` blocks with genuine H1–H4 visual sizing (a different mechanism from a `markdown` block's own inline `#` syntax, which renders all levels at one size — see `docs/slack-block-kit.md`).

##### `end`
```json
{ "step": "12", "type": "end" }
```

##### `simulate`
```json
{
  "step":        "4",
  "type":        "simulate",
  "input": {
    "steps_key":        "draft_workflow.steps",
    "mock_outputs_key": "mock_outputs",
    "paths_key":        "simulation_paths"
  },
  "output_key":  "simulation_result",
  "on_success":  "next",
  "on_else":  "step:3"
}
```
All three `input` fields are dot-paths into `local_state`. `mock_outputs_key`
and `paths_key` are optional — Level 1 (static analysis), Level 2a (routing
matrix), and Level 2b (data-flow trace) always run once L1 passes; only Level
2c (legacy path execution, informational-only) is skipped when they are absent.
`on_else` routes back to the step where the user can review and correct the
workflow definition before re-simulating.
Validation levels and result structure: see `docs/arch-simulation-engine.md`.
Step definition schema and the `simulation_mode` execution flag: see
`docs/arch-step-processor.md` Section 6.5.6.

##### Post-write L1 validation

`create_workflow` and `fix_workflow` run `runLevel1StaticAnalysis` on the generated
steps array **before** calling SERV to persist the workflow. If issues are found the
write is blocked and a `422` response is returned with the structured issue list.
`upsert-workflow.mjs` surfaces L1 errors clearly in terminal output. This prevents
dead-routing or structurally invalid workflows from entering `PGC_Workflow` at all.

The check is performed in PROC (not SERV) because `runLevel1StaticAnalysis` lives in
`simulation-engine.mjs` which is a PROC-tier module — SERV has no access to it.

**Skeleton vs full L1:** `serv_step_missing_required_input` is a content completeness
check (verifies `tableName`, `row`, `filters`, `updates` are declared). It is skipped
when the simulate step sets `input.skeleton: true` (routing skeleton validation, step 21b)
because skeleton steps are intentionally input-free. All topology checks run in both modes.
The final pre-write simulate (step 25) always runs full L1 with `skeleton` unset.

##### `condition`
```json
{
  "step": "1",
  "type": "condition",
  "description": "Route to id lookup or name search depending on which input field is set.",
  "expression": "{{input.id}}",
  "on_success": "2",
  "on_else":  "3"
}
```
`expression` is resolved via `resolveTemplate` against `local_state`. Truthy: resolved value is
non-empty, not `"null"`, not `"undefined"`, not `"0"`, and does not contain `{{` (unresolved
template literals are treated as falsy — the key was not set). `on_success` and `on_else` are
bare step keys (e.g. `"2"`, `"3"`) — the executor prefixes them to `step:N` internally.
No output_key is written — condition steps produce no state output.

**Constraint:** `on_success` and `on_else` must reference step keys that exist in the workflow.
Level 1 static analysis validates both targets as `step:N` routing tokens.

##### `js_transform` — full detail

Only one mode: `expression`. The `transform_type` field is removed — all built-ins replaced
by self-contained expressions. Any step using `transform_type` throws immediately at runtime.

**Sandbox bindings (Session 20)**

| Binding | Source | Notes |
|---|---|---|
| `items` | `resolvePath(localState, step.input_key)` | Primary input — resolved value at `input_key` |
| `local_state` | Full `localState` object | Cross-key reads — required when input_key is insufficient |
| `JSON`, `Math`, `Array`, `Object`, `String`, `Number`, `Boolean`, `Date` | Safe globals | No Node.js APIs |

`local_state` enables workflows generated by `create_workflow` to be fully self-contained —
an expression can read any key already written to the workflow state without needing a
dedicated step type for every combination.

**Constraint boundary.** `js_transform` is restricted to **pure synchronous data transformation** —
operate on data already in `local_state` and return a new value. It never fetches, never writes,
never calls external services.

- "Transform data I already have" → `js_transform` with `expression`
- "Fetch data I don't have" → `serv_*` step type or `capability_call` (Backlog)

**AST gate — rejection rules.** The acorn parser walks the AST before `vm.runInNewContext` is called.
Any of the following causes an immediate throw:

| Rejected AST node | What it blocks |
|---|---|
| `ImportDeclaration` | `import` statements |
| `CallExpression` where callee is Identifier `require` | `require()` calls |
| `MemberExpression` with object Identifier `process` or `global` | Node.js globals |
| `AwaitExpression` | Any `await` |
| `FunctionDeclaration` or `ArrowFunctionExpression` with `async: true` | Async functions |
| `NewExpression` where callee is Identifier `Function` | `new Function()` |
| `CallExpression` where callee resolves to `eval`, `fetch`, `XMLHttpRequest` | Network and eval |

`vm.runInNewContext({ timeout: 200 })` reliably kills synchronous infinite loops.

**Example expressions:**

| Use case | Expression |
|---|---|
| Enrich tables with columnSummary | `(function() { var SYS = new Set(['id','created_at','updated_at']); return items.map(function(t) { var cols = (t.columns||[]).filter(function(c){return !SYS.has(c.name);}).slice(0,4).map(function(c){return c.name;}); return Object.assign({},t,{columnSummary:cols.join(', ')}); }); })()` |
| Merge new_table from local_state | `(function() { var n = local_state.new_table; return n ? items.concat([n]) : items; })()` |
| Count passing results | `items.filter(r => r.score > 0).length` |
| Sum a numeric field | `items.reduce((acc, r) => acc + (r.score || 0), 0)` |
| Filter by field | `items.filter(r => r.status === 'active')` |
| Read cross-key value | `items.concat(local_state.extra_items || [])` |

**Former built-ins and their replacements (for migration reference)**

| Former `transform_type` | Replaced by | Workflow / step |
|---|---|---|
| `columnSummary` | Expression reading `local_state.proposed_scaffold.domain` | `create_domain` steps 2, 3c |
| `buildHelpOptions` | Expression over `items` (registered_domains) | `help` step 2 |
| `resolveHelpContent` | Expression reading `local_state.help_selection` + `local_state.help_options` | `help` step 4 |
| `formatRecordList` | Deterministic `js_transform` pre-processing (FK resolution, null/system/embedding stripping) feeding the `format_entity_display` `llm_call` (Sprint 7 Track D2) — see `docs/arch-workflow-patterns.md` §6.17 | `get_entity` steps 5-11, `list_entity` steps 3-9 |
| `buildChildInserts` | Expression reading `local_state.full_entity_schema`, `local_state.parsed_entity`, `local_state.new_record` | `add_entity` step 5 |

##### `serv_entity_schema`
```json
{
  "step": "1",
  "type": "serv_entity_schema",
  "input": { "entityName": "{{input.entity_name}}" },
  "output_key": "full_entity_schema",
  "on_success": "next",
  "on_else": "cancel"
}
```
Loads a full entity schema by combining `PGC_EntitySchema` (join topology) with `PGC_Schema`
(live column definitions for all tables in the entity). Replaces the two-step pattern
(`serv_query PGC_EntitySchema` → `js_transform buildEntitySchema`) with a single step.
I/O does not belong in `js_transform`.

`entityName` is the PascalCase singular name from `PGC_EntitySchema.entity_name` — e.g. `Recipe`.
Supports `{{template}}` substitution.

**Output shape written to `output_key`:**
```json
{
  "entity_name": "Recipe",
  "description": "A cooking recipe with ingredients and steps",
  "root": {
    "table":   "PGD_Recipes",
    "columns": [{ "name": "name", "type": "text" }]
  },
  "children": [
    {
      "table":      "PGD_RecipeIngredients",
      "alias":      "ingredients",
      "fk_column":  "recipe_id",
      "output_key": "ingredients",
      "columns":    [{ "name": "ingredient_name", "type": "text" }]
    }
  ]
}
```
System columns (`id`, `created_at`, `updated_at`) and FK columns are excluded from all column lists.
Column definitions are read from `PGC_Schema` at runtime — not cached — so new columns are
immediately visible without recreating the domain.

##### `write_memory`
```json
{
  "step": "16c", "type": "write_memory",
  "description": "Persist confirmed schema snapshot as semantic domain memory.",
  "input": {
    "memory_type": "semantic",
    "scope":       { "domain": "{{proposed_scaffold.domain}}" },
    "content_key": "domain_semantic_content",
    "tags":        ["schema_snapshot", "insert_expectations"],
    "priority":    2
  },
  "on_success": "next",
  "on_else": "next"
}
```
`content_key` names a `local_state` key whose string value becomes the memory content.
`token_estimate` is computed automatically: `Math.ceil(content.length / 4)`.
Scope values support `{{template}}` substitution resolved at write time.
No `output_key` — the step returns `outputValue: null`. Errors are logged but never fail the run.
See Section 6.13 for the full memory layer design.
