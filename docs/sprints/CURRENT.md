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
voluntarily and nothing required it. Confirmed at the other end too: `preGateRefusal` opens with
`if (action !== 'register_workflow') return null`, so there is no check before the gate either.
**The repair path has no validation gate at either point, and closing that is part of Track A, not
a precondition for it.**

**Reuse, do not rebuild:** `simulateForRegistration(steps, traceId)` already exists and is what
`register_workflow` is refused by. Track A widens the refusal to `propose_workflow_fix` and runs it
against the merged array.

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

**Track A was refined during scoping, in response to the question of whether simulation invalidates
patching.** It does not — the server already fetches the stored array to build the diff, so the
simulator always receives a complete workflow. The check found the opposite problem: the repair
path has **no validation gate at all**, at either the pre-gate or the write. That, plus
`simulate_workflow` needing the patch form so a fix can be checked before it is submitted, is now
written into Track A with `simulateForRegistration` named as the piece to reuse. AC1 was tightened
to require a failing merged array be refused, proven with a deliberately failing patch.

**Open question carried into Prep:** whether the base-version check refuses or merely warns. It is
the one part of the patch design with no precedent in the codebase — the full-array form has always
clobbered silently.

### Session 2 — 2026-09-06 — credential rotation (no sprint work)

**No Track advanced.** The session was administrative: rotating every system credential before the
system holds real household data. Recorded here because Track B is release readiness, and handing a
system over safely is the same concern.

**Rotated and verified live — 2 of 5 secrets:**

| Secret | Result |
|---|---|
| `internal-api-key` | SSM v2. Old key `403`, new key `200` at `/serv/schema/listPhysicalTables` |
| `lambda_user` password | `pgc-database-url` v4, `pgd-database-url` v3. SERV reads confirmed on new connections |

Remaining: `llm-api-key` (Perplexity), `slack-signing-secret`, `slack-bot-token` — in that order,
bot token last because regeneration is a hard cutover with no overlap window.

**Two engine-level findings, both now encoded in `template.yaml` and committed:**

1. **SSM references must be version-pinned.** An unpinned `{{resolve:ssm:...}}` in an
   otherwise-unchanged template can produce an empty changeset, so the rotation never deploys while
   SSM holds the new value — a *silent partial rotation* in which the old credential keeps working
   and everyone believes it was replaced. Pinning forces the changeset and records the live version
   in `git diff`.

2. **`AWS::ApiGateway::ApiKey` must not carry an explicit `Name`.** Changing `Value` forces
   replacement, CloudFormation creates before deleting, and a fixed name collides with itself:
   *"ApiKey with name evolving-mind-ai-internal-key already exists"*. This was observed as a real
   stack rollback, not predicted. The rollback was clean, which is the second half of the finding —
   it fails safe, but it fails.

**A process rule came out of that rollback and is now in the runbook: deploy BEFORE changing a
database password, never after.** If the deploy rolls back with the password already changed, the
Lambdas revert to a URL the database no longer accepts and the outage persists until diagnosed.
Deploying first puts the fragile step where its failure costs nothing.

**Delivered:** `docs/ops-key-rotation.md` — the full procedure for all six SSM parameters plus the
credentials that are not in SSM (`.env.test`, `.claude/settings.local.json`, the bastion SSH
keypair, IAM access keys). Contains no secret values by construction.

**Hygiene fixed along the way:** `.env.test` and `.claude/settings.local.json` were both `644`
(world-readable) and are now `600`; the three `.claude/settings.local.json` permission patterns that
embedded the API key literally were replaced with an env-free form that survives future rotations.
Confirmed no secret has ever been committed to git.

**Open and unrelated to any key — worth more than the rotations.** The RDS security group
`sg-05c00c014cd77e239` port 5432 ingress has never been checked. RDS is `PubliclyAccessible: true`
by final architectural decision, so the password is the only thing between the open internet and
real data. Console-only — `BastionEC2Role` is denied `ec2:DescribeSecurityGroups`.

