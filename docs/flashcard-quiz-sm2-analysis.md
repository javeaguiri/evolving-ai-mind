# Flashcard Quiz — Spaced Repetition Analysis

**Workflow:** `flashcard_quiz_session` (v3, 21 steps, domain `flashcards`)
**Date:** 2026-11-02 — read from the live workflow; not yet confirmed by a run
**Reported by:** Javear — cards are not retested the way the spaced repetition design intends
**Sprint 15 use:** AC4's live vehicle. Novia tests the workflow as it stands, fixes it, and retests;
her test plan is judged against §2.

---

## 1. Findings

| # | Step | What the workflow does | SM-2 expects |
|---|---|---|---|
| F1 | 4 | Loads every card in the selected deck, ordered by `next_review_date`; step 6 ends the session only when all of them are passed | Only cards that are new or due — `next_review_date` null or not after now — are quizzed |
| F2 | 14–16 | A card failed and then passed on its in-session retry is graded twice: the retry reschedules it (failed → interval 1 → passed → interval 6) and writes a second `PGD_ReviewLog` row | The first answer of a session sets the schedule; the retry is drill and moves nothing |
| F3 | 14 | A grade below 3 changes `easiness_factor` (2.5 → 2.18 for a 2) | A failure restarts the repetitions and leaves `easiness_factor` unchanged |
| F4 | 14, `PGD_Cards` | `interval` stands in for the repetition count (0 → 1, 1 → 6, otherwise interval × EF), so the first pass after a failure jumps to 6 days | After a failure the count restarts — 1 day, then 6 — which needs a repetition count `PGD_Cards` does not have |

F1 and F2 match the report: the whole deck every session, and a card answered wrong coming back in six
days instead of one. F4 is a contract question (a missing column), decided before it is fixed: add a
repetition count, or accept the jump.

## 2. Reference test

**Sandbox:** `PGD_Cards` filtered to four cards of one deck (its `PGD_Decks` row follows as an FK
parent); `PGD_ReviewLog` empty. The four cards' state set with sandbox writes:

| Card | Starting state | Answer | SM-2 expects after the run | v3 is expected to give |
|---|---|---|---|---|
| A — new | interval 0, EF 2.5, never reviewed | 5 | interval 1, EF 2.6, due in 1 day | as SM-2 |
| B — due | interval 6, EF 2.5, due yesterday | 2, then 4 on the retry | interval 1, EF 2.5, due in 1 day, one log row | interval 6, EF 2.18, two log rows (F2, F3) |
| C — not due | interval 6, EF 2.5, due in 5 days | — | not asked; unchanged | asked (F1) |
| D — young | interval 1, EF 2.5, due today | 3 | interval 6, EF 2.36, due in 6 days | as SM-2 |

**At every grading gate:** the card's front in the message, its back in the reveal, no literal
`{{…}}`. **After the run:** `PGD_Cards` and `PGD_ReviewLog` read in the sandbox and compared with the
table; household rows unchanged.

**Covered with no workflow change:** pass, fail-then-retry, and not-due. **Not covered:** shuffle
order and rollover past a subset of 10 — an uncommitted test copy with `subset_size: 2` covers the
rollover with the same four cards.
