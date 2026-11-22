# Sprint 19 — Records on the web

**Status: ACTIVE — started 2026-11-22.** Scope and ACs agreed with Javear at "start sprint". The
next slice of `docs/arch-web-app.md` (v0.10) §10 Phase 1 — §6, domain views — with the edit policy
of `docs/arch-home-brain.md` §4.8. The prior sprint's retro is `docs/sprints/sprint-18.md`.

**Branch:** `sprint/19-web-records`

---

## Sprint Goal

**The household views and edits records on the web.** A table is edited in a grid, an entity — a
recipe — as one document, each saved at once and never over a change a workflow made since it was
read. Why now: Novia's `plan_meals` (session 1381) needs several recipes to choose from, and Javear
needs to see and correct them on the web.

---

## Decided at scoping

| Question | Decision |
|---|---|
| **X — the `list` view** | Retired. A grid naming two or three columns gives the same compact rows on a phone, and the document view takes "open a record". Off the view switch; Inventory's panel moves to `grid` |
| **Y — a new ingredient from a recipe's document** | Existing only: an ingredient line picks from `PGD_Ingredients`. New ingredients come in through `add_recipe` or Novia; a document never writes a second table |
| **Z — who writes the edit policy for existing domains** | The household's: a committed `household/edit-policy.json`, pushed by an upsert script with `--check`, as `domains.json` is. Nothing is editable until declared (§4.8's default) |
| **AA — the change log** (Javear: more general than a record-edit table) | `PGC_ChangeLog` in place of the designed `PGC_RecordEdit`: one row per change to a record — who (`actor`), how it came (`via`), a nullable `run_id`, the domain, table and record, the operation, each field's old and new value. Shaped for any source; this sprint writes the web's direct edits only — workflow writes stay traced by their run steps until logging them is wanted. Column names settle at the spec |
| **AB — where the edit policy lives** (Javear, 2026-11-22) | Its own table, `PGC_EditPolicy`, one row per `PGD_` table: `columns` (`{ "<col>": true }`), `add_rows`, `delete_rows` (renamed from `add`, `delete` by Javear 2026-11-22: runSql's guard refuses the word DELETE) — not inside `PGC_Schema`, which describes a table's shape shared by every home. Kept open for tenancy (a `tenant` column: none is a domain's default, a home's row overrides) and for roles (`true` becomes a list of roles); checked by one pure function given the whole principal; system-maintained columns never opened by any row. `arch-home-brain.md` §4.8 corrected |
| **The save shapes** (Javear, 2026-11-22) | `withVersion` on `getRows` and `getEntity` gives each row `_version`, `updated_at::text`; `getEntity` then also returns `children` by table name — a joined table whose registered foreign key references the root. `POST /serv/table/saveRows` and `POST /serv/entity/saveEntity`: rows read `FOR UPDATE`, versions compared, `409 version_conflict` naming the rows, nothing written. Any document save touches the root's `updated_at`, so the root's version is the document's. SERV writes `PGC_ChangeLog` in the same transaction from a `changeLog` the caller passes (`actor`, `via`, `runId`, `domain`), one `batch_id` per save |
| **Versions** (Javear, 2026-11-22: stay with `updated_at`) | Optimistic locking: read without a lock, the version sent back with the save, checked under a short `FOR UPDATE` inside the save's transaction — which also yields the old values for the change log. An integer `row_version` per table was offered (no clock in the question) and not chosen: `set_updated_at` sets `now()`, the transaction's start, and a miss needs a write whose transaction began in the microsecond that made the version read. A record's version is its `updated_at`. Every PGD table has one, kept by `set_updated_at` (checked 2026-11-22, all 14 tables); a table without it accepts no direct edits |
| **Names** | The registry says entity (`PGC_EntitySchema`); a person reads *document* |

## Scope

| # | Item |
|---|---|
| **1** | ✅ **SERV — a grid save in one transaction** (§6.4): changed, new and deleted rows written together; each changed or deleted row conditioned on the version it was read at; `409` naming the rows that moved. Spec first. **Spec ✅** (3.12.0: `saveRows`, `withVersion` on `getRows`). **SERV ✅ 2026-11-22** — `saveRows` and `withVersion` in `table.mjs`, tested through the route (`serv-save-rows.test.mjs`); deployed 2026-11-22 (`sam deploy`; smoke: a refusal and a versioned read, nothing written) |
| **2** | ✅ **SERV — a document save** (§6.4): the root and each child collection diffed (insert, update, delete) and written in one transaction, conditioned on the root's version; embeddings refreshed through `resolveEmbedding` as `table.mjs` does. Today's entity writes touch the root only. Spec first. **Spec ✅** (3.12.0: `saveEntity`, `withVersion` and `children` on `getEntity`). **SERV ✅ 2026-11-22** — in `entity.mjs` on the shared `row-writes.mjs` (Javear: a children-only save needs `allow_update` on the root; a new entity's children insert only; children read whole), tested through the route (`serv-save-entity.test.mjs`); deployed 2026-11-22 (smoke: a refusal and Recipe 5 read as a document, nothing written) |
| **3** | ✅ **The edit policy** (`arch-home-brain.md` §4.8): `PGC_EditPolicy` (AB) — open columns and add/delete per table; template, registry seed, created through SERV; `household/edit-policy.json` and its upsert script (`--check`, a rerun "no changes") (Z). **DONE 2026-11-22** — table live (registry 20/20); `src/proc/edit-policy.mjs` `planEditPolicies`; `dev_scripts/upsert-edit-policy.mjs`; the household's policy written (Expenses add/delete; a recipe's fields; its ingredient lines and steps add/delete — Javear), rerun "no changes", a bad file refused whole. The check on the direct path comes with item 5 |
| **4** | ✅ **`PGC_ChangeLog`** (AA): template, registry seed, created live through SERV, never bootstrap; one row per direct change, written in the same transaction as the change. **Table ✅ live 2026-11-22** (`createTable`, `PGC_TableMap.allow_update` set false, registry `--check` 19/19); written by `saveRows` through the save's own connection — PGC and PGD are one database (Javear, 2026-11-22). `saveEntity` writes it too (item 2) |
| **5** | ✅ **PROC — record routes** (`arch-home-brain.md` §4.7), spec first: `GET /domains/{d}/schema`, `…/records`, `…/records/{id}` (with its children), the grid's batch save, the document's save, add and delete. Household role; the policy checked server-side, a request refused whole when any field is not open to it; the web allow-list. **Built 2026-11-22, not yet deployed** — on `/sources`, not `/domains` (Javear): spec 3.13.0; `…/schema`, `…/rows?with_version`, `POST …/rows`, `GET`/`POST …/records/{id}`, `POST …/records`; `policyRefusals` refuses whole (`403 not_editable`, each part named); `409` passed on with `conflicts` through `WebError`; five routes on the web allow-list; `source-records.test.mjs`. **Deployed 2026-11-22** — smoke through PROC, nothing written: Recipe's schema (12 root fields open, its two children with `recipe_id` as parent key, `ingredient_id` → `PGD_Ingredients`), a versioned Expenses read, a save refused whole (`add_rows`, `created_at`) |
| **6** | ✅ **Web — the editable grid** (§6.1, §6.2): cell editors from column type, changed cells marked, rows added and deleted where the table allows, one Save; a `409` re-reads and names the rows that moved **Built and deployed 2026-11-22** (`deploy-web.mjs`; Money page v5) — edit mode in the records panel's grid: Edit where the schema opens something, editors by column type, a foreign key a drop-down of existing rows by label (Javear: never a typed id) and shown by label in view mode too, changed cells marked, + Add row / × remove where allowed, one Save; a refusal named, a `409` naming the rows that moved, their edits dropped, the rows read again. The Money page's expenses panel gains Currency and Category (`household/pages.json`, Money v5). Fixed live 2026-11-22 (`f635d28`): edit mode read a panel's named columns without `id`, so one row's edit showed on every row (Javear, nothing saved) — edits now read `id` with the versions. AC1 met live; a text cell saved with its trailing space (`EUR `) fixed by trimming (`20abaa7`) |
| **7** | ✅ **Web — the document view** (§6.2): a record picker; the root as a form; child collections as sub-grids, ordered ones (steps) as an ordered list; foreign keys as pickers of existing rows (Y); one Save **Built 2026-11-22** — the records panel's Document view for an entity: a record picked by label, its root a form (text a text area, keys drop-downs by label), each child table a grid with + Add row and × where allowed (Javear: steps a grid with `step_number` until `display.order_by`), one Save; a conflict drops only edits to what moved — root fields compared — and names it, an ingredient line by its ingredient. Each panel now inside an error boundary (Javear) — Safari's blank screen on Edit will show its error. AC2 on item 8's `/d/recipes` (Javear) |
| **8** | ✅ **Domain pages' records panels** (§4.4): `/d/{domain}` lists its tables and entities, an entity opening as a document **Built and deployed 2026-11-22** (smoke: `/domains/recipes` — Recipes as an entity, Ingredients, Recipe ingredients, Recipe steps) — spec 3.14.0 `GET /domains/{domain}` (`proc/domains.mjs`): an entity with child tables replaces its root, every other table and view its own panel, child tables included (Javear); `/d/{domain}` draws them after its workflows (`DomainRecords.jsx`); an entity's row opens as a document Corrected on Javear's first look (spec 3.14.1): a recipe's lines and steps showed both in its document and as flat panels — a child table is now its own panel only if itself an entity's root (expenses stay); the record picker read as an editable field — now a navigator (*← All recipes*, *Open ▾*); unconfigured panels showed `id` and timestamps — hidden (§6.1). Deployed 2026-11-22 (smoke: `/domains/recipes` — Recipes, Ingredients) |
| **9** | 🟡 **Retire `list`** (X): off the view switch and the page contract; Inventory's panel to `grid` (`household/pages.json`, a new version); `arch-web-app.md` corrected **Built and deployed 2026-11-22** — spec 3.14.2: a records panel's view is grid or document, `detail_columns` gone, `title_column` kept (it titles a record); PROC's page contract refuses `list`; the web app draws no list and shows the view switch only for an entity (Grid, Document); Home's stock panel to the grid (`household/pages.json`, Home v5); `arch-web-app.md` corrected. Deployed 2026-11-22 (web; no Lambda code changed — the page contract runs at write, in `upsert-page.mjs`); every live records panel opens on the grid |

## Acceptance Criteria

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ✅ | Javear edits several expenses in a grid, adds one and deletes one, saves once; a reload shows the changes | 1, 3, 5, 6 | Shown live — met 2026-11-22: one save, 3 updates (amount, category by drop-down, title), 1 insert, 1 delete; `PGC_ChangeLog` batch `ec0c4265` |
| **AC2** | ✅ | Javear opens a recipe as a document, changes a field, an ingredient line and a step, adds a step, saves once; a reload shows the changes | 2, 3, 5, 7 | Shown live — met 2026-11-22: Recipe 9 saved once — a field, an ingredient line (by drop-down) and two steps changed, an ingredient line added in place of a step (Javear accepted: the same child-insert path); batch `f53a9cb7` |
| **AC3** | ✅ | A record changed after it was read is refused (`409`) and the grid or document re-reads, naming what moved | 1, 2, 5, 6, 7 | Tests through the route, and once live — met 2026-11-22: tested through the routes (`serv-save-rows`, `serv-save-entity`, `source-records`, `web-records-edit`, `web-document`); live, expense 376 changed in Slack (run 1077) while open in the grid — the web's save refused `version_conflict` naming it, the rows read again, the amount re-entered and saved against Slack's version (51 → 50, batch `b9f8abd7`) |
| **AC4** | ✅ | A field or table the policy does not open is refused whole on the server, and the web offers no edit control for it | 3, 5, 6, 7 | Tests through the route — met 2026-11-22: refused whole on the server, tested through the route (`source-records.test.mjs`; live, a save refused `add_rows` and `created_at`); the grid and the document draw a closed field as read, never a control (`web-records-edit`, `web-document` tests) |
| **AC5** | ✅ | Every direct edit leaves a `PGC_ChangeLog` row with each field's old and new value | 4, 5 | Read back after AC1 and AC2 — met 2026-11-22: the grid's save (batch `ec0c4265`) and the document's (`f53a9cb7`) each logged every row, old and new values, actor, `via: web`, domain |
| **AC6** | ✅ | `/d/recipes` lists the recipes and opens one as a document | 7, 8 | Shown live — met 2026-11-22: `/d/recipes` lists Recipes and Ingredients; a recipe's row opens it as a document |
| **AC7** | 🟡 | Each new endpoint is in `openapi.yaml` before it is built, its own commit, bumping the spec's version; every refusal is tested through its route | all | Review as each lands, and tests |
| **AC8** | ⬜ | No view switch offers `list`; Inventory's panel opens as a grid | 9 | Shown live |

## Retro lessons to apply (sprint-18)

- **A spec-first commit bumps the version it changes.**
- **A route that refuses is tested through the route,** against a stubbed read, in the commit that
  adds it.
- **Copy a timestamp as text, never through a JS `Date`** — versions are `updated_at` to the
  microsecond, so a version passed through a `Date` never matches.
- **When a sprint touches `/ui/slack`, a gate run in Slack is part of its live checks.**
- **A polling client multiplies concurrency** — the quota is 1000 now; a new poll is still counted.

## Out of scope

| Item | Why |
|---|---|
| The page editor, `chart`/`metric` panels, *Ask Novia about this* | Phase 1, a later slice |
| `display` metadata in the registry (§6.3) | Page config keeps labels and formats; an entity opens as a document by rule |
| Creating a referenced row from a document (a new ingredient) | Decided (Y): existing only |
| Logging workflow writes to `PGC_ChangeLog` | Decided (AA): direct edits first |
| Novia writing the edit policy | The household's file this sprint (Z) |
| The Slack pager, WebSocket, the custom domain | Not this slice |

## Session notes

**2026-11-22 (session 1).** Sprint scoped with Javear: decisions X (retire `list`), Y (existing
ingredients only), Z (the household's edit-policy file), AA (`PGC_ChangeLog`, general). Every PGD
table checked for `updated_at` and its `set_updated_at` trigger — all 14 have both. Decision AB
(`PGC_EditPolicy`) and the save shapes agreed; spec 3.12.0 written with the design docs
(`arch-data.md` §4.3.7 `PGC_ChangeLog` and `PGC_EditPolicy` replacing `PGC_RecordEdit`,
`arch-home-brain.md` §4.8, `arch-web-app.md` §6.3–6.4).

**2026-11-22 (session 2).** Found PGC and PGD addressed separately but one database (`evo_mind`);
Javear: the log goes through the save's own connection. `PGC_ChangeLog` created live; its
`PGC_TableMap` row set append-only (`allow_update` false) with one `updateRows`, no upsert script
covering TableMap. `saveRows` and `withVersion` built and tested through the route. The lock query's
read checked live, read-only, on `PGD_Recipes`.

Deployed (`sam deploy`); the two seed changes were already live through `createTable`.

Item 2 built: `saveRows`' lock, version check, writes and log moved to `row-writes.mjs` (a
behaviour-neutral commit of its own), then `saveEntity` and `getEntity` `withVersion` on it. The
grouped root read with `_version` checked live, read-only. The backlog's *Novia creates domains*
item now has her procedure set a new domain's edit policy (Javear).

Item 3 done: `PGC_EditPolicy` live with the household's policy; its flags renamed `add_rows`,
`delete_rows` (Javear: runSql's guard refuses DELETE). Expenses' grid delete is a hard delete —
soft delete is not this sprint (Javear).

Item 5 built and deployed on `/sources`, not `/domains` (Javear): spec 3.13.0, the policy checked in
PROC and a request refused whole, `409` carried to the browser with its `conflicts`.

**Retro note:** Edit crashed a panel (Javear, during the AC3 run; very likely Safari's earlier
blank screen): the next page of the old read, asked for as Edit began, arrived before the new read
and was added to rows not yet there — the page was tied to the newest read's number, not its own.
Fixed: a page joins only the read it continues (`addPageTo`). A read that can be superseded
carries its own identity in what it hands on.

**Retro note:** the grid's first live edit marked every row — the panel read named columns
without `id`, and the tests' rows always had one. A view test is fed a read shaped by a real panel
config, not a hand-made row.

**Next:** Javear's AC1 run on the editable grid, then item 7.

**Earlier plan:** item 2 (`saveEntity`, `getEntity`
`withVersion` and `children`).

**Previously (session 2's plan):** item 1. First `PGC_ChangeLog` — template, `seed_PGC_Schema.json`, created
live through SERV `createTable` (never bootstrap). Then `withVersion` on `getRows` and `saveRows`
in SERV per spec 3.12.0, tests through the real route against a stubbed database client: a clean
save, a conflict rolling everything back, each refusal, the log rows. Unit tests before push.