**Sprint 12 is still at the same point as after Session 1: scoped, not started, Prep not done.**

### Session 3 — 2026-09-06 — Perplexity rotation, and a README that could not bootstrap

**No Track advanced.** Administrative, continuing Session 2. Environment verified healthy after a
restart: both previously-rotated credentials survive, SERV returns `200`, PGC connects.

**`llm-api-key` rotated — SSM v5, pinned at `template.yaml` 644 and 697, deployed.** One parameter,
two env vars: `LLM_API_KEY` on ProcFunction, `EMBEDDING_API_KEY` on ServFunction. Four of five
secrets are now rotated; the two Slack secrets were **assessed and skipped by decision**, neither
having been exposed, and the runbook now records that rather than leaving them looking overlooked.
**The old Perplexity key must still be deleted in the dashboard** — until it is, this is not a
completed rotation.

**The finding worth keeping is about verification, not about the key.** This rotation is the only
zero-downtime one, because Perplexity permits multiple live keys — and that property is exactly what
makes it the hardest to verify. Every other rotation invalidates the old value, so a working system
proves the new value deployed. Here both keys are live at once: a green probe after the deploy
proves only that *some* valid key is in the environment. A silent partial rotation — SSM holding v5
while the Lambdas still run v4, the §2.1 failure — is indistinguishable from success by any
functional test.

What distinguishes them is comparing a **hash of the deployed Lambda environment against a hash of
each SSM version**, old as well as new. Both functions hashed to v5 and differed from v4. This is
now §5.3, and it is not Perplexity-specific: it is the direct form of what §2.5 tests indirectly
through a 403, it works for every parameter in the inventory, and it is the **only** form available
when the old credential is still valid.

**Two runbook corrections, both found by executing it rather than reading it:**

- `.env.test` holds **three** secrets, not two. Line 18 carries `LLM_API_KEY`, read by
  `tests/integration/llm-prompt-schema.test.mjs`. §0's inventory listed two, and §5 listed no
  on-disk copy at all — so following the runbook would have left the integration tests pointing at
  a key that was about to be deleted.
- §5 said to verify "with any workflow that makes an `llm_call`, and one that embeds", which reads
  as requiring a Slack run. Neither half does: `POST /proc/ping-llm` validates ProcFunction plus the
  provider with no Slack, SQS or DB call, and a `getRows` `vectorSearch` descriptor makes SERV embed
  a query string read-only. Both are now baselined before the deploy and re-run after — the
  embedding probe returned an **identical** similarity score either side, which a merely non-empty
  response would not have established.

**Then the sweep found something bigger, and it belongs to Track B.** README Step 3 could not stand
a fresh install up. All five `put-parameter` lines said `--type SecureString` against parameters
that are `String` by final decision — and the decision is load-bearing at that step, because
`{{resolve:ssm:...}}` resolves `String` only and `{{resolve:ssm-secure:...}}` is unsupported for
Lambda environment variables. `internal-api-key` was missing from the list entirely: five documented,
six required, and it is the one that is generated rather than obtained.

**The third defect we caused ourselves, eight days ago.** The version pins added on 2026-09-06 fixed
a silent-rotation failure and created a bootstrap failure: the pinned numbers are *this*
installation's rotation history, and a fresh install has every parameter at version 1, so the eight
committed pins do not resolve. Fixed in Step 3 with instructions to reset them.

**That is Track B's premise arriving unprompted.** "A second person, or the same person on a new
machine, should be able to stand the system up from the repository" was not true, and none of the
three defects would have surfaced by reading — the first two needed the rotation, the third needed
a change made *after* the README was last checked. It is worth carrying into Track B that the
README's remaining steps have the same standing: unverified until someone executes them.

**Commits:** `3b1eda2` (rotation + runbook), `c5580e0` (README).

