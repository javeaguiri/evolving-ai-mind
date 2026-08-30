# process_receipt — inventory matching analysis

Domain analysis for the `inventory` domain's `process_receipt` workflow (id 358). Artifact
repairs live here, not in `docs/backlog.md`. Written 2026-08-26 from runs 787 and 788.

## Status

Workflow 358 is at **v5**. Three expression replacements are drafted and tested against run 788's
real `local_state` but **not yet applied** — they go in through `propose_workflow_fix` in a
`/novia` session, which will produce v6.

Measured on run 788 (35 items):

| | before | after |
|---|---|---|
| exact-1.0 rows in the flat alias list | 25 | **35** |
| `BARRA DE PAN` similarity reaching the model | 0.4283 | **1.0** |
| alias rows step 12 would insert | 34 (all duplicates) | **0** |

`updates` (34), `new_items` (1) and `new_category_names` are unchanged by the step 12 edit. A
synthetic item matched by name vector with no stored alias still writes exactly one row, and a
repeated receipt line writes one, not two.

## Not addressed by these fixes

`CAPERUCITA TINTA` → inventory 25. Alias 30 is **correct** — it maps the raw receipt string to the
item actually bought. What is wrong is inventory 25's *name*: "Ink Cartridge" for a red wine,
*tinta* read as ink at parse time. That is a rename of a `PGD_Inventory` row keyed on a raw alias
that must not change — Track B, not a matching defect. It auto-matched HIGH again in run 788 and
every receipt reinforces it.

---

## The brief to paste into `/novia`

Fits one Slack message (~3,900 characters). Use a **new** session, not 1173.

```text
process_receipt v5 has two defects. Verify each against the data before changing anything.

DEFECT 1 - steps 8b/8d discard the similarity that belongs to each query.

  SELECT r."state"->'local_state'->'alias_candidate_sets' FROM "PGC_WorkflowRun" r WHERE r."id"=788;
  SELECT content FROM "PGC_SessionEntry" WHERE session_id=1175 AND role='system';

Alias 44 (BARRA DE PAN) appears in three sets: 1.0 for item 20 (its own query), 0.4283 for item
17 (PAN M. 100%INT FAM), 0.4203 for item 21. Step 8d is "if (!seen[row.id])" - first seen wins -
so item 17's copy survives, and the assembled request shows the model got 0.42826780146698473.

A similarity is a property of a QUERY, not of a row. The flatten destroys the query the number
belongs to; the embedding is not involved. Step 8b has the same defect. Across run 788's 35
items, 10 lost their exact 1.0 this way.

Fix - keep the highest score per row, not the first seen.

Step 8b expression:
(function(){ var idx = {}; var out = []; (local_state.inventory_candidate_sets || []).forEach(function(set){ (set || []).forEach(function(row){ var at = idx[row.id]; if (at === undefined) { idx[row.id] = out.length; out.push(row); } else if (row.similarity > out[at].similarity) { out[at] = row; } }); }); return out; })()

Step 8d expression:
(function(){ var idx = {}; var out = []; (local_state.alias_candidate_sets || []).forEach(function(set){ (set || []).forEach(function(row){ var at = idx[row.id]; if (at === undefined) { idx[row.id] = out.length; out.push(row); } else if (row.similarity > out[at].similarity) { out[at] = row; } }); }); return out; })()

DEFECT 2 - the v5 alias write will fail the next Apply.

Step 12 maps plan.auto_matched unconditionally into new_aliases_resolved. But an item is
auto_matched BECAUSE an alias already matched it, so this re-inserts aliases that already exist.
PGD_InventoryAlias is unique on (inventory_id, alias_name); step 12k is a plain serv_insert,
on_else:cancel, no ON CONFLICT. Run 788 had 34 such items. It did not surface: run 788's step 11 gate
was answered "Skip inventory", so the run wrote nothing.

The gap you found is real but narrower - an item auto-matched by NAME vector has no alias and
does need one. Emit an alias only when one is not already stored.

Step 12 expression:
(function(){ var plan = local_state.match_plan; var existing = {}; (local_state.inventory_categories || []).forEach(function(c){ existing[String(c.name || '').trim().toLowerCase()] = true; }); var matched = plan.auto_matched.concat(plan.llm_resolved); var updates = matched.map(function(m){ return { inventory_id: m.inventory_id, quantity_delta: m.quantity_delta, unit: m.unit }; }); var newItems = plan.new_items.map(function(n){ return { name: n.name_en, quantity: n.quantity, unit: n.unit }; }); var newItemMeta = plan.new_items.map(function(n){ return { name_original: n.name_original, category: String(n.inferred_category || '').trim() }; }); var seen = {}; var newCategoryNames = []; newItemMeta.forEach(function(m){ var key = m.category.toLowerCase(); if (!m.category || existing[key] || seen[key]) return; seen[key] = true; newCategoryNames.push({ name: m.category }); }); var known = {}; (local_state.alias_candidates || []).forEach(function(a){ (known[a.inventory_id] = known[a.inventory_id] || {})[a.alias_name] = true; }); var newAliases = []; plan.llm_resolved.concat(plan.auto_matched).forEach(function(m){ if (!m.inventory_id || !m.name_original) return; var bucket = known[m.inventory_id] = known[m.inventory_id] || {}; if (bucket[m.name_original]) return; bucket[m.name_original] = true; newAliases.push({ inventory_id: m.inventory_id, alias_name: m.name_original }); }); return { updates: updates, new_items: newItems, new_item_meta: newItemMeta, new_category_names: newCategoryNames, new_aliases_resolved: newAliases }; })()

All three are expression-only. Read the current v5 array, replace the three expressions, and
submit the whole array via propose_workflow_fix - three changed expressions, no step-count change.
```

