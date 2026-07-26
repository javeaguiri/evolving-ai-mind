# Sprint 9 — create_workflow Design/Translation Quality

**Status: SCOPING PENDING — theme under active reconsideration (2026-07-26).**

> Read `docs/sprints/sprint-08.md` §RETRO before scoping. Full scope, ACs, and test
> scenarios are written at **"start sprint"**; this file is the carry-forward seed only.

> ## ⚠️ Read `docs/arch-minds-eye.md` §12 before scoping this sprint
>
> A 2026-07-26 session re-evaluated whether `create_workflow` is converging and concluded
> it is not: 98 runs have yielded 4 surviving workflows, `generate_workflow_steps` has gone
> v11 → v49 in ten weeks, and the defect class has moved from structural (a validator
> catches it) to semantic (none does). A prompt sweep measured ~174 KB of static instruction
> across the four design prompts, of which only ~23% of `generate_workflow_steps` performs
> the task it is named for; the rest is archetype knowledge, correction-loop orchestration,
> and registries transcribed as prose.
>
> **Direction set:** dissolve `create_workflow` into a Novia-driven toolkit with design
> archetypes as searchable entities — gated on first evaluating Novia's capability.
> Full proposal, evidence, and open questions: `docs/arch-minds-eye.md` §12.
>
> **Consequence for the candidate scope below:** the lead item (bounded translation drift)
> is likely **moot** — it relaxes a translation-stage constraint that exists only because the
> routing skeleton locks, and the skeleton lock does not survive the proposal. The two
> `create_workflow` design defects are addressed structurally rather than by prompt edits.
> Do not scope the items below without reading §12 first.
>
> Work in progress on branch `design/archetype-registry` (5 commits): `PGC_Archetype` table
> template, seed of six draft archetypes, `init-brain.mjs` wiring, `dev_scripts/upsert-archetype.mjs`,
> and the §12 design record. **Nothing is live** — requires deploy + `POST /api/v1/serv/bootstrap`.
>
> **Do not run `create_workflow`** meanwhile: `design_workflow_dialogs` v19 carries a splice
> that terminates the prompt halfway through, so its `form` gate rules may not be in force
> (`arch-minds-eye.md` §12.8). Deliberately unrepaired — the prompt is retired by the proposal.

---

## Theme

Sprint 8 proved the `create_workflow` development loop is free. Sprint 9 spends that
free loop on **the quality of what `create_workflow` generates** — the design and
translation defects the now-cheap iteration makes affordable to find and fix — plus the
release-readiness work the Sprint 8 cost stop preempted.

**Provisional branch:** `sprint/09-create-workflow-quality`

---

## Candidate scope (from Sprint 8 carry-forward — not yet committed)

### Lead — bounded translation drift
Permit routing-inert helper steps at the translation stage instead of rejecting
functionally-correct output for step-count drift. Topology stays locked; a `js_transform`
helper (`on_success: next`, reads only existing keys, writes a new key) is permitted and
re-validated (topology-equivalence + L1 over the added step). Coordinated change:
`simulation-engine` skeleton check + `generate_workflow_steps` prompt. Two live specimens
(runs 734, 735). Broaden the trigger to "a step needs a *derived/reshaped* value not
directly available," and add an L1 check for `{{key.N}}` numeric indexing on non-arrays.
See `docs/backlog.md` High Priority.

### create_workflow design defects (surfaced by edit_budget, run 735)
- **Query row-limit discipline** — a `limit` smaller than the data silently drops rows
  (run 735 dropped the current month); omit unless justified against dataset shape.
  `design_workflow_process`.
- **Derive-before-consume ordering** — a gate's composite value (e.g. a `"YYYY-MM"`
  period) must be decomposed before the step that queries on it. Likely subsumed by
  bounded drift; confirm.

### edit_budget end-to-end (AC10 second half)
Re-run the generated workflow once the design defects above are fixed. Build already
validated (registered, id 356); runtime is what remains.

### Bold `**` renders literally in a gate message (run 735)
`callback.mjs` rendering; needs a repro (screen + line) to pin the block path
(`mrkdwn` section missing `toSlackMrkdwn`, or a `##` heading in a plain_text `header`
block). Execution domain.

### Release-readiness (preempted by the Sprint 8 cost stop)
Test environment parallel to prod, README bootstrap, log hygiene. The replay harness is a
prerequisite for an affordable non-prod environment.

---

## Deferred exercise (carried from Sprint 8, not defects)

- `soft_drift` — never fired; needs memory to move between corpora to trigger.
- `dev_scripts/replay.mjs` file-loop — never driven end-to-end (AC3 closed against the
  endpoints it wraps).

---

> Full tech-debt register and item detail: `docs/backlog.md`.