**Rotation closed the same session.** The old Perplexity key was deleted in the dashboard, and both
probes were re-run afterwards: `ping-llm` returns `sonar`, the `vectorSearch` probe returns the same
`0.2433982428895054` for the third time. **With the old key dead this is the definitive proof** —
the hash comparison in §5.3 establishes which key deployed while both are valid, and deleting the
old one converts a green probe from weak evidence into conclusive evidence. Four of five secrets
rotated; Slack's two skipped by decision.

**One live confirmation of the runbook's stale-link hazard, observed rather than predicted.** After
`.env.test` was updated, the already-running shell still held the **deleted** key in memory —
hashed `a9d081fc39b3` against the file's `7ceb47e436f9`. `.bashrc` sources `.env.test` at login
only, so an integration test run in this shell would now fail against a key that no longer exists,
and it would present as a provider error rather than as a stale environment. §2.4 item 3 and §5.4
both already say to restart the shell; this is what that instruction is for.

**Sprint 12 remains where Sessions 1 and 2 left it: scoped, not started, Prep not done.** Track A is
still the opener.

### Session 4 — 2026-09-07 — the security group, and a deployer role that was never complete

**No Track advanced, but the findings are Track B's** — release readiness is about handing the
system over safely, and this session established what a second person would actually inherit.

**The standing item from §1 of the runbook was executed for the first time.** *"Confirm the RDS
security group does not allow `0.0.0.0/0` on 5432"* had been carried unchecked since Session 2. The
answer is that it does, deliberately, and **cannot be closed**: `RDSPostgresIngress` declares it
because Lambda-outside-VPC means the functions arrive from AWS public IPs with no source to scope
to. Deployed rules match the template exactly — no drift.

**The part that was not predicted: the group reads as scoped and is not.** Two of its three ingress
entries are decorative. `LambdaSecurityGroup` is referenced in exactly one place in the entire
template — the RDS ingress rule itself — and is attached to **no function**, because no `VpcConfig`
exists anywhere. The bastion rule is subsumed by the open one. Anyone tightening this group by
reading it would edit the two rules that do nothing and leave the one that governs.

**The Excel requirement was clarified, and it dissolved a planned change.** The bastion was built
for a home laptop to reach PostgreSQL from Excel; because 5432 is already open, **the bastion is not
what makes that work** and an SSH tunnel would buy nothing. An IP allowlist on port 22 was drafted,
then abandoned on two facts: the address is dynamic across two locations — logins came from three
distinct IPs in two days, and the address supplied for the allowlist was not the one the session was
connected from — and **SSM Session Manager cannot serve Blink on iOS**, which has no Session Manager
plugin. A PC-only solution buys nothing while the port stays open for the phone.

**That reframed port 22 rather than hardening it.** SSH is key-only (`passwordauthentication no`,
`kbdinteractiveauthentication no`), zero failed auth attempts in 24h, six distinct source IPs in the
retained week of which at least three are the user's. The realistic attack is key compromise, not
brute force — so the keypair is the control, and rotating it is worth more than the allowlist would
have been. **The user rotated it the same session**: `bastion-key-sept-2026` added and working from
the PC, old key still present pending Blink.

**Deployed (three attempts, two phases each):** connection logging (`log_connections`,
`log_disconnections` — dynamic, active immediately), `DeletionProtection: true`,
`BackupRetentionPeriod` 1 → 7, and `AmazonSSMManagedInstanceCore` on `BastionEC2Role` as break-glass
shell access independent of port 22.

**A correction that cancelled a planned outage.** The parameter group was written to set
`rds.force_ssl: "1"` on the premise that the server accepted plaintext connections. It does not:
`rds.force_ssl` is already `1` with `Source: system` — the PostgreSQL 16 engine default — and its
`ApplyType` is **dynamic**, not static. TLS enforcement was never missing, and **no reboot was
needed**. CloudFormation silently dropped the parameter as a no-op against the default, which is why
`--source user` lists only the two logging parameters. The gap described did not exist.

