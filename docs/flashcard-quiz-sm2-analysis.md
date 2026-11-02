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
| F2 | 14–16 | A card failed and then passed on its in-session retry is graded twice, and the retry is scored from the stale `current_card` loaded at step 4 — step 16 updates the row, not `local_state` — so a due card at interval 6, EF 2.5 graded 2 then 4 ends at **interval 15, EF 2.5**: the failure is wiped out. A second `PGD_ReviewLog` row is written. *(Corrected 2026-11-02 from Novia's review in session 1284; the first reading assumed the retry started from interval 1 and predicted interval 6, EF 2.18.)* | The first answer of a session sets the schedule; the retry is drill and moves nothing |
| F3 | 14 | A grade below 3 changes `easiness_factor` (2.5 → 2.18 for a 2) | A failure restarts the repetitions and leaves `easiness_factor` unchanged |
| F5 | 17 | The in-session retry stops at grade 3 or more *(Novia, session 1284)* | SM-2 repeats an item in the session until it scores 4 or more |
| F6 | — | `PGD_Decks` statistics (`card_count`, `due_count`, `last_review_date`, `learned_count`) are never updated and have drifted — deck 17 shows 0 cards and holds 45; step 3's reveal shows them *(Novia, session 1284)* | Kept current, or computed when shown |
| F7 | 20 | The completion message reports `all_cards.length`, not the reviews done *(Novia, session 1284)* | The number reviewed |
| ~~F4~~ | 14 | ~~`interval` stands in for the repetition count, so the first pass after a failure jumps to 6 days~~ **Withdrawn 2026-11-02:** a failure leaves the card at interval 1, and the next successful review is SM-2's second repetition — 6 days — which is what `interval` 1 → 6 gives. No column is needed | — |

F1 and F2 match the report — F2 more severely than first read, since a failed card ends further out than before it failed: the whole deck every session, and a card answered wrong coming back in
fifteen days instead of one.

## 2. Reference test

**Sandbox:** `PGD_Cards` filtered to four cards of one deck (its `PGD_Decks` row follows as an FK
parent); `PGD_ReviewLog` empty. The four cards' state set with sandbox writes:

| Card | Starting state | Answer | SM-2 expects after the run | v3 is expected to give |
|---|---|---|---|---|
| A — new | interval 0, EF 2.5, never reviewed | 5 | interval 1, EF 2.6, due in 1 day | as SM-2 |
| B — due | interval 6, EF 2.5, due yesterday | 2, then 4 on the retry | interval 1, EF 2.5, due in 1 day, one log row | interval 15, EF 2.5, two log rows (F2) |
| C — not due | interval 6, EF 2.5, due in 5 days | — | not asked; unchanged | asked (F1) |
| D — young | interval 1, EF 2.5, due today | 3 | interval 6, EF 2.36, due in 6 days | as SM-2 |

**At every grading gate:** the card's front in the message, its back in the reveal, no literal
`{{…}}`. **After the run:** `PGD_Cards` and `PGD_ReviewLog` read in the sandbox and compared with the
table; household rows unchanged.

**Covered with no workflow change:** pass, fail-then-retry, and not-due. **Not covered:** shuffle
order and rollover past a subset of 10 — an uncommitted test copy with `subset_size: 2` covers the
rollover with the same four cards.

## 3. Test run 955 (Novia, session 1284, 2026-11-02)

Sandbox: all decks; cards and review log empty; a QA Deck with three cards. Confirmed: F2 — card A
graded 1 (saved interval 1, EF 1.96), then 4 on the retry, saved **interval 15, EF 2.50**, its log row
recording `interval_before` 6, `EF_before` 2.50; F1 — card C, ten days from due, quizzed and moved
15 → 35 days; F6 — the QA Deck's stats untouched after four reviews; F7 — "You reviewed 3 cards"
after four. Correct: card B, new, graded 5 → interval 1, EF 2.6; the retry came back at the end of
the round; every gate rendered with no literal `{{…}}`. Household rows identical before and after.

**Fixes recommended to Javear:** the in-session retry changes no schedule (only the session's first
answer counts — her first wording would have scheduled a just-failed card at 6 days); due or
never-reviewed cards only; mastery at grade 4; deck counts computed when the picker is shown rather
than stored, since cards are added outside the quiz; the end message counts reviews.

## 4. Fixed in v4 and retested (runs 956, 957)

Javear approved all five fixes and chose *Apply and test*. Novia's v4 (24 steps): step 4 loads only
the quiz's columns; step 5 keeps due or never-reviewed cards; a failed card is re-queued carrying
the schedule just written and flagged `is_retry`, and step 14 leaves a retry's schedule unchanged;
step 17 keeps a card in the session until it scores 4; new steps 20a–20c recount the quizzed deck's
stats; step 20 reports reviews, first-time recalls, retries and cards still due. Fix 4 recounts at
the end of a quiz rather than when the picker is shown, so a deck not quizzed keeps its stored
numbers; she corrected the 12 child decks' stats in household data once, as offered.

**Run 956** (fresh sandbox, same three cards): A graded 1 then 4 → interval 1, EF 1.96, due the next
day, its retry's log row recording 1 / 1.96; B graded 3 then 5 → interval 1, EF 2.36, the 3 forcing a
retry; C not offered and unchanged; QA Deck 3 cards, 0 due, 3 learned; summary 2 studied, 4 reviews,
0 first time, 2 retried, 0 of 3 due. **Run 957** on the same deck: "Nothing is due in QA Deck right now.
Next card due: 2026-11-03", no review written. Household cards, review log and deck stats identical
before and after.

## 5. Open

- **Deck stats drift for decks that are not quizzed.** v4 recounts a deck's `card_count`, `due_count`,
  `learned_count` and `last_review_date` at the end of a quiz on that deck, and Novia corrected all
  12 child decks once. Cards added by any other path (`add_entity`, imports) leave the stored numbers
  stale until that deck is next quizzed; the parent decks show 0. Computing the counts when the
  picker is shown would remove the drift — a change to `flashcard_quiz_session` steps 1–2, made only
  if the stale numbers bother Javear.
