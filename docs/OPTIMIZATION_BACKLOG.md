# Token Optimization Backlog (v2-rebuilt)

> **v2-rebuild on 2026-08-28** — see `MCP_AUDIT_V2_2026-08-28.md`
> for the evidence behind every change here. The v1-era items in
> previous versions of this file were framed around opencode plugins
> and the bundle patcher, both of which are not on the v2 code path.
> This file replaces all of that with v2-grounded items.

> **v1-only audit kept for the historical record:**
> `PLUGIN_AUDIT_2026-08-28.md`. Read it for the v1 plugin-dir
> findings; do not act on its H0.

Ideas for further token savings, with effort and expected payoff.
None of these are proven; they are first-principles reasoning
informed by the v2 audit. Apply only after a measurement pass shows
the targeted area is actually large.

## Status of the v2 install (as of 2026-08-28)

**Working:**

- Prompt cache: 146M cache_read tokens over 44 days, vs 10.8M
  fresh input. Cache hit ratio is ~13× input volume; this is the
  main optimization already happening, natively.
- MCP server `matrix` (PID 16572), stdio-spawned from
  `app.asar/node_modules/@mavis/agent-tools/dist/desktop/`.
- Token-usage data is in `local_runtime_token_usage` SQLite
  table (819 rows, 44 days), so per-session, per-agent, per-turn
  measurement is available without any CLI.

**Not working:**

- MCP servers `cu` and `trash` are configured to talk to
  `127.0.0.1:15321/mavis/mcp/{cu,trash}` but the port is not
  listening. `trash` has a CLI fallback (`mavis-trash.cmd`);
  `cu` has none, so desktop Computer Use is unavailable until
  15321 comes back.
- MCP server `playwright` is configured but not running; would
  be spawned on demand. Status unknown.
- `local_runtime_plugin_official_state.effectivePlugins: []` —
  zero marketplace plugins installed. Could be a fresh account
  or a wipe.
- Bundle patcher
  (`scripts/apply-mavis-opencode-optimizations.mjs`) targets a
  v1 path; no-op on v2.
- The "71% input-token reduction" headline in the README does
  not apply to v2 users. Cache replacement is the real
  mechanism in v2 and is already running.

**Gaps in telemetry:**

- `local_runtime_token_usage.model` is `None` for every row.
  The model is known at LLM-response time (see
  `llm_response_identifiers` in `runtime-*.log`) but not
  written into the token-usage table.
- `cost_usd` is `0.0` for every row. The cost calculator is
  not wired.

## High-Liquidity

Small effort, clear target. Try these first.

### H1. Decide on `cu` (Computer Use): accept retired, or build a stdio wrapper

- **Context:** see `V2_ARCHITECTURE_2026-08-28.md`. The
  `cu` MCP is **officially retired** in v2
  (`@mavis/local-runtime/src/mcp/retired-cu.ts`, 911 bytes,
  filter function exported). The HTTP `127.0.0.1:15321/mavis/mcp/cu`
  endpoint is detected at config-load time and dropped. The `cu`
  source code itself is still present at
  `@mavis/local-runtime/src/cu/` (`cu-tool-defs.ts`,
  `cu-runtime-tools.ts`, `cu-screenshot-pruner.ts`, `gate.ts`),
  but it is not wrapped in an MCP server.
- **Two options:**
  - **Accept retired.** Document that desktop Computer Use is
    unavailable in v2. No code work. (Current state.)
  - **Build `cu-mcp-stdio.js`.** A small new file in
    `@mavis/agent-tools/dist/desktop/`, parallel to
    `matrix-mcp-stdio.js`, that imports the existing
    `cu-tool-defs.ts` and exposes each tool via MCP stdio.
    Add a `buildBuiltinCuServerConfig` in
    `@mavis/local-runtime/src/mcp/builtin-cu.ts`, paralleling
    `builtin-matrix.ts`. Update `retired-cu.ts` to no longer
    retire the new stdio path. Effort: 200-300 lines + smoke
    test, ~half a day.
- **Why it helps:** unblocks desktop automation tasks (form-fill,
  browser scripting, IDE control). The user's own description of
  the `cu` MCP lists this exact use case.
- **Effort:** half a day if you take the "build" option. Zero if
  you take the "accept" option. This is a strategic choice.
- **Risk:** low either way. The "build" option only adds a new
  path; the existing retired-cu filter is documented to drop
  the loopback HTTP pattern, so it would still skip the
  legacy URL.
- **Scope note:** this work belongs in the upstream Mavis repo,
  not in this `minimax-code-token-optimizer` repo. The
  token-optimizer repo does not own the v2 source.