**The session's real finding is `BastionEC2Role`, and it belongs to Track B.** Three permissions
were missing, each surfaced by a CloudFormation rollback rather than by inspection:
`rds:DescribeDBParameterGroups` + the parameter-group lifecycle, `rds:DescribeEngineDefaultParameters`,
and `ec2:DescribeSecurityGroups` — the last of which is required to resolve
`!GetAtt RDSSecurityGroup.GroupId`, so **any** update to `EvoMindDB` failed without it. CloudFormation
runs as this role when deploying from the bastion and **denies one action per attempt**, so the set
had to be discovered serially. Each fix also needed **two** deploys, because a changeset carrying
both an IAM grant and the resource needing it cannot rely on the grant being effective in the same
operation.

**This is Session 3's README finding one layer down.** The deployer role has never been complete;
nothing revealed it because the stack had never been asked for a resource type it had not created
before. A fresh install would hit the same wall, and — like the README's version pins — it is
invisible to reading. All three rollbacks were clean, which is the second half of the finding: it
fails safe, but it fails.

**A credential store nobody had listed.** The `evomind-infrastructure` stack holds `DBPassword`
(`NoEcho`, the `lambda_user` master password) and `YourKeyNameParameter`. Both now diverge from
reality **by design** — §3 changes the password with `ALTER USER`, and the SSH key was rotated
through `authorized_keys` — and both must be left alone: supplying the pre-rotation `DBPassword` on a
later deploy would reset the master password out from under SSM, and `KeyName` on
`AWS::EC2::Instance` is replacement-forcing, so changing it would destroy this host. Added to the
runbook's §0 inventory, which listed neither.

**Also established:** `pgc-database-url` and `pgd-database-url` both connect as `lambda_user`, which
is *also* the RDS `MasterUsername` — the system has exactly **one** database credential and it is
the master. That is the argument for a least-privilege `excel_user` role before any financial data
exists, not after.

**Verified after deploy:** `ping-llm` returns `sonar`; `getRows` and a `vectorSearch` descriptor both
succeed. 1044/1044 unit tests pass — though no `.mjs` changed, so the meaningful regression surface
is the Slack path, which is the user's to exercise.

**Carried to Track B by decision, not left open.** The `excel_user` role; whether to re-assert
`DBPassword` so the stack matches reality; a Slack end-to-end covering the two tiers the curl probes
do not reach; and `StorageEncrypted`, which is absent and **cannot be changed in place** — snapshot,
encrypted copy, restore, new endpoint. That last one is raised now rather than filed because the
financial data does not exist yet, and this is the cheapest that operation will ever be.

**`bastion-host-key` is retained deliberately.** It may become a collaborator's key. The decision on
*how* a collaborator gets access — a second host, or a separate user account on this one — is
deferred to Track B, with the tradeoff on the record: a shared key is shared **identity**, so `last`
and the newly-enabled connection logging would attribute two people to one account. Neither private
key has ever been on this host or in a transcript.

**Sprint 12 is still scoped, not started, Prep not done.** Track A remains the opener.

### Session 5 — 2026-09-07 — Track A built and deployed; AC1 awaits live proof

**Sprint 12 has started.** Prep and Track A landed in one session, commit `032a4d2`, deployed with
both `PGC_SystemContext` rows upserted (`minds_eye_system_prompt` v32 → **v33**,
`minds_eye_tool_schemas` v6 → **v7**). Regression check first: `/help` from Slack confirmed the
slackbot → SQS → proc → serv → callback path that Session 4's curl probes could not reach.

**All five open design questions were settled before any code was written**, and four of the five
went the way the sprint doc leaned. The fifth — the one with no precedent — was decided as
**refusing, not advisory**: `baseVersion` is required with a patch and a mismatch refuses the write.
The argument that would have made refusal brutal under the full-array form no longer applies, because
recovery is re-reading the few steps being changed. Its designed-for interaction: **the likeliest
source of a stale version is her own previous write**, so the result returns `nextBaseVersion` and
v33 says to carry it forward, or the refusal would mostly fire on false positives.

