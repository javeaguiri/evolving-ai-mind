# Release Readiness — standing workstream

**Not a sprint.** A sprint is time-boxed, carries acceptance criteria, and closes. Release
readiness is a bar that stays raised. It has its own document, its own branch prefix, and its own
cadence so that it competes with nothing.

**Why it is separated (decided 2026-09-22).** Release readiness was deferred in Sprints 7, 8, 9,
10 and 11, then scoped into Sprint 12 as Track B — where it again finished as the least-advanced
track. Five deferrals and one stall, all of them inside a container shared with code and bug-fix
work. The container is the pattern. It now has a second interested party besides the author, which
is an independent reason to track it where someone else can read it.

---

## How this workstream runs

| | |
|---|---|
| **Branch prefix** | `ops/<slug>` — never a `sprint/` branch |
| **Cadence** | Reviewed at **every sprint boundary**, scoped into none |
| **Sprint close checklist gains one line** | *Release readiness reviewed; items moved or explicitly held* — so an item can be deliberately deferred, but never silently |
| **Definition of done for an item** | Demonstrated on one real change, not described |

---

## Status

| # | Item | State |
|---|---|---|
| **R1** | Multiple environments in `template.yaml` | **Open — blocks R2** |
| **R2** | A test environment parallel to prod | Open. Being confirmed 2026-09-22 |
| **R3** | README bootstrap from a clean machine | Open, carried since Sprint 7 |
| **R4** | Log hygiene | Open, carried since Sprint 7 |
| **R5** | Aurora Serverless v2 — **an option, undecided** | Open decision |

---

## R1 — `template.yaml` cannot stand up a second environment

**Read 2026-09-22 against the live file.** Two distinct failure classes, and the second is the
dangerous one.

### Hard collisions — a second stack fails to create

Every one of these is account- or region-global, so a `test` or `dev` stack collides with prod:

| Resource | Line | Literal |
|---|---|---|
| Lambda function names ×4 | 628, 672, 723, 764 | `evolving-mind-ai-slackbot`, `-proc`, `-serv`, `-slack-callback-listener` |
| SQS queue names ×4 | 375, 383, 397, 403 | `SYSSQSSlackResults`, `SYSSQSWorkflow`, + both DLQs |
| API usage plan | 813 | `evolving-mind-ai-usage-plan` |
| IAM role | ~70 | `RoleName: LambdaExecutionRole` |

`LambdaExecutionRole` needs a decision rather than a rename. The final architectural decision is a
**shared execution role**, which is a statement about roles being shared across the four functions
— not about the role being named `LambdaExecutionRole` account-wide. Confirm which reading is
intended before parameterising it.

### Silent coupling — a second stack succeeds, then writes to prod

**This is the risk worth naming.** All **12** SSM references are hardcoded to
`/evolving-mind-ai/...` with pinned versions, including `PGC_DATABASE_URL:4`,
`PGD_DATABASE_URL:3` and `SLACK_BOT_TOKEN`. A dev stack deployed today comes up **green, pointed
at prod's database, posting as prod's Slack bot**. No error and no warning. `DBName` defaults to
`evo_mind` and `DBUser` to `lambda_user` (lines 54–58) for the same reason.

### The fix, and the half that is already done

The pattern is already in the file and simply predates these resources. `SCHEDULER_GROUP_NAME`
(29), the scheduler ARNs (108–109), `SchedulerInvokeRole` (124), the schedule group (154) and
**every Output and Export** (833–864) already use `!Sub '${AWS::StackName}-…'`.

1. Add an `EnvName` parameter (`prod` | `test` | `dev`), defaulting to `prod` so an unparameterised
   deploy keeps today's behaviour.
2. Thread it — or `${AWS::StackName}` — through the four function names, four queue names, the
   usage plan, and `LambdaExecutionRole` once its reading is settled.