### H2. Document `mavis-trash.cmd` as the official `trash` path; remove `trash` MCP from `mcp.json`

- **Context:** the `trash` MCP is **permanently retired** in v2
  for the same reason `cu` is: the loopback HTTP URL
  `127.0.0.1:15321/mavis/mcp/trash` matches
  `isRetiredLoopbackCuEndpoint`'s sibling filter, and v2 has no
  HTTP MCP surface to host it on. The `trash` MCP's own
  description already says: *"In shell commands, use
  `mavis-trash <path1> <path2> ...` directly — no need to go
  through `mavis mcp call`."* The `mavis-trash.cmd` CLI
  (re-uses `MiniMax Code.exe` as Node via `ELECTRON_RUN_AS_NODE=1`)
  is the intended working path.
- **What:** the `trash` entry in `~/.minimax/mcp/mcp.json` is
  dead config and confuses anyone reading the file. Remove it.
  Optionally, add a `disabled: true` note in a comment or in
  this backlog so the next reader knows it was deliberate.
- **Why it helps:** removes a misleading entry. The CLI is
  already what the MCP description recommends. The "workaround"
  framing in this backlog was wrong — the CLI is the official
  path, not a workaround.
- **Effort:** 5 minutes (edit mcp.json). Then restart the
  Electron process so the config is re-read; on this Mavis
  install a full MiniMax Code restart is the only safe way.
- **Risk:** none functional. The only effect of removing the
  entry is that future audits of `mcp.json` won't be confused
  by it.

### H3. Wire `model` and `cost_usd` into the token-usage table

- **What:** every row in `local_runtime_token_usage` has
  `model = NULL` and `cost_usd = 0.0`. The model is known from
  `llm_response_identifiers` events in the runtime log; the
  cost is computable from token counts and the model price
  table.
- **Why it helps:** without the model field, you cannot do
  per-model cost analysis (which M3 is cheaper, where to
  switch, which models are over-used). Without cost, you
  cannot do "spend" optimization. Both are cheap to wire.
- **Effort:** 1-3 hours depending on where the v2 logger
  builds its insert.
- **Risk:** low. Adding a non-null column would require a
  migration; keep the column nullable and fill it in code.

## Medium-Liquidity

Worth doing, but each needs a measurement pass first to justify
the effort. v2 has changed the calibration data:

### M1. Skill content trimming (v2-measured)

- **What:** the 15 installed skills have `SKILL.md` files
  between 1.3 KB and 4.8 KB. When a skill triggers, the full
  body loads into context. v2 caches the prefix, so repeat
  triggers get a cache hit, but the *first* trigger of a skill
  in a session still pays the full cost.
- **Why it helps:** a tighter first-trigger cost on cold cache.
  Cached triggers are already cheap.
- **Measurement:** query
  `local_runtime_token_usage` for sessions with high
  `cache_write_tokens` (currently 0; this will need to be
  fixed for real analysis) or for sessions where the input
  spiked just after a tool_execute event. Until `model` and
  `cache_write` are wired, the best proxy is: "which
  sessions have a high `input_tokens` peak on the first
  turn of a new sub-task?"
- **Effort:** 1-2 hours to review each skill, trim examples,
  keep only the core procedure.
- **Risk:** a skill trimmed too aggressively can be useless
  when it triggers. Keep one example per procedure, drop the
  rest.

### M2. Subagent context isolation (v2-measured)

- **What:** when a subagent is dispatched (`task` tool,
  `explore`, etc.), it currently inherits the full session
  context. For narrow tasks ("verify that file X says Y")
  most of that context is noise.
- **Why it helps:** every subagent invocation currently
  re-sends the parent's system prompt + history. Isolation
  saves the parent's history tokens.
- **Effort:** depends on Mavis's subagent config; if there is
  an `subagent_context_mode: minimal` setting, it is one
  config edit. If not, it is a code change in Mavis.
- **Measurement:** the `agents` table has 6 rows including
  `explore`, `worker`, `verifier`, `general` plus two more —
  check how much `input_tokens` each agent type accumulates
  per turn to size the savings.
- **Risk:** subagent may not have enough context to
  understand the task. Start with `mode: summary`
  (compressed parent history) before `mode: minimal` (no
  parent history).

## Low-Liquidity

Noticeable effort, not-obvious win. Worth doing only if a
measurement shows the targeted area is actually large.

### L1. Conversation-compaction tuning (v2-measured)

