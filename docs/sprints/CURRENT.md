# Sprint 12 — The Repair Loop, and Release Readiness

**Status: SCOPED 2026-08-30. Branch `sprint/12-repair-loop-and-release`.**

> **Read before implementing:** `docs/sprints/sprint-11.md` §Retro and §Validation,
> `docs/backlog.md` §High Priority, and `docs/receipt-matching-analysis.md`.

---

## Sprint Goal

**Make the loop that changes the system cheap and safe to use, and make the system safe to hand
over.**

Sprint 11 fixed a repair loop that was blind at both ends: Novia could not see the whole artifact
she was editing, and the gate could not show the user what she had changed. Both are fixed and
proven live. What that exposed is the thing underneath — **`propose_workflow_fix` demands the
complete step array to change one step.** Every defect in that class descends from it. The engine
and instruction fixes made the full read survivable; a patch makes it unnecessary.

The second half is the one that has waited longest. **Release-readiness has been deferred five
sprints and was decided into this one** (Sprint 11 AC6). It goes early rather than last, because
everything else this sprint does — building a workflow, calibrating thresholds against live rows,
retesting a workflow end to end — is currently validated by deploying a branch to production and
watching. That is the interim process, and it is what a test environment removes.

**Branch:** `sprint/12-repair-loop-and-release`

---

## Why this shape

Sprint 11's retro named a failure mode worth designing against here: **three separately-accurate
backlog entries hid a single defect between them.** Each was written from the case that surfaced
it, each proposed a local fix, and none named the shared rule. Working them in order would have
shipped three patches and no principle.

Track A is the same shape one level up. The patch is not a convenience — it removes the
*requirement* that produced the whole 2026-08-27 class. Do it before building anything new, so
Tracks C and D are built and repaired through the loop as it should be, not as it was.

The standing instruction holds: **record new findings in `docs/backlog.md` rather than absorb them
mid-sprint**, unless the user says "add to sprint".

---

## Tracks

### Track A — `propose_workflow_fix` accepts a patch (opening item)

**The case.** The tool takes the COMPLETE step array, so repairing one step means reading and
resubmitting all of them. On a workflow past the transcript cap the array she submitted was
part-read and part-remembered, and `process_receipt` step 13 silently lost four fields. Sprint 11
made the full read survivable — outline, step selectors, a recall handle, a gate that shows every
changed field. None of that removes the requirement.

**Granularity is the step, not the field** (decided 2026-08-30). A patch is a set of **complete
steps**, merged into the stored array by `step` identifier. Field-level patching would let a
half-specified step through the gate and put the engine in the business of merging fragments;
step-level keeps every submitted step a valid, simulatable unit, keeps L0/L1/L2 running against the
merged array, and makes the gate diff exact rather than inferred — what she submits *is* what
changed.

**Simulation does not constrain this, and the reason matters.** The server already holds the full
array: `propose_workflow_fix` reads the stored workflow (`minds-eye.mjs:1772`) purely to build the
diff. Merging a patch into that read and validating the merged array is the same fetch plus a
merge. **The simulator never sees a patch — it always sees a complete workflow.** A patch changes
what crosses the model/engine boundary, not what the validator receives.

**What the check found instead: `propose_workflow_fix` does not simulate at all.** Its body reads
the workflow, builds the diff, and calls `updateRows`. No `runSimulation`, no L0/L1/L2 refusal —
that is `register_workflow`'s behaviour, not this one. Novia simulated twice in session 1177
voluntarily and nothing required it. **The repair path has no validation gate, and closing that is
part of Track A, not a precondition for it.**

**The consequence that does bite is on the other tool.** `simulate_workflow` takes `steps` only
(`minds-eye.mjs:2521`), so an agent holding a patch cannot pre-validate without reconstructing the
full array — which defeats the patch. **Track A is two tools:** the write tool and the simulate
tool both take `{ workflowName, patch }` and merge server-side.

**Done this way the repair path gets safer than it is today, not riskier:**

| | Today (full array) | With a patch |
|---|---|---|
| Base of the submitted array | Partly read, partly remembered | The database, authoritative |
| Surface she can corrupt | The whole workflow | Only the steps she names |
| Validation before write | **None** | L0/L1/L2 on the merged array |
| Concurrent change to the workflow | Silently clobbered | Caught by a base-version check |

The last row is a property the full-array form cannot have: she reads at T0 and submits at T1, and
today whatever landed in between is overwritten without trace. A patch merges against the version
she read and can be refused if it moved.

