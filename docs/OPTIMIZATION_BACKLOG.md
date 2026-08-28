# Token Optimization Backlog

Ideas for further token savings, with effort and expected payoff. None of
these are proven; they are first-principles reasoning. Apply only after a
measurement pass shows the targeted area is actually large.

## Status of Proven Optimizations

Already in place on this Mavis install (3.0.67.128):

- Standalone plugins at `~/.minimax/agents/mavis/opencode/plugins/`:
  - `request-guard.js`, `prompt-cache.js`, `prompt-surface.js`,
    `openrouter-lifecycle.js` — from this repo
  - `context-budget.js`, `context-tools.js`, `mavis.js` — built into
    Mavis
  - `tool-discipline.js` — separate
- `policy.json` at `~/.minimax/agents/mavis/context-budget/config/`
  with `profile: "max"`, OpenRouter routing, main session on
  `minimax/MiniMax-M3`.
- The bundle patcher cannot run against this Mavis version (bundle
  lives inside `app.asar`, not at the path the patcher expects), so
  the 71 % input-token reduction cited in the README is delivered
  here through plugins + policy, not the bundle patch.
- Cleanup script for backup-file accumulation (PR #1).

## High-Liquidity

These are small effort, clear target. Try these first.

### H0. Identify the plugin-loading mechanism

Audit on 2026-08-28 (see `docs/PLUGIN_AUDIT_2026-08-28.md`) found that
6 of 7 non-stub plugin files in `~/.minimax/agents/mavis/opencode/plugins/`
emit zero telemetry during a 19-minute real session. Only
`request-guard.js` is active. The 116 KB of code in
`context-budget.js`, `context-tools.js`, `openrouter-lifecycle.js`,
`prompt-cache.js`, `prompt-surface.js`, `tool-discipline.js` does
nothing at runtime.

`opencode.json` declares `"plugin": ["mavis"]` only, and the
auto-generated `plugins/mavis.js` is a 211-byte stub re-exporting from
`…\resources\resources\daemon\node_modules\@mavis\opencode-plugin\index.js`
— a path that does not exist (duplicated `resources` segment). The
bundle patcher targets the same malformed path and is therefore a
no-op on `Mavis 3.0.67.128`.

Without understanding who loads the plugins, none of H1, H2, M1, M2,
L1 can be empirically validated. This is the highest-priority item
in the backlog.

- **What:** determine the actual loader path. Candidates: opencode's
  own `node_modules`-walking loader, a hardcoded list inside
  `app.asar`, an external supervisor. Output: a one-page diagnosis
  with a workaround (e.g. registering the dead plugins by name, or
  moving files to a different directory) or a definitive "impossible
  without upstream fix" finding.
- **Why it helps:** without this, every "save tokens" claim in this
  backlog is theoretical.
- **Effort:** 1-2 hours including `app.asar` extraction. If asar
  extraction is blocked by EULA or tooling, fall back to reading
  opencode's published source on GitHub for its plugin loader.
- **Risk:** low. Output is a written diagnosis, no production
  changes.

### H1. Audit loaded plugins vs actually-used plugins

- **What:** the original audit (now superseded by the
  2026-08-28 finding documented in `PLUGIN_AUDIT_2026-08-28.md` and
  item H0 above) assumed 5 plugins were loaded. The actual state is
  1 of 7 (`request-guard.js`) plus the dead `mavis` stub. The
  `opencode.json` `plugin` field has only `["mavis"]`. Once H0
  identifies the loader, decide for each dead file: re-enable, or
  remove from the directory.
- **Why it helps:** a few hundred bytes per dead-plugin reference
  per turn, plus the misleading signal of having unused config
  (`policy.json`) and unused code.
- **Effort:** once H0 lands, this is 5 minutes of inspection plus
  archive-or-delete.
- **Risk:** if the dead plugins are silently doing useful work
  through a non-obvious path (e.g. exporting a type consumed by
  `app.asar`), removing them will break something. Disable one at a
  time, observe.

### H2. Cap output tokens

- **What:** set `MAVIS_MINIMAX_MAX_TOKENS` (env var) or the patcher's
  `MINIMAX_DEFAULT_MAX_TOKENS` constant to something like 4096 or
  2048. This caps how much the model can produce in a single
  response.
- **Why it helps:** output tokens cost as much as input. A model
  rambling 8 000 tokens when 1 500 would do is a 6 500-token savings
  per affected response, times the number of such responses per
  session.
- **Effort:** 1 minute — set an env var or change a constant.
- **Risk:** truncated responses may need a follow-up turn ("continue").
  Watch for tasks where the model legitimately needs long output
  (e.g. generating a long file in one shot) and exempt them.

## Medium-Liquidity

Worth doing, but each needs a measurement pass first to justify the
effort.

### M1. Skill content trimming

- **What:** the 15 installed skills have SKILL.md files between 1.3 KB
  and 4.8 KB. When a skill triggers, the full body loads into
  context. The descriptions (always in the system prompt) average
  ~200 chars; the body is loaded on demand.
- **Why it helps:** tighter skills = less context on every
  triggering. Mavis is unlikely to need the prose we wrote.
- **Effort:** 1-2 hours to review each skill, trim examples, keep only
  the core procedure.
- **Risk:** a skill trimmed too aggressively can be useless when it
  triggers. Keep one example per procedure, drop the rest.

### M2. Subagent context isolation

- **What:** when a subagent is dispatched (`task` tool, `explore`,
  etc.), it currently inherits the full session context. For narrow
  tasks ("verify that file X says Y") most of that context is noise.
- **Why it helps:** every subagent invocation currently re-sends the
  parent's system prompt + history. Isolation saves the parent's
  history tokens.
- **Effort:** depends on Mavis's subagent config; if there is an
  `subagent_context_mode: minimal` setting, it is one config edit.
  If not, it is a code change in Mavis.
- **Risk:** subagent may not have enough context to understand the
  task. Start with `mode: summary` (compressed parent history) before
  `mode: minimal` (no parent history).

## Low-Liquidity

Noticeable effort, not-obvious win. Worth doing only if a measurement
shows the targeted area is actually large.

### L1. Conversation-compaction tuning

- **What:** the `context-budget` plugin compacts the conversation
  history. The trigger (token count or turn count) and the
  aggressiveness (raw vs summary) are tunable but I have not measured
  the current values.
- **Why it helps:** later turns in a long session pay for all earlier
  turns. Compaction reduces that tax.
- **Effort:** measure current behaviour on a long session, then tune
  in `policy.json`. Several iterations likely.
- **Risk:** aggressive compaction loses context the model needed.
  Conservative settings keep the model effective; the win is small.

### L2. Pre-flight cost-estimation skill

- **What:** a skill in the same spirit as `decide-or-escalate` that
  reviews a planned action and flags it as expensive (large read,
  long compile, broad search). The skill doesn't replace action; it
  surfaces the cost first so the user / main agent can choose a
  narrower alternative.
- **Why it helps:** preventing one big read is worth more than ten
  post-hoc optimizations.
- **Effort:** design the heuristics, write the skill, install it. A
  few hours. Worth doing only if measurements show the read/compile
  cost is the dominant variable.
- **Risk:** false positives slow down simple actions. Heuristics need
  tuning to avoid being annoying.

### L3. My own response verbosity (the agent's, not Mavis's)

- **What:** I (Mavis's main agent) sometimes output several hundred
  bytes of prose to report what just happened. The user reads it,
  but the provider also sees it as part of the next turn's input.
  Tighter self-reports save tokens on the input side of the *next*
  turn.
- **Why it helps:** every redundant line in a report costs the same
  per turn as a line of actual content. Cumulative effect over a
  long session is real.
- **Effort:** discipline, not code. No new repo work.
- **Risk:** the user values the prose for clarity. Tighter reports
  must still be readable, not cryptic.

## Explicitly Not Pursuing

These were considered and rejected for the reasons given.

- **Aggressive prompt caching on second-tier providers.** Already tried
  (see README "What Is Not Proven Yet" — `cacheWriteTokens = 0`).
  Provider doesn't honor cache markers; not worth more attempts.
- **Compressing conversation history before every turn.**
  Technically possible, destroys useful context. Net loss in most
  scenarios.
- **Per-host version pinning via embedded checksums.** Mavis updates
  shift anchors. Maintaining N host versions is a maintenance
  burden that doesn't pay back without a real distribution.

## How to Apply

The right order is: **H0 → H1 → H2 → measure → M1/M2/L1 → L2**.

H0 is a prerequisite: until the plugin loader is understood, no
downstream item can be empirically validated. H1 and H2 are minutes
once H0 lands. The rest need measurements first; "save tokens"
without knowing where tokens are spent is superstition.

The `mavis usage session <id> --json` command (mentioned in the
README) is the way to get the numbers on a working Mavis install.
On `Mavis 3.0.67.128` the `mavis` CLI is currently broken
(`Cannot find module '…\resources\resources\daemon\cli.js'`,
same malformed path as `plugins/mavis.js`), so the measurement
step needs a workaround: provider-side logs, or fixing the
daemon path, before this order is fully executable.