**Prep found the artifacts were the smaller half.** `minds_eye_context_index` v3 turned out to carry
no reference to the repair path at all, so only two rows needed changing, not three. The v32 repair
block instructed reading the whole array in ranges — advice a patch makes unnecessary — and that is
what v33 replaces.

**The sprint doc understated the defect, and the code says so plainly.** It recorded that
`propose_workflow_fix` does not simulate. It also does not simulate *at the gate*: `preGateRefusal`
opened with `if (action !== 'register_workflow') return null`. **The repair path validated at
neither end**, so a repair could leave a workflow in a state `register_workflow` would have refused
outright — on an array that is already live, which is the wrong way round. Both ends now run the
shared `simulateForRegistration` against the merged array.

**A second thing nobody had filed.** `stepCountMismatch` has been computed and returned by the tool
since it was written, and **nothing reads it**. Someone anticipated precisely the failure that later
occurred — a short array silently replacing a long one — and shipped a flag rather than a refusal.
It survives as reporting now that validation does the guarding.

**Design decisions worth keeping.** Granularity is the step, never the field. A replaced step keeps
its array position, so index 0 cannot drift — `run-workflow.mjs` seeds the root frame from it.
Absence means unchanged, so deletion is explicit in `removeSteps`; the full-array form could delete
by omission and that capability would otherwise have disappeared silently. `mergeStepPatch` is pure
and exported, and `resolveProposedSteps` is shared by the pre-gate refusal, the gate text and the
write so the three cannot disagree about what is being written. The simulator still only ever
receives a complete workflow.

**Tests 1044 → 1054**, ten of them on the merge. The ASCII-only assertion on the tool schemas row
caught em dashes in the new tool descriptions — the seed-encoding convention working as designed,
on the first change to touch it.

**AC1 is not met yet, and this is the honest status.** The contract is built, deployed and unit
tested; the criterion requires it verified live from `/novia` including one deliberately failing
patch. Three cases to run from Slack: a single-step repair applied through the gate, a patch whose
merged array fails L1 (expect refusal before the gate with the issues returned and the loop still
running), and a second patch reusing a stale `baseVersion` (expect refusal with the current
version). `process_receipt` is the natural subject — it is the workflow the whole defect class came
from. Session 1189's inventory planning will supply the real repair.

**Track A does not close until that runs.** Tracks C and D unblock at the same moment.

### Session 6 — 2026-09-07 — the README's centre of gravity (no sprint work)

**A one-off administrative task, committed directly to `main` at the user's instruction** and then
merged into the sprint branch (`d93a065`). No sprint AC advanced, nothing deployed, docs only.

**The README still opened on the left/right brain split as the system's organising idea** — the
second thing a reader met, framed as *"the system is designed around two complementary modes of
reasoning that must work together."* That stopped being true at Sprint 10's GO, when the agent was
measured against `create_workflow` and replaced it as the way workflows are built. The document had
not caught up: `create_workflow` was still listed as `✅ Working — R/L brain pipeline`, and `/novia`
still read as Sprint 5 "Phase 1" with a tool list four sprints stale.

**Two sections now stand where one did.** `## The Minds-Eye Agent — The Central Tenet` leads, and
the L/R material survives beneath it — cut to roughly a third, opening with an explicit scope line
declaring it subordinate, and rewritten around `create_domain`'s prompts rather than
`create_workflow`'s. The "right brain will one day evolve prompts autonomously" framing is gone: the
scaffolding fields still exist and are still named, but the reasoning over them is now stated as the
agent's work, done on request with a human in the gate, and **the design does not assume it will
become an autonomous process.**

