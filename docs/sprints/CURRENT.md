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
| **Versions** | A record's version is its `updated_at`. Every PGD table has one, kept by `set_updated_at` (checked 2026-11-22, all 14 tables); a table without it accepts no direct edits |
| **Names** | The registry says entity (`PGC_EntitySchema`); a person reads *document* |

## Scope

| # | Item |
|---|---|
| **1** | ⬜ **SERV — a grid save in one transaction** (§6.4): changed, new and deleted rows written together; each changed or deleted row conditioned on the version it was read at; `409` naming the rows that moved. Spec first |
| **2** | ⬜ **SERV — a document save** (§6.4): the root and each child collection diffed (insert, update, delete) and written in one transaction, conditioned on the root's version; embeddings refreshed through `resolveEmbedding` as `table.mjs` does. Today's entity writes touch the root only. Spec first |
| **3** | ⬜ **The edit policy** (`arch-home-brain.md` §4.8): `editable` per column and add/delete per table in `PGC_Schema`; `household/edit-policy.json` and its upsert script (`--check`, a rerun "no changes") (Z) |
| **4** | ⬜ **`PGC_ChangeLog`** (AA): template, registry seed, created live through SERV, never bootstrap; one row per direct change, written in the same transaction as the change |
| **5** | ⬜ **PROC — record routes** (`arch-home-brain.md` §4.7), spec first: `GET /domains/{d}/schema`, `…/records`, `…/records/{id}` (with its children), the grid's batch save, the document's save, add and delete. Household role; the policy checked server-side, a request refused whole when any field is not open to it; the web allow-list |
| **6** | ⬜ **Web — the editable grid** (§6.1, §6.2): cell editors from column type, changed cells marked, rows added and deleted where the table allows, one Save; a `409` re-reads and names the rows that moved |
| **7** | ⬜ **Web — the document view** (§6.2): a record picker; the root as a form; child collections as sub-grids, ordered ones (steps) as an ordered list; foreign keys as pickers of existing rows (Y); one Save |
| **8** | ⬜ **Domain pages' records panels** (§4.4): `/d/{domain}` lists its tables and entities, an entity opening as a document |
| **9** | ⬜ **Retire `list`** (X): off the view switch and the page contract; Inventory's panel to `grid` (`household/pages.json`, a new version); `arch-web-app.md` corrected |

## Acceptance Criteria

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | Javear edits several expenses in a grid, adds one and deletes one, saves once; a reload shows the changes | 1, 3, 5, 6 | Shown live |
| **AC2** | ⬜ | Javear opens a recipe as a document, changes a field, an ingredient line and a step, adds a step, saves once; a reload shows the changes | 2, 3, 5, 7 | Shown live |
| **AC3** | ⬜ | A record changed after it was read is refused (`409`) and the grid or document re-reads, naming what moved | 1, 2, 5, 6, 7 | Tests through the route, and once live |
| **AC4** | ⬜ | A field or table the policy does not open is refused whole on the server, and the web offers no edit control for it | 3, 5, 6, 7 | Tests through the route |
| **AC5** | ⬜ | Every direct edit leaves a `PGC_ChangeLog` row with each field's old and new value | 4, 5 | Read back after AC1 and AC2 |
| **AC6** | ⬜ | `/d/recipes` lists the recipes and opens one as a document | 7, 8 | Shown live |
| **AC7** | ⬜ | Each new endpoint is in `openapi.yaml` before it is built, its own commit, bumping the spec's version; every refusal is tested through its route | all | Review as each lands, and tests |
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
table checked for `updated_at` and its `set_updated_at` trigger — all 14 have both.
