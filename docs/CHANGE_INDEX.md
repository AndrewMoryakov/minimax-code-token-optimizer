# Change Index

Date: 2026-06-22

This index summarizes the token optimization work captured in this repository.

## Proven Result

Tiny fresh direct-M3 canaries moved from:

- `inputTokens=26147`, `bodyBytes=112286`

to:

- `inputTokens=7550`, `bodyBytes=29097`

Approximate reduction:

- 71% fewer input tokens.
- 74% fewer request bytes.

## Runtime Changes

### Direct M3 Main Route

Main session stays on:

```text
minimax/MiniMax-M3
```

This preserves direct `agent.minimax.io` behavior for the dominant session cost.

### Lifecycle Routing

Non-main roles can be routed through OpenRouter:

- `small`
- `plan`
- `build`
- `general`
- `explore`

The example policy keeps all six roles explicit so behavior does not drift
through hidden defaults.

### Prompt Surface Profiles

Profiles:

- `max`: most aggressive economy, target total provider input context per
  session around 1,000,000 tokens.
- `medium`: balanced mode, around 3,000,000 tokens.
- `free`: more permissive mode, around 10,000,000 tokens.

The `max` profile trims:

- static role/base/session prompt text;
- user profile injection;
- memory tail and summary injection;
- skills block;
- MCP server/tool listing;
- final tool descriptions.

### Output Cap

Direct M3 `max_tokens` is capped to 8192 by default.

Override:

```powershell
$env:MAVIS_MINIMAX_MAX_TOKENS = "12000"
```

### Final Tool Description Trim

The biggest remaining tool payload was the `skill` tool description. Diagnostics
showed it was mostly `descriptionBytes`, not schema bytes.

The final patch trims final request-body `tools[].description` fields after
OpenCode has built the JSON body. It preserves tool objects, input schemas, and
schema annotations.

### Prompt Cache Markers

Prompt-cache markers are applied in enforce mode, and provider 4xx errors retry
the unpatched request.

Status:

- `prompt_cache_enforce_patched` appears in logs.
- Usage still reported `cacheWriteTokens=0` and `cacheReadTokens=0`.
- Treat M3 explicit prompt-cache savings as unproven.

## Verification

Use:

```powershell
node .\scripts\install.mjs --profile max
node .\scripts\diagnose-install.mjs
node .\scripts\verify-installed.mjs
node .\scripts\check-repo.mjs
```

For local Mavis workspaces that also have the full test harness:

```powershell
node .\context-budget\tests\run.mjs
node .\context-budget\tests\profile-smoke.mjs
node .\context-budget\tests\bundled-plugin-smoke.mjs
```

## Redistribution Boundaries

This repository intentionally does not include the full patched
`@mavis/opencode-plugin/index.js` bundle. Public distribution should use
patchers, small source plugins, examples, and docs.

## Known Tradeoffs

- `max` profile is terse and may reduce model awareness of rarely used tools or
  long memory nuance.
- The output cap may truncate unusually long legitimate answers.
- OpenRouter lifecycle routing changes billing, latency, privacy, and model
  behavior for non-main roles.
- Future MiniMax Desktop updates may change bundle anchors and require patcher
  updates.