**Personalisation is documented as a property, not a quirk.** The two-name table from
`arch-minds-eye.md` §1.0 is now in the README: `minds-eye` is the static system name and requires a
code change; the display name is one row in `PGC_SystemContext.minds_eye_preferences` and requires
one `updateRows`. **"Novia" is stated as the author's choice rather than a system fact** — a reader
standing this up for their own household is told plainly that the name is theirs to set. This is the
Static System vs Evolving Artifacts boundary applied to identity, and it reads as an argument for the
boundary rather than a footnote about it.

**The claim the section rests on is measured, not asserted:** $1.376 against the $1.42 pipeline
baseline to build, and $0.672 to repair unaided from a symptom — the second being the thing a
generation pipeline cannot do at all, because it has no way to look at what it built.

**Nothing about the sprint changed.** AC1 still awaits its three live cases from `/novia`, and
Tracks C and D still unblock on it.

### Session 7 — 2026-09-08 — the gate contract was lying, and nothing could tell

**AC1's live cases were dropped from the ordering** at the user's direction: the priority is
the workflow that makes the system useful to its owner, and AC1 will be verified when the
repair loop is next exercised rather than being staged ahead of everything else.

**The session started as a capability check and became a contract audit.** Session 1189 had
Novia designing the inventory correction workflow, and she told the user — under a heading
reading *"The Honest Tradeoff"* — that the platform's form *"can only collect selections, not
edits to individual values"*, then designed a checkbox-to-delete plus one-text-box-to-add
workaround for alias editing. **Truncation was ruled out as the cause first:** entry 11 is the
52,477-character `PGC_StepType` dump, `capOutput` gave her 0–15,000 and she paged 15,000–28,000
and 27,000–40,000; the `fields` contract sits at offset 25,673 and *"OPENS WITH"* at 25,940.
She had it in front of her. This was not a bounding defect.

**Five findings, four fixed, one of them not previously suspected.**

1. **Instruction.** `resolveFormFields` has accepted `fields` as a `{{template}}` reference
   since the form gate shipped, and `form-gate.test.mjs` covers it in three places. The
   contract never said so, while `reveals` and `options`/`iterator` both document their
   runtime forms. One templated array gives one pre-filled text field per alias — the
   capability she concluded was missing.
2. **Execution.** The contract promised *"an untouched field submits its default (the option's
   `value` for select/radio)"*. `buildInputElement` emitted nothing for `select`,
   `multi_select`, `radio`, `checkbox` or `datetime` — zero hits for `initial_option`,
   `initial_options` or `initial_date_time` anywhere in `src/` or `tests/`. **Sprint 11's
   instruction-twin pattern with the halves reversed:** the artifact promised what the engine
   would not do.
3. **Execution.** Form option sets were unbounded. `list_selection` has guarded Slack's
   100-option cap since it shipped (`callback.mjs`); the form path guarded nothing and L1
   checked field count but never option count. `PGD_Inventory` is at **132 rows**, so an item
   picker over it would have been rejected by Slack outright and the run would have waited on
   a dialog nobody was shown.
4. **Capability, not defect.** Multi-row selection already exists — a `form` gate with a
   `multi_select` or `checkbox` field over `options_key`. `list_selection` is single-pick by
   design and she offered nothing else.
5. **Found while measuring #3, and nobody had filed it.** `getRows` defaults to `limit: 100`
   and reports `count` as rows returned, which reads as a total. **23 `serv_query` steps across
   the registered workflows declare no `input.limit`.** None exceeds the default today once its
   own filters apply — the closest are `help` over `PGC_IntentMap` (91) and
   `budget_vs_expense_report` over `PGD_Expenses` (92) — but both cross 100 with ordinary use.

**A first read of #5 was wrong and is corrected here rather than quietly.** Counting table
totals rather than filtered results produced a claim that `flashcard_quiz_session` could never
draw 288 of 388 cards. Step 4 filters by `deck_id` and the largest deck holds **48**. Nothing
is broken by the new failure; the commit message was amended before the branch was reviewed.