**To settle during design, not now:**
- Whether a patch may add or remove steps, or only replace. **Leaning yes on add:** session 1177
  added step `13g`, and L1 already rejects unreachable steps and dead routing targets, so a
  typo'd step identifier that becomes an orphan is caught by the merged-array simulation. The
  safety comes from validating the merge, not from restricting the patch. Adding a step still
  means editing the routing of steps not in the patch, so those steps join the patch.
- Whether `register_workflow` shares the merge and validation path.
- Whether the full-array form stays accepted alongside the patch form, and for how long.
- What the gate renders for a patch — the diff is against the merged array either way.
- Whether the base-version check is advisory or refusing.

**Acceptance:** AC1.

### Track B — Release readiness

**Carried from Sprint 11's AC6 decision.** Three parts, and they are not equally hard:

1. **A test environment parallel to prod.** The interim process — *deploy the branch to prod,
   validate, then merge* — was used again on 2026-08-30 and is what this replaces. Main must
   always reflect what is actually running; once a test environment exists that flips to *deploy
   to test → validate → merge → deploy to prod*.
2. **README bootstrap.** A second person, or the same person on a new machine, should be able to
   stand the system up from the repository.
3. **Log hygiene.** Deferred alongside the other two since Sprint 7.

**Acceptance:** AC2.

### Track C — The inventory correction workflow

**Carried from Sprint 11 AC2, unstarted.** Four verbs over the same two tables, designed as **one**
workflow rather than four:

1. **Rename** an item — `PGD_Inventory` 25 is a red wine recorded as "Ink Cartridge"
2. **Merge** a duplicate into another item, moving quantities and aliases with it — inventory 69
   *Bread Loaf* duplicates 39 *Baguette*, and alias 86 points at the duplicate, so it is
   self-reinforcing
3. **Recategorise** an item, and **aggregate** two `PGD_InventoryCategory` rows meaning the same
   thing
4. **Fix an alias** — repoint or delete one resolving to the wrong product

**This is containment, not cleanup.** An alias hit is precisely the path that avoids human review,
so a wrong alias applies itself silently on every future shop.

**Non-negotiable:** aliases are keyed on the **raw receipt string**, never the English rendering.
Keying the wine's correction on "Ink Cartridge" would make a real ink purchase increment the wine.

**Built by Novia**, and now through the patch loop. This is the sprint's second data point on
whether she handles maintenance work as well as greenfield.

**Acceptance:** AC3.

### Track D — The two vector thresholds

**Carried from Sprint 11 AC3, unstarted.** Both still at the inherited **0.4**, which came from a
cross-lingual comparison that exists on neither step:

| Step | Comparison | Column |
|---|---|---|
| 8 | English → English | `name_embedding` |
| 8c | raw string → raw string | `alias_name_embedding` |

Three wrong merges are the specimens: `PANU BOL MIN SELEX` → *Rustic Sliced Bread*;
`ARANDANOS DESH ALT` (dehydrated) → *Blueberries 300g* (fresh); `PAN MOLD INT ALTEZ` → *Rustic
Sliced Bread*. Probes against live rows are free. The edit is a domain artifact, so it goes through
`propose_workflow_fix` — a patch, once Track A lands.

**Acceptance:** AC4.

### Track E — Retest `edit_budget`

**Carried from Sprint 11 AC5, unstarted.** Workflow 357 is at v6 and its runtime half has never
been validated end to end through the Novia path. This is Sprint 9's AC5 second half, carried
twice.

**Acceptance:** AC5.

---

## Acceptance Criteria

| # | Criterion | Track | Threshold |
|---|---|---|---|
| **AC1** | A single-step repair is submitted, gated and applied without resubmitting the whole array; the merged array passes L0/L1/L2 **before** the write, and a merged array that fails is refused | A | Binary, verified live from `/novia`, including one deliberately failing patch |
| **AC2** | A change is validated on a test environment before reaching prod, and the README stands the system up from scratch | B | Binary, demonstrated on one real change |
| **AC3** | One correction workflow performs rename, merge, recategorise and alias-fix; `PGD_Inventory` 25 and the `PAN MOLD INT ALTEZ` alias are both corrected through it | C | Binary, from Slack, no raw SQL |
| **AC4** | Both thresholds calibrated against live rows and applied; the three known wrong merges no longer auto-resolve | D | Binary, evidenced by probe output before and after |
| **AC5** | `edit_budget` runs end-to-end from Slack | E | Binary |
| **AC6** | **Give Novia the replay harness as a tool — decided, not defaulted** | — | A decision exists on the record |

