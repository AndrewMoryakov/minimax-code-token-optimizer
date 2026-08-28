# Research Plan — 2026-08-28

> **Status:** approved for record. No implementation work in this
> commit. Each phase will be a separate commit on the same PR
> when started.

## Why this plan exists

After the v2 audit and the v2 architecture investigation, we
know:

- v2 runtime uses MCP (not opencode plugins).
- Only 1 of 5 MCPs in `mcp.json` is active (`matrix`, stdio).
- `cu` and `trash` MCPs are officially retired in v2
  (`@mavis/local-runtime/src/mcp/retired-cu.ts`); the
  `127.0.0.1:15321` HTTP endpoint is not and will not be bound.
- The `cu` source code is intact but not exposed as MCP.
- `local_runtime_token_usage` has 819 rows over 44 days,
  showing prompt cache working at ~13× input volume.
- `local_runtime_token_usage.model` is `NULL` and
  `cost_usd` is `0.0` for every row — telemetry gaps.
- 6 agent types exist (mavis, general, coder, verifier, explore,
  worker); only mavis is active in this session.

What we **don't** know — and what blocks the next decision:

1. The full MCP lifecycle (load → start → stop → retire) — we
   read `retired-cu.ts` and `builtin-matrix.ts` but not
   `api.ts`, `config.ts`, `public-facade.ts`, `runtime/`.
2. The exact list of `desktop_*` tools `cu` would expose — only
   the file header of `cu-tool-defs.ts` (18.8 KB) was sampled.
3. The contents of the 819 token-usage rows: per-session input
   growth, cache hit/miss classification, tool cost
   distribution.
4. Which of the 15 installed skills are actually triggered, and
   how often.
5. When pi-agent triggers compaction, and how aggressively.
6. What the 5 other agents (general, coder, verifier, explore,
   worker) do and whether they are used.

This plan closes those gaps in 6 phases and ends in a
**development-points** document that ranks concrete next steps
by ROI.

## Total scope

- ~6 hours of focused research
- 2-3 sessions, each ending in a commit on this branch
- All work is docs + SQL queries + asar reads — no production
  code, no live-system changes

## What this plan explicitly does **not** include

- Fixing the Telegram poller (out of scope; the user has chosen
  to skip this for now)
- A full asar unpack (48 105 files — overkill; we read
  individual files on demand)
- Rewriting the bundle patcher for v2 (the v2 audit already
  established that prompt cache is the real optimization path,
  not the patcher)
- Implementing `cu-mcp-stdio.js` (this is a possible Phase 6
  output, scoped to upstream Mavis — not this repo)

## Phase 1 — Close the architecture white spots (1.5 h)

**Goal:** know exactly how v2 loads MCP, so every later
decision is grounded in code, not inference.

**Source files to read** (already located in
`MiniMax Code\resources\app.asar`):

- `@mavis/local-runtime/src/mcp/api.ts` — public MCP lifecycle
  contract (load, start, stop, retire).
- `@mavis/local-runtime/src/mcp/config.ts` and
  `config-file.ts` — how `mcp.json` is loaded, when
  `isRetiredLegacyCuMcpServerConfig` is called.
- `@mavis/local-runtime/src/mcp/public-facade.ts` — operations
  exposed to the rest of the runtime.
- `@mavis/local-runtime/src/mcp/runtime/` — the runtime
  adapter, including how stdio children are spawned and torn
  down.
- `@mavis/local-runtime/src/cu/cu-tool-defs.ts` (full 18.8 KB) —
  complete list of `desktop_*` tools, with descriptions and
  parameter shapes. This is the inventory for the "build
  `cu-mcp-stdio.js`" option in H1.
- `app.asar/node_modules/@mavis/local-runtime-v2/dist/` — what
  v2 runtime exposes that the v1 source we read does not. (The
  `local-runtime` source we read is the v1 layer; `local-runtime-v2`
  is the v2 successor.)

**Output:** a new "MCP lifecycle" section in
`V2_ARCHITECTURE_2026-08-28.md`, plus an inventory of `desktop_*`
tools with names, descriptions, and parameter shapes.

**Acceptance:** a reader can answer "what does cu do, exactly,
if I revive it" by reading this section.

## Phase 2 — Token-usage analysis (1 h)

**Goal:** turn 819 raw rows into 3-4 concrete numbers that
size the backlog items.

**SQL queries to write** (against
`~/.minimax/v2/sqlite/runtime-state.sqlite`):

- Distribution of `input_tokens` per session, top 10
  sessions by input.
- Per-session input growth curve for the 5 longest sessions:
  `input_tokens` and `cache_read_tokens` over `turn_id`.
- Cache hit ratio per session:
  `cache_read / (cache_read + input)`. Classify sessions
  into "cache-warm", "cache-cold", "mixed".
- Tool activity distribution: from
  `local_runtime_pi_history_rows.toolName`, count occurrences
  and join with `local_runtime_token_usage.session_id` to size
  the input tax per tool.

**Output:** new `docs/TOKEN_USAGE_ANALYSIS_2026-08-28.md` with
tables and ASCII charts.

**Acceptance:** the file answers "where do tokens go in a
typical session" and "which tools cost the most per call".