**The decision that shaped the fix.** Runtime degradation and design-time refusal are not
alternatives. The engine caps and *announces* — the widget survives, the block hint names the
true total — because the values are listed nowhere else in a form gate, so a text-box fallback
would leave nothing selectable at all. **L1 is what actually prevents it:** an inline list over
the cap is refused, and so is an `options_key` fed by a query that can return more rows than the
control accepts, found through `writtenByStep`. Where the producing step is a `js_transform`
whose length is genuinely unknowable, it warns rather than refuses.

**AC6's argument now has a specimen.** The deeper problem is not that she was wrong; it is that
a non-technical owner has no external check, and a confidently-stated false limit becomes
folklore cited as fact in the next session. `gate-contract-conformance.test.mjs` is the half
that needs no one present: it parses the field types and the option caps **out of the contract
text** and asserts the renderer honours every claim, so drift fails in `node --test` rather than
in a design conversation. The other half — letting her *check* instead of assume, since
`simulate_workflow` executes nothing and she has never seen a rendered gate — is what AC6 is
about, and this session is the evidence for deciding it.

**Shipped, deployed and verified live.** `sam deploy`, `upsert-step-type.mjs` reporting
`human_gate updated` and 18 unchanged. SERV's three cases confirmed against production rows:
default-limit read of `PGD_Inventory` returns `truncated: true, total_matching: 132`; a
caller-chosen `limit: 5` reports `limit_applied: caller`; an 8-row complete read reports
neither. **1044 → 1079 unit tests.**

**Next:** the inventory correction workflow, built with Novia in a fresh session, with the
templated-`fields` capability and the option caps now in the contract she reads.

**Session 7 addendum — the validator was reviewed after it was written, and two defects found.**
The user's challenge was *"how does L1 know how many items to expect? That code sounds brittle."*
It does not know and does not try — it asks a syntactic question of the step that wrote the key,
never estimating a row count. But the review found two real faults. `writtenByStep` records only
the FIRST writer of a key, so a key written by a bounded query and re-written by an unbounded one
inside a loop would have passed while the gate still broke; every writer is now collected and the
weakest verdict taken. And a limit given as a `{{token}}` failed the literal-number test and was
**refused** — a false positive on a legitimate design, and the one mistake a validator must not
make (see [[feedback_validator_before_workflow]]). Verdicts are now three-valued: **bounded**
(literal limit at or under the cap), **unbounded** (no limit declared, or a literal above it —
refused), **unknowable** (runtime-resolved limit, or a `js_transform` producer — warned). Refusal
is reserved for what the step text makes certain.

**Two limits are documented in the code rather than papered over:** the check follows one hop, so
`query → js_transform → gate` warns rather than refuses; and it ignores filters, so a naturally
small filtered query must still state a limit. Both are deliberate — the alternative is inferring
what a sandboxed expression returns, or reasoning about filter selectivity. Shipped as `0d240a1`
and deployed; 1079 → **1082 unit tests**.

### Session 8 — 2026-09-10 — the memory Novia wrote, and could not find

**Session 1189 saved an approved `review_inventory` design. Session 1195 looked for it twice,
correctly, and told the user it did not exist.** The row was intact throughout — `PGC_Memory`
id 356, 4,509 characters. **Five gaps sat between the write and the read, and any one of them
alone was enough**, which is why the first was not the whole answer.

1. **`deriveScope` let the last `search_domain_help` win.** Session 1189 read up on inventory
   (seq 2), then on recipes (seq 4), then designed against inventory. The memory was filed
   under `recipes`. The `list_tables` and `read_workflow` rules beside it were already guarded
   with `!scope.domain`; the help rule was not. The rule now stated plainly: **an exploration
   tool fills a gap, an authoritative write states the fact.**