3. Move SSM to `/evolving-mind-ai/${EnvName}/…`. **The version pins have to become per-environment
   too** — a fresh environment starts at `:1`, which is the *reset the pins on a fresh install*
   rule from `ops-key-rotation.md`, arriving here for the second time.

### Sharing one database instance

The cheap answer is a **separate database on the same instance** (`evo_mind_test`), selected
entirely by `PGC_DATABASE_URL` / `PGD_DATABASE_URL`. **No code change** — the code addresses tables
as bare `PGC_*` / `PGD_*` names, so nothing needs to know which database it is in.

Separate **schemas** on one database would need `search_path` handling or qualified names in
`table.mjs`, `entity.mjs` and `schema.mjs`. That is the direction reserved for a future
multi-household case; it is not what a test environment needs.

---

## R5 — Aurora Serverless v2: an option, not a decision

**Status: undecided (2026-09-22).** Moved here from the sprint record, where it had been written
up as settled. The measurement below stands and does not need redoing; what is open is whether to
adopt it.

**The case for.** Over the 30 days to 2026-09-20, `PGC_WorkflowRun`, `PGC_WorkflowRunStep` and
`PGC_SessionEntry` timestamps show the database genuinely active for **322 minutes across 95
bursts** — ~5.4 hours a month, measured during heavy sprint work rather than a quiet household
month. Under a 5-minute auto-pause that is ~13 awake hours: **$1.60–$3.19** against the RDS
instance's flat **~$11.70**, with break-even near **97 ACU-hours/month**. Storage is the quieter
win — Aurora bills the **116 MB used**, not the 20 GB provisioned.

**The precondition the architecture already meets, by accident.** Any connection left open
prevents a pause, and an RDS Proxy or pooled client blocks it permanently. `table.mjs` calls
`await client.end()` at eleven sites, nothing is pooled across warm invocations, and there is no
Proxy. **Adding connection pooling or an RDS Proxy later would silently switch the entire saving
off** — that is a constraint, not a note.

**What it costs to adopt.** Four prerequisites, detailed in `docs/backlog.md`:

| | |
|---|---|
| SERV connection retry | One function — `getClient` (`init-brain.mjs:105`) sits behind 52 call sites; `ping-db.mjs:23` bypasses it and must be routed through |
| A resume-tolerant connection timeout | Same function. 5000ms today against a ~15s resume, inside a 29s Lambda budget |
| A heartbeat | >24h paused enters a deeper sleep taking 30s+, exceeding SERV's whole budget. EventBridge → SQS → Lambda → SERV, the path `scheduled-run.mjs` already uses |
| **Encryption at rest** | RDS `StorageEncrypted` is absent and cannot be enabled in place. The migration performs that sequence anyway, so it is **free at the cutover and impossible afterwards**. Third deferral |

**What argues against, and what is new.** Aurora has no free tier, so confirm what credits cover
today before treating the delta as saving. And **R1 changes the arithmetic**: a permanent second
environment is a second 0-ACU floor, so this should be priced for the environment count that
actually results, not for one cluster.

**Interaction with R1 — sequence matters.** A cutover replaces the database endpoint; the
multi-environment work changes how that endpoint is addressed. Doing R1 first means the cutover
touches one parameter path per environment. Doing it second means doing the endpoint work twice.

---

## R2 — R4

**Moved here from Sprint 12's Track B on 2026-09-22**, when it became clear the confirmation this
was waiting on would not arrive soon. Sprint 12's **AC2 is withdrawn, not failed** — the work is
tracked here instead.


**R2, a test environment parallel to prod.** The interim process — *deploy the branch to prod,
validate, then merge* — is what this replaces, and main must always reflect what is running. Once
it exists that flips to *deploy to test → validate → merge → deploy to prod*. **Blocked on R1**: a
test environment stood up on today's template would point at prod's database and Slack token.

**R3, README bootstrap.** A second person, or the same person on a new machine, should be able to
stand the system up from the repository.

**R4, log hygiene.** Carried since Sprint 7.
