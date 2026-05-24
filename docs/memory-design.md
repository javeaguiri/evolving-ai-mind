
The Core Gap: Accumulated Context Has No Home

Right now every LLM call in evolving-mind-ai starts with a blank slate except for what’s in PGC_SystemContext (static) and the current workflow’s local_state (ephemeral, dies with the run). There’s nowhere for knowledge to accumulate and be retrieved across runs, domains, and workflows.

What you’re describing is essentially a memory layer — a place where insights from one interaction become available to future ones. Humans call this learning.

Three Types of Memory — Three Problems Solved

Episodic memory — what happened

A log of significant user activities. “User completed a Spanish flashcard session with 80% accuracy.” “User reviewed portfolio performance.” Each workflow run that touches user data writes a short episodic summary. When /chat is invoked, recent relevant episodes are injected as context so the conversation feels like it’s with someone who knows your life.

This directly solves your companion awareness problem.

Semantic memory — what was learned

Insights and design decisions produced by LLM interactions. When create_domain designs a schema, the reasoning behind key decisions (why a junction table was used, why certain columns were typed a certain way) is stored and scoped to that domain. When create_workflow later runs for the same domain, those semantic memories are injected — the second LLM inherits the first LLM’s understanding.

This solves your cross-LLM pollination problem.

Procedural memory — why things work the way they do

Design intent behind workflows and prompts. When create_workflow produces a workflow, a structured record of its design rationale is written — what the workflow is trying to accomplish, what constraints shaped its structure, what alternatives were considered. When fix_workflow runs, it retrieves the procedural memory for that workflow and injects it. The repair LLM now knows the original intent, not just the broken code.

This solves your repair context problem.

The Architectural Shape

One new system table: PGC_Memory.

memory_type:  'episodic' | 'semantic' | 'procedural'
scope:        'global' | 'domain:Recipes' | 'workflow:create_domain'
content:      text  (the memory itself, written in plain language)
source_run_id, source_workflow, source_step
tags:         jsonb  (for retrieval matching)
created_at
(future) embedding: vector(1536)  — pgvector retrieval


Writing memories is a right-brain activity — a lightweight LLM call (or structured Option A output field) at the end of significant workflow steps that distils what was learned into a memory record.

Reading memories plugs directly into the existing PGC_SystemContext injection pattern already in executeLlmCall. Before calling the LLM, query PGC_Memory for records matching the current scope (domain, workflow name, tags) and inject them alongside the static system context. No new injection mechanism needed — the slot already exists.

Retrieval starts as simple scope + tag matching (deterministic, no AI needed). pgvector semantic search is the natural upgrade path once the memory corpus grows — already on your roadmap and fits perfectly here.

Memory Creation Is a Right-Brain Step

The Option A reasoning field you’re already planning to capture in PGC_SessionEntry is the raw material. A memory consolidation step at the end of key workflows reads the reasoning fields and distils them into PGC_Memory records. This is exactly right-brain behaviour — awareness, synthesis, surfacing relevant knowledge — as opposed to the left-brain deterministic execution.

The important constraint: memory creation must never block the workflow execution loop. It’s a fire-and-forget side effect, like the diagnostic Slack notification in your session design.

What This Looks Like in Practice

create_domain runs for "Recipes"
  → LLM designs schema with reasoning
  → On completion: right-brain memory step writes
    { type: 'semantic', scope: 'domain:Recipes',
      content: 'Chose a junction table PGD_RecipeIngredients because
                recipes have a many-to-many relationship with ingredients.
                Considered embedding ingredients as jsonb but rejected it
                to allow ingredient-centric queries.' }

create_workflow runs later for Recipes domain
  → Before LLM call: PGC_Memory queried for scope 'domain:Recipes'
  → Memory injected into system context
  → LLM now knows the junction table design decision and why

fix_workflow runs on a broken create_workflow output
  → PGC_Memory queried for scope 'workflow:create_workflow'
  → Procedural memory injected: original design intent, known constraints
  → Repair LLM understands what it's trying to preserve

/chat "help me review my Spanish progress"
  → PGC_Memory queried for recent episodic memories tagged 'spanish'
  → Injects: "User completed flashcard session 2 days ago, 80% accuracy,
              struggled with subjunctive conjugations"
  → LLM responds as a companion who already knows the context


The Framing for evolving-mind-ai

I’d resist calling this “consciousness” — the right framing is accumulated context. The system gets more useful with each interaction not because the model is smarter, but because the harness is feeding it progressively richer context drawn from a growing memory corpus. That’s the architectural moat you’re building. The model is just the reasoning engine; the memory layer is what makes it yours.

This is also the cleanest separation between static system behaviour (left brain) and evolving artifacts (right brain) — PGC_Memory rows are evolving artifacts written by the right brain and read by the left.

Worth scoping this as its own design document before touching any code?