2. **The harness replaced her scope rather than merging it, and cannot derive a subject that
   does not exist yet.** Every rule keys off a workflow already registered, read or fixed — so
   her second probe, `scope contains { workflow: "review_inventory" }`, could never have
   matched. `mergeMemoryScope` makes the derived scope the floor and lets every key she states
   win over it. **The one case the harness cannot derive is the one that most needs a scope.**
3. **Both of her memory reads sorted `priority DESC`.** The scale is 1-10 with **lower meaning
   more important** — `arch-memory.md` §4.4, and the direction `memory-client.mjs` has always
   read it in. The reads ranked the least important band first, and the fire-and-forget
   `run_complete` rows sit at 8 precisely so they rank last. Ten of them filled every page of
   the inventory domain. **Nothing needed demoting: the sort was backwards.** The remedy
   proposed before the doc was read — raising her memories above the noise — would have been
   the wrong fix in the right direction, and would have put `minds-eye.mjs` further out of step
   with the canonical retrieval path instead of back in line with it.
4. **The opening context block had the same inversion, plus an ascending `id` tiebreak** — so
   it selected the *oldest* rows of the *least* important band. Every session since June opened
   on the same five `Completed workflow 'add_entity' for domain 'flashcards'` one-liners, under
   a header reading `RECENT MEMORIES`, and nothing written afterwards could ever reach it.
5. **The read tools dropped their own bounding provenance.** `read_memory`, `query_table` and
   `list_capabilities` reshaped `getRows` to `{ count, rows }`, discarding the `limit`,
   `truncated` and `total_matching` fields Session 7 added and verified live. `count` then reads
   as a total: she saw ten rows and reported ten. **Session 7 gave SERV the provenance and the
   agent who most needed it never saw it** — `query_table` is 28 of the 50 tool results that
   have ever exceeded the transcript cap.

**The instruction twin, fixed with the engine.** `minds_eye_system_prompt` v33 said *"Scope is
auto-derived by the harness. Do not include scope in params"*, and framed `write_memory` as
diagnostic reasoning after a change — *"Skip write_memory only if you made no changes"*. **An
approved design for a later session is neither a change nor a diagnosis**, so the instruction
did not cover the thing the user actually asked her to do. v34 states the priority scale, tells
her to name a subject the harness cannot see, and names an approved design as a reason to write.
Tool schemas v8 expose `scope`, `tags` and `priority` — all three of which the tool body has
accepted since it was written, and none of which the schema mentioned.

**Deployed, both context rows upserted, 1082 → 1110 unit tests.** Memory 356 corrected in place
to `{ domain: inventory, workflow: review_inventory }`, priority 3, tags `[workflow_design]`;
`content` and `memory_type` untouched. **Both of session 1195's probes now return it** — the
domain probe at rank 4 of 35 with `truncated` and `total_matching` stated, the workflow probe
directly, and the `run_complete` rows displaced off the first page entirely.

**One thing deliberately not done.** The opening block was not given a recency band. It is
assembled once per round and forms the head of the round's cached prefix, so a band that
reshuffles whenever she writes a memory would forfeit the prefix on the next round of the same
session — the Sprint 10 finding. The corrected scale already fixes what recency was meant to
fix: the June one-liners are gone because they are priority 8, not because they are old.
`created_at DESC` survives as the within-band tiebreak, where it costs nothing.

**`arch-memory.md` reviewed for regression, as asked, and it is what caught #3.** The doc was
silent on the whole minds-eye path — §5 covered the step type and the fire-and-forget writer,
§6 covered `memory-client.mjs`, §14 had no row for any of it — **which is how an inverted sort
lived in a second reader of the same table without contradicting anything written down.** Now:
§4.4 states the scale binds every reader; §5.6 documents the agent write and the derive rule;
§6.4 documents both agent read paths and the provenance requirement; §14 carries three rows.

**Next:** the inventory correction workflow, built with Novia in a fresh session — she can now
be told to recall the design, and the recall works.