## Phase 3 — Skills and agents footprint (1.5 h)

**Goal:** know which skills and agents are real (triggered) and
which are dead code on disk.

**Actions:**

- From `local_runtime_pi_history_rows` extract all `toolName`
  values, group by frequency and average input/output.
- Cross-reference with the 15 skills installed at
  `~/.minimax/skills/` and `~/.minimax/agents/mavis/skills/`.
  Each skill has a `name:` in its `SKILL.md` frontmatter.
  Classify each skill as: *frequent trigger*, *rare trigger*,
  *never triggered*.
- Inspect `~/.minimax/agents/{coder,general,verifier,explore,worker}/`
  configurations. For each, record: skills, custom tools,
  default model, system prompt length, and how many sessions
  used it (from `local_runtime_token_usage.agent_name`).
- Cross-check: are these agents "ready to be used" or "shipped
  but never invoked"?

**Output:** a new "Agents and skills footprint" section in
`V2_ARCHITECTURE_2026-08-28.md`, plus a per-skill table with
"triggered N times / never" annotations.

**Acceptance:** every installed skill and every configured
agent has a yes/no/never-used verdict with evidence.

## Phase 4 — Compaction behavior (1 h)

**Goal:** size L1 ("conversation-compaction tuning") with
real data, not guesses.

**Actions:**

- From the per-session input growth curves (Phase 2), find
  places where `input_tokens` drops sharply across two
  consecutive turns. These are compaction events.
- For each compaction event: how many turns preceded it, what
  was the input size before and after, did cache_read also
  drop?
- Classify the trigger: did compaction fire at a fixed turn
  count, at a fixed input size, or somewhere else?
- Compare to a naive baseline: if compaction had not fired,
  how big would the next 3-5 turns have been?

**Output:** a "Compaction Behavior" section in
`TOKEN_USAGE_ANALYSIS_2026-08-28.md`.

**Acceptance:** the section answers "is compaction helping,
neutral, or hurting" with one sentence and supporting numbers.

## Phase 5 — Synthesis: development points ranked by ROI (1 h)

**Goal:** one document that converts all gathered evidence
into a ranked list of concrete next steps, sized and scoped.

**Actions:**

- Re-evaluate the existing backlog items (H1, H2, H3, M1, M2,
  L1, L2, L3) in light of the new data from Phases 1-4.
- Add new points that emerge from the data. Examples that
  might appear:
  - "playwright MCP is configured but has not been used in 7
    days — remove from `mcp.json` to reduce startup surface."
  - "skill X triggers 200 times and always adds 2 KB to the
    first prompt — trim the example to one."
  - "compaction fires at turn 12 and at turn 25; aggressive
    compaction at turn 12 may not be paying for itself."
  - "`local_runtime_token_usage.model` is `NULL` because the
    v2 logger drops it before insert; fix is in
    `runtime-events-processor.ts` line ~N (TBD)."
- For each point: problem, evidence (with table/chart link),
  effort estimate, expected payoff, scope (this repo vs
  upstream Mavis).

**Output:** new `docs/DEVELOPMENT_POINTS_2026-08-28.md` — the
headline artifact of the whole research effort.

**Acceptance:** a reader can pick the top 3 points and start
work in the same session.

## Phase 6 — Decision and action

Not part of this research plan. After Phase 5, the
`DEVELOPMENT_POINTS_2026-08-28.md` doc is the input to a
decision conversation with the user. The user picks top-N
points; we then plan and implement them.

Possible Phase 6 work, listed for completeness:

- Implement `cu-mcp-stdio.js` (upstream Mavis, ~half a day).
- Wire `model` and `cost_usd` into `local_runtime_token_usage`
  (upstream Mavis, 1-3 hours).
- Trim skills (this repo or skill-PR upstream, varies).
- Tighten compaction trigger (upstream Mavis, several
  iterations).

## Sessioning

The phases are sized so that 2-3 sessions cover them all:

- **Session 1:** Phase 1 + Phase 4 (architecture + compaction
  analysis are both bounded; they share the asar-read tooling).
- **Session 2:** Phase 2 + Phase 3 (token analysis + skills/
  agents — both are SQL queries on the same database).
- **Session 3:** Phase 5 (synthesis; needs the inputs from the
  first two sessions).

Each session ends with a commit on this branch.

## Open questions to revisit at Phase 5

- Is the v2 architecture stable enough to plan optimizations
  against, or is Mavis on the verge of a v3 that would
  invalidate the v2 audit? (No signal of v3 as of 2026-08-28,
  but worth checking.)
- Is the `agents` table the right place to look for subagent
  behavior, or is there a separate "subagent" registry?
- Is there a Mavis changelog or release notes source that
  would explain the `cu` retirement and the v1→v2 migration
  story more authoritatively than reverse-engineering?

## Related documents

- `MCP_AUDIT_V2_2026-08-28.md` — the 5-MCP / port-15321 audit
- `V2_ARCHITECTURE_2026-08-28.md` — the source-level walk
- `OPTIMIZATION_BACKLOG.md` — the working backlog, rebuilt
  for v2
- `PLUGIN_AUDIT_2026-08-28.md` — v1-only snapshot, kept for
  historical record
