# Sprint 4 — Planning

**Sprint 3 closed 2026-05-31. See `docs/sprints/sprint-03.md` for retro.**

**Branch:** TBD — create at sprint open.

---

## Carry-in from Sprint 3 (do before scoping Sprint 4)

These were deferred from the sprint close checklist and must be done at Sprint 4 start:

- [ ] `docs/architecture.md` — add memory layer: `memory-client.mjs`, `llm-harness.mjs`, `memory-writer.mjs`, `MEMORY_WRITE` SQS type, `write_memory` step type
- [ ] `docs/data-architecture.md` — add `PGC_Memory` table schema, `memory_config` column on `PGC_Prompt`
- [ ] `README.md` — update for Sprint 3 additions

---

## Sprint 4 Candidate Tracks (not yet scoped)

From backlog and sprint-03 retro carry-forwards:

1. **B AC3** — validate fresh `create_workflow` for flashcards references correct column names on first attempt (domain_schema injection working)
2. **Domain propagation systemic audit** (backlog task 12) — 3 occurrences in 2 sprints; full boundary audit + test coverage
3. **Skeleton-first workflow generation** — split `generate_workflow_steps` into routing frame + per-step fill (high priority, Sprint 4 track)
4. **IntentMap invocation phrasing gate** — add human_gate to `create_workflow` asking user how they want to invoke the workflow
5. **Richer episodic memory content** — distil session outcomes (score, card counts) in `memory-writer.mjs`
6. **History threading (Track H)** — `use_run_history` on llm_call steps; budget-trimmed prior turn reconstruction
7. **Domain data initialization** — capture initial-value conventions from `create_domain` for downstream workflows

---

## Session Notes

**2026-05-31 (session 8):** Sprint 3 closed. Quiz e2e validated (runs 403–405, 13-card Test Set, all mastered, G3 episodic memory written). Eight harness fixes shipped:
- `evalExpression` in `template-resolver.mjs` — arithmetic in `{{}}` tokens
- `description_list` suppressed when no option descriptions
- Confirm gate HELP-specific fallback removed
- `chat.update` replaces stale buttons (response_url was null in practice)
- `classify-intent.mjs` passes `domain` to all WorkflowRun inputs
- Pass 1a domain resolution via substring match for freely-named workflow intents
- IntentMap pattern for `quiz_flashcards`: `quiz.*flashcard|flashcard.*quiz`
- `.claude/settings.json` — added `Bash(cp *)`
- Hello convention updated: 3 health checks + diagnostic framework (system vs artifact, extend harness)
- Backlog task 12 updated with domain propagation systemic pattern
- Credentials rotation needed before sharing transcripts with Claude engineers