4,026 characters — marginally over Slack's 4,000 soft limit. If Slack converts it to a snippet,
send the three expressions in a follow-up message rather than letting it truncate.

---

## Open after v8 (2026-08-30) — readout only, deliberately not chased

Workflow 358 reached **v8, 29 steps**, via `propose_workflow_fix` in session 1177. That change
split the ending in two: step 13 is now the non-grocery message and carries only tokens that
resolve on that path, and new step **13g** is the grocery message. Step 6 still routes non-grocery
to 13; 12j `on_else` and 12k `on_success` now route to 13g. Step 12c's `output_key` was left as
`updated_rows` — nothing reads it, so renaming it back would have been churn.

**Every change in v8 is readout-only.** Both endings are `notify` steps; nothing in the change
touches matching, alias writing, quantity updates or the 8b/8d dedupe.

Two things remain wrong in the readout. Both were understood at approval time and left to surface
through use rather than fixed pre-emptively.

**1. The alias count undercounts.** Step 13g reports
`{{match_plan.new_items.length}} new aliases learned`. New *items* and new *aliases* are not the
same set: an item recognised by its English name whose raw receipt wording has never been stored
learns an alias without creating an item. Those are missed. It is still an improvement on v7, which
reported `alias_write_plan.alias_rows.length` — everything submitted, about 35 on a known shop,
against a truth of one or two. The correct source is step 12k's `serv_upsert` result, which
distinguishes rows inserted from rows already present.

**This number is not the AC9 instrument.** The pre-registered protocol reads per-item step-10 input
tokens against the 831 baseline and per-item cost against $0.0073, from run records and session
entries. A wrong count here misinforms at a glance; it does not corrupt the measurement.

**2. Skipping inventory still reports counts as if applied.** Step 11's *Skip inventory* routes to
13g, which says inventory changes were applied and prints auto-matched and new-item counts.
`match_plan` is built at step 10, before that gate, so the tokens resolve and report a plan as an
outcome. **Pre-existing, not introduced by v8** — today's step 13 behaves identically on that path.
Run 788 is the specimen: skipped, wrote nothing. The fix is a third ending for the skip path.
