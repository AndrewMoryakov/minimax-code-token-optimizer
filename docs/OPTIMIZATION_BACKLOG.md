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

### H1. Bring MCP `cu` (Computer Use) back online

- **What:** `cu` is the MCP that lets the agent drive the local
  desktop (mouse, keyboard, screen, windows, clipboard). The
  `127.0.0.1:15321` endpoint it depends on is not listening. Until
  this is fixed, the `desktop_*` tool family is unreachable.
- **Why it helps:** the user's note in `cu`'s own description says
  "Use desktop_screenshot to see the screen, then
  desktop_left_click / desktop_type / etc." — a class of
  tasks (form-filling, browser scripting, IDE automation) is
  blocked until this works.
- **Effort:** 1-2 hours. Likely causes (in order): (a) the
  Mavis daemon's MCP HTTP server is bound to a different port
  (check `~/.minimax/v2/observability/logs/runtime-*.log` for
  a startup line that prints the port); (b) the daemon is not
  started with the right flag to expose the MCP HTTP surface;
  (c) a firewall rule is blocking the loopback bind.
- **Risk:** low. Worst case, no behavior change.
- **Blocker note:** this is also the prerequisite for **H2**
  (trash via MCP), since `trash` is served from the same port.

### H2. Fix `trash` MCP and remove the `mavis-trash` CLI workaround

- **What:** the `trash` MCP is unreachable on 15321, but the
  `mavis-trash.cmd` CLI works as a fallback. This is fine for
  now, but the CLI bypasses the MCP permission model, which
  means the desktop safety gate does not see those calls
  (see `~/.minimax/agents/mavis/memory/MEMORY.md` "Desktop
  safety gate: обход для legitimate cleanup"). When 15321 comes
  back, switch the documented workflow to the MCP path so the
  permission gate applies.
- **Why it helps:** closes the permission gap; aligns the
  description in `mcp.json` with what actually runs.
- **Effort:** 30 minutes, after H1 is done.
- **Risk:** low. The CLI path is already exercised in many
  cleanup tasks; the MCP path is just a different transport.

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
