# Sprint 20 — Website usability

**Status: ACTIVE — started 2026-11-22.** Scope and ACs agreed with Javear at "start sprint", from his
usability list after Sprint 19. The prior sprint's retro is `docs/sprints/sprint-19.md`.

**Branch:** `sprint/20-web-usability`

---

## Sprint Goal

**The web is comfortable for everyday editing.** Long text is edited in comfort, on a phone too;
each column shows the label and number format the household chose, set once for every view; most
domain tables — flashcards first — are editable where the household says, a deck moved under
another, a category added and then picked.

---

## Decided at scoping

| Question | Decision |
|---|---|
| **AC — configuring columns** (Javear, 2026-11-22) | Household files now, a web screen later with the page editor. `PGC_Schema.display` — per column `label`, `format`, `hidden` — from `household/display.json` and its upsert script (`--check`, a rerun "no changes"), as `edit-policy.json` is; `GET /sources/{source}/schema` returns it and every view reads it. A panel's own `label`/`format` stays an override. What is editable stays the edit policy |
| **AD — rows of a reference table** (Javear) | Added in that table's own grid, opened by the edit policy (`add_rows`); a drop-down then offers the new row. Decision Y stands: a save never writes a second table |
| **AE — flashcards** (Javear) | Content only. Decks: `title`, `description`, `parent_id`, add and delete. Cards: `deck_id`, `front`, `back`, `tags`, `category`, `source`, add and delete. The review schedule (`interval`, `easiness_factor`, `next_review_date`), the deck counts, `last_review_date` and `PGD_ReviewLog` stay the quiz's; image and audio paths wait for uploads |
| **AF — long text** (Javear) | Expanded in place: a text cell shows one line; focused, it opens a larger text area anchored to the cell (Enter a new line, Escape or leaving closes it); a phone gets it full width |

## Scope

| # | Item |
|---|---|
| **1** | ⬜ **Long text expanded in place** (AF) in the grid and a child grid of a document |
| **2** | ⬜ **The registry's column display** (AC): `PGC_Schema.display` — template, registry seed, `addColumn` (never bootstrap); `household/display.json` and its upsert script; `GET /sources/{source}/schema` returns each column's `label`, `format`, `hidden`; the grid, the document and the record drawer read it, a panel's own an override. Spec first |
| **3** | ⬜ **Number formats** (with 2): `currency` (the row's `currency_column`, or a fixed code), `percent`, a number with fixed `decimals`, `date` — `arch-web-app.md` §6.3 settled at the spec |
| **4** | ⬜ **An entity's grid edits its root table**: an entity's panel (Decks, Spending categories) offers Edit on its grid, saved as its root table's rows, where the policy opens it — needed to move decks and add categories in a grid |
| **5** | ⬜ **A record never becomes its own ancestor**: a table whose foreign key references itself (`PGD_Decks.parent_id`) refuses a parent that is the row or one of its descendants — on the server, for any such table, tested through the route |
| **6** | ⬜ **Most tables editable** (AE): `household/edit-policy.json` extended — flashcards (AE), spending categories, budgets, recurring expenses, inventory and its categories and aliases, ingredients — each table's columns confirmed with Javear at the build. Cards moved between decks from a Cards grid on a household Flashcards page (`household/pages.json`) |
| **7** | ⬜ **Phone scrolling**: on a phone a panel has one vertical scroll — the page's — and a grid scrolls only sideways, so a finger never catches the wrong one |

## Acceptance Criteria

| # | Status | Criterion | Scope | Threshold |
|---|---|---|---|---|
| **AC1** | ⬜ | Javear edits a long text in a grid cell, on desktop and on his iPhone, and saves | 1, 7 | Shown live |
| **AC2** | ⬜ | `household/display.json` gives a column a label, a format and hides another; the grid, the document and the drawer all show it; a rerun of its script writes nothing | 2, 3 | Shown live, and tests |
| **AC3** | ⬜ | A currency, a percent and a fixed-decimal number each show as formatted, in the user's locale | 3 | Shown live, and tests |
| **AC4** | ⬜ | Javear moves a deck under another from the web; making a deck its own ancestor is refused on the server | 4, 5, 6 | Shown live; the refusal tested through the route |
| **AC5** | ⬜ | Javear edits cards' front and back, adds a card and moves one to another deck; no schedule column is offered | 6 | Shown live |
| **AC6** | ⬜ | Javear adds a spending category in its grid, then picks it in an expense's Category drop-down | 4, 6 | Shown live |
| **AC7** | ⬜ | On his iPhone, scrolling a grid never fights the page | 7 | Shown live |
| **AC8** | ⬜ | Each new endpoint or contract change is in `openapi.yaml` first, its own commit, bumping the version; every refusal is tested through its route; every view test is fed a read shaped by a real panel config | all | Review as each lands, and tests |

## Retro lessons to apply (sprint-19)

- **A view's tests are fed a read shaped by a real panel config**, and the order of events a person
  can cause; a read that can be superseded carries its own identity in what it hands on.
- **A layout rule is judged on the household's main domain rendered** before it is recommended, and
  a recommendation states what it costs the sprint's main case.
- **A failure behaviour the design states is built with the first component it covers.**
- **When a design's guarantee rests on infrastructure, the spec names the fact** and it is checked
  before the spec is agreed.

## Out of scope

| Item | Why |
|---|---|
| A web screen to configure columns and the policy; the page editor | Decided (AC): household files this sprint |
| "+ New" inside a drop-down | Decided (AD): a reference table's own grid |
| A card's schedule, image and audio | Decided (AE) |
| An ordered child list (steps) and `display.order_by` | Not on the usability list; `display` makes room for it |
| Logging workflow writes to `PGC_ChangeLog`; soft delete | Sprint 19's decisions stand |

## Session notes

**2026-11-22 (session 1).** Sprint scoped with Javear from his usability list: decisions AC (household
files for column display), AD (reference rows in their own grid), AE (flashcards' content only), AF
(long text expanded in place). Old branches removed — all but main; `cleanup/dead-creation-path`'s
inventory kept on main (`docs/cleanup-creation-path-inventory.md`). Safari's blank screen on Edit,
very likely fixed in Sprint 19 (`7f2bd08`), awaits Javear's check.

**Next (session 2):** item 2's spec first — `PGC_Schema.display` and the formats (item 3), with
`arch-web-app.md` §6.3; then the column, the household file and its script.