**AC6 exists for the same reason Sprint 11's did.** She can propose a fix and has no way to test it
against the failing case: `simulate_workflow` is L0/L1/L2 and executes nothing, and `run_workflow`
needs fresh input through a gate. The replay harness does exactly this, costs nothing, keeps gates
real, and is not in her tool list — the endpoints exist and `dev_scripts/replay.mjs` already drives
them. Sprint 11's evidence is that **every verification available to her is a proxy, and both of
hers confirmed** a hypothesis her own pre-fix probe had already falsified. Track A makes proposing
a fix cheap; this is the other half. The AC does not require the work — it requires that the
decision be made rather than deferred a third time.

---

## Standing observations — not tasks

These resolve on events outside the sprint's control. **Record them when they happen; do not
schedule them.**

| # | Observation | Resolves when |
|---|---|---|
| **AC9 (Sprint 10)** | Per-receipt cost falls with use — third < first, same merchant | An ordinary shop produces a MASYMAS receipt whose items overlap the alias table. **Protocol pre-registered** in `sprint-10.md`: per-item step-10 input tokens against the **831** baseline, per-item cost against **$0.0073**, auto-matched count as support. Raw per-receipt cost is explicitly *not* the criterion. **The notify message is not the instrument** — see `receipt-matching-analysis.md` |
| **AC13 (Sprint 10)** | Novia's home-intelligence proposal convinces the friend | The user shows it to him |
| **Workflow 358 v6/v7 fixes have still never executed** | The 8b/8d max-wins dedupe and the conditional alias write are both live in v8 and unproven — run 788 answered *Skip inventory* and wrote nothing. Resolves on the next grocery receipt that is applied |

---

## Out of Scope

| Item | Why |
|---|---|
| **Output-token cost reduction** | ~48% of a receipt run and the largest remaining cost term, but still **unmeasured and undiagnosed**. Measure before optimising; a sprint that opens with an optimisation target and no measurement repeats Sprint 9's AC9 |
| **The prefix forfeit on the prose-reply path and gate resume** | Real and worth 58% of one session, but it is Novia-loop cost, not correctness. Backlog, High Priority |
| **Transcript eviction / dynamic recall** | Designed in Sprint 11 with its three rules and a stated trigger: a session that ends on context rather than on the 240s wall. Neither has happened — sessions die on time at ~80 entries. Do not build it before the trigger |
| **`create_domain`'s unconsumed derived-field rules** | Unchanged. Sequence *do not denormalize* first |
| **Deleting `create_workflow`, and `/chat` dead code** | Both still undecided, and both need a dependency sweep before anything is removed. Sequence the two together |
| **The two `process_receipt` readout defects** | Domain artifacts, recorded in `receipt-matching-analysis.md`. Let them surface through use — they cannot damage data |

---

## Sprint Close Checklist

- [ ] `node --test tests/unit/*.test.mjs` passes
- [ ] L0/L1/L2 pass on every workflow built or modified this sprint
- [ ] `CLAUDE.md` "Current State" updated
- [ ] `docs/architecture.md` updated if any `.mjs` added/removed/renamed or any decision made
- [ ] `docs/arch-data.md` updated if any schema changes
- [ ] `docs/arch-minds-eye.md` updated — the patch contract is Novia's tool surface
- [ ] `README.md` updated — Track B makes this a deliverable, not a checkbox
- [ ] `docs/backlog.md` updated — items completed, new items added
- [ ] `docs/sprints/CURRENT.md` renamed to `docs/sprints/sprint-12.md` with outcome notes and a retro
- [ ] **AC6 — the replay-as-a-tool decision is written down**

---

## Session Notes

### Session 1 — 2026-08-30 — Sprint 11 closed, Sprint 12 scoped

Sprint 11 closed early: 2 of 6 ACs met, plus the repair-loop work that was never an AC. Merged to
main at `65f1f82`; prod is already running it.

Sprint 12 is scoped but **not started** — this session is prep only. Track A is the opener by
decision, and no new workflow is built before it lands.

**Nothing has been prepped in `PGC_*` yet.** The lifecycle's Prep phase — reviewing and updating
the relevant `PGC_SystemContext`, `PGC_Prompt` and `PGC_StepType` rows *before* writing code — is
the first thing next session should do, and for Track A it is not cosmetic: the patch form changes
`propose_workflow_fix`'s contract, so `minds_eye_tool_schemas` and the repair procedure in
`minds_eye_system_prompt` both describe behaviour that is about to change. `minds_eye_system_prompt`
is at **v32** and `minds_eye_context_index` at **v3** as of Sprint 11's close; the repair block in
v32 currently instructs reading the whole array in ranges, which a patch makes unnecessary.
