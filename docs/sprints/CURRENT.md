# Sprint 10 — NOT YET SCOPED

**Status: awaiting scope.** Sprint 9 closed 2026-08-06. Retro phase ✅ (see
`docs/sprints/sprint-09.md` §RETRO). **Scope, branch and acceptance criteria still to be agreed
with the user** — the candidates below are the carry-forward position, not a plan.

> Read before scoping: `docs/sprints/sprint-09.md` §RETRO, `docs/backlog.md`, and
> `docs/arch-minds-eye.md` §12.7 — OQ1 is now answered and OQ6 closed; OQ5 is partly answered.

---

## Where Sprint 9 left the system

Novia can design, simulate and register a workflow from a Slack conversation with no
`create_workflow` involvement. What she cannot yet do unaided is **repair** one — and the two
things standing in the way of finding out are both diagnosed and unbuilt.

Three ACs did not close, and they are not independent:

| Carried | Why it did not close | Unblocked by |
|---|---|---|
| **AC5** second half — `edit_budget` runs end-to-end through the Novia path | the runtime needed repairs made outside that path | AC8 |
| **AC6** — session compression at the turn-limit gate | a round dies at the 240s Lambda ceiling before reaching the gate | the transcript fix |
| **AC8** — Novia repairs `edit_budget` step 5 unaided | deferred for measurement validity, not time | the transcript fix |

**The transcript prefix-cache fix is the unlock for all three**, which is why it is the lead
candidate rather than merely the cheapest.

---

## Candidate scope — to be confirmed, not assumed

### Lead candidate — the transcript prefix-cache fix

A cache-invalidation defect in our own code, not a gateway limitation. Two things in
`minds-eye.mjs` break the prefix every turn: `buildUserMessage` orders `input` as volatile
context → transcript when the transcript is the append-only part, and `assembleContext` runs
`ORDER BY priority DESC LIMIT 5` on `PGC_Memory` with no tiebreaker while 35 of 100 rows tie at
priority 8. Three-part fix, all system code, none dependent on Perplexity. Expected ~12× cut on
the creation component. **Needs a live Slack round to validate — the user runs it.**

### Sequenced behind it, validating in the same round

- **A5** — `run_sql` physical table names (`list_physical_tables` first; double-quote CamelCase
  identifiers). Context/prompt content, no code.
- **AC8 / Track D** — hand Novia `edit_budget` with the symptom only. D1 (`{{selected_period.N}}`
  on a string) is now caught by L1, so the specimen may need reconstructing; D2 and D3 stand.
- **AC6** — round budget and session compression, once turns are cheap enough to reach the gate.

**One round can validate the fix, A5 and AC8 together** — the signals read from different places
and do not confound: the cache effect from `cache_read`/`cache_creation` in the usage logs, A5
from whether any `run_sql` call fails on an identifier, AC8 from whether she reaches the defect.

### Independent of the above

- **`create_domain` derived-field maintenance** — `card_count`, `learned_count`, `due_count` and
  every denormalized column it will ever generate. Contract fault at the `create_domain`
  boundary. Sequence *do not denormalize* first.
- **Release-readiness** — test environment, README bootstrap, log hygiene. **Preempted in
  Sprints 7, 8 and 9.** If it is deferred a fourth time, that should be a decision rather than an
  outcome.
- **C4** — the literal `**` in a gate message (run 735); still needs a repro to pin the block path.

---

## Open decisions for scoping

1. **Does the `create_workflow` dissolution decision get taken this sprint?** §12.7 OQ1 is
   answered but unfavourable, and explicitly says the decision should not be taken on that number
   as it stands. Re-measuring needs the transcript fix first.
2. **Release-readiness — in or out?** Three deferrals is the argument for scoping it deliberately
   this time, including the part where a test environment would have made the Sprint 9 deferrals
   unnecessary.
3. **Archetypes** — parked in Sprint 9 behind the framing rule, to be revisited "with evidence
   from real builds". One build now exists. Whether it constitutes evidence is a scoping call.