- **What:** pi-agent compacts the conversation history at
  some trigger (token count or turn count). The trigger and
  aggressiveness are tunable but I have not measured the
  current values for v2.
- **Why it helps:** later turns in a long session pay for all
  earlier turns. Compaction reduces that tax.
- **Measurement:** the `local_runtime_sessions` table has
  50 rows; join with `local_runtime_token_usage` on
  `session_id` to plot `input_tokens` over `turn_id` for the
  long-running sessions. The slope tells you whether
  compaction is keeping up.
- **Effort:** measure, then tune. Several iterations likely.
- **Risk:** aggressive compaction loses context the model
  needed. Conservative settings keep the model effective;
  the win is small.

### L2. Pre-flight cost-estimation skill

- **What:** a skill in the same spirit as `decide-or-escalate`
  that reviews a planned action and flags it as expensive
  (large read, long compile, broad search). The skill doesn't
  replace action; it surfaces the cost first so the user /
  main agent can choose a narrower alternative.
- **Why it helps:** preventing one big read is worth more
  than ten post-hoc optimizations.
- **Effort:** design the heuristics, write the skill,
  install it. A few hours. Worth doing only if measurements
  show the read/compile cost is the dominant variable.
- **Risk:** false positives slow down simple actions.
  Heuristics need tuning to avoid being annoying.

### L3. My own response verbosity (the agent's, not Mavis's)

- **What:** I (Mavis's main agent) sometimes output several
  hundred bytes of prose to report what just happened. The
  user reads it, but the provider also sees it as part of
  the next turn's input. Tighter self-reports save tokens on
  the input side of the *next* turn.
- **Why it helps:** every redundant line in a report costs
  the same per turn as a line of actual content. Cumulative
  effect over a long session is real.
- **Effort:** discipline, not code. No new repo work.
- **Risk:** the user values the prose for clarity. Tighter
  reports must still be readable, not cryptic.

## Explicitly Not Pursuing

These were considered and rejected for the reasons given.

- **Aggressive prompt caching on second-tier providers.**
  v2 has prompt caching working natively via the LLM
  provider. The "cacheWriteTokens = 0" line in the v1 README
  is a v1 telemetry artifact; the cache_read line shows the
  real benefit. No action needed.
- **Compressing conversation history before every turn.**
  Technically possible, destroys useful context. Net loss
  in most scenarios.
- **Per-host version pinning via embedded checksums.**
  Mavis updates shift anchors. Maintaining N host versions
  is a maintenance burden that doesn't pay back without a
  real distribution.
- **Restoring the v1 bundle patcher.** v1 is dead on this
  Mavis (last `~/.minimax/logs/daemon-*.log` from 2026-07-15).
  v2 has a different architecture; the patcher would need a
  full rewrite. The current patcher stays as a no-op
  guarded by a lock check (see PR #1).
- **Searching for `opencode.json` plugin entries in v2.**
  The `~/.minimax/agents/mavis/opencode/opencode.json` file
  is v1-era; v2 reads plugin/MCP config from SQLite and
  `mcp.json`. No v2 install needs the opencode.json path.

## How to Apply

The right order is: **H1 → H2 → H3 → measure → M1/M2/L1 → L2/L3**.

H1 is the highest-leverage item: it unblocks `cu` and
`trash` and reveals the same root cause for both. H2 is
cleanup once H1 lands. H3 makes the data fit for cost
analysis.

After H1-H3, all measurement is now in SQLite — no CLI
needed. Use:

```sql
-- 44-day totals
SELECT agent_name, COUNT(*),
       SUM(input_tokens), SUM(output_tokens),
       SUM(cache_read_tokens), SUM(cache_write_tokens)
FROM local_runtime_token_usage GROUP BY agent_name;

-- per-session input growth
SELECT session_id, turn_id, input_tokens, cache_read_tokens
FROM local_runtime_token_usage
WHERE session_id = ? ORDER BY ts;
```

Before starting M1/M2/L1, run a measurement pass: the
point of M/L items is "save tokens where tokens are
spent," and the SQLite data tells you that directly.
"Save tokens" without knowing where tokens are spent is
superstition.

## How this backlog relates to PR #1 and the patcher

- **PR #1** (lock check + cleanup script) is still relevant.
  It guards the install from a future v2-rewrite of the
  patcher or a rollback to v1. The patcher itself stays as
  a no-op on v2, but the lock check prevents a half-applied
  state if a future release puts the bundle path back.
- **The patcher is not the optimization path in v2.** Prompt
  cache is. If you want to "save tokens" today, look at L1
  (compaction) and L2 (pre-flight skill), not at the
  patcher.
