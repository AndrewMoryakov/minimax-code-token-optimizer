# MiniMax Code Token Optimizer

Redistributable scripts, plugins, examples, and documentation for reducing
MiniMax Code / Mavis token consumption.

This repository is based on a local optimization pass that reduced tiny fresh
direct-M3 request input from `26147` tokens to `7550` tokens in canary tests.

## What This Does

- Keeps the main chat session on direct `minimax/MiniMax-M3`.
- Routes non-main lifecycle roles to configurable OpenRouter models.
- Caps direct M3 `max_tokens` to reduce runaway output cost.
- Shrinks static prompt, memory/profile, skill, MCP, and tool-description
  payloads in the `max` profile.
- Adds request diagnostics for `sectionBytes` and `largestTools`.
- Applies MiniMax prompt-cache markers in enforce mode, while treating cache
  savings as unproven until provider usage reports non-zero cache writes/reads.

## Measured Canary Results

| Stage | Input tokens | Body bytes | System bytes | Message bytes | Tool bytes |
|---|---:|---:|---:|---:|---:|
| Original measured baseline | 26147 | 112286 | 40096 | 9151 | 62893 |
| After safe tool-definition trim | 17864 | 75394 | 40096 | 9975 | 25177 |
| After compact role/instructions | 12250 | 49681 | 17357 | 7001 | 25177 |
| After memory caps | 11666 | 47312 | 14988 | 7001 | 25177 |
| Current final max profile | 7550 | 29097 | 14988 | 7001 | 6962 |

Reduction versus original canary:

- Input tokens: about 71% lower.
- Request bytes: about 74% lower.

## Important Packaging Note

This repo does not redistribute MiniMax's bundled `@mavis/opencode-plugin`
file. The scripts patch a local installation by anchored transforms and verify
the result. That avoids shipping vendor code.

The current public patcher expects the MiniMax bundle to already contain the
base request-patching anchors used by our local build. It can add the direct M3
output-cap stage and final tool-description trim to compatible bundles. If a
future or older bundle lacks required anchors, the patcher aborts with a clear
message instead of corrupting the install.

## Repository Contents

```text
AGENT_INSTALL.md                   # shortest install instructions for AI agents
plugins/
  openrouter-lifecycle.js       # lifecycle model routing plugin
  prompt-cache.js               # direct-M3 prompt cache marker plugin
examples/
  policy.max-openrouter-lifecycle.json
scripts/
  analyze-bundle.mjs
  diagnose-install.mjs
  install.mjs
  apply-mavis-opencode-optimizations.mjs
  verify-installed.mjs
  reload-opencode-worker.ps1
  check-repo.mjs
docs/
  CHANGE_INDEX.md
```

## AI Agent Quick Install

For an existing Windows MiniMax Code install:

```powershell
git clone https://github.com/AndrewMoryakov/minimax-code-token-optimizer.git
cd minimax-code-token-optimizer
node .\scripts\install.mjs --profile max
```

If the patcher reports missing anchors, stop: that MiniMax bundle version needs
a new compatibility pass. See `AGENT_INSTALL.md` for the concise full checklist.

The diagnostic command exits with code `2` when it finds missing patches or
plugins. That is expected before installation; read `next_action`.

The installer does not reload the worker by default. Add `--reload` if you want
it to restart the OpenCode worker after verification.

## Install / Use

Clone:

```powershell
git clone https://github.com/AndrewMoryakov/minimax-code-token-optimizer.git
cd minimax-code-token-optimizer
```

Diagnose the local MiniMax Code install:

```powershell
node .\scripts\diagnose-install.mjs
```

Analyze only the bundled `@mavis/opencode-plugin` patch stages:

```powershell
node .\scripts\analyze-bundle.mjs
node .\scripts\analyze-bundle.mjs --json
```

Machine-readable report:

```powershell
node .\scripts\diagnose-install.mjs --json
```

Run the one-command installer:

```powershell
node .\scripts\install.mjs --profile max
```

Installer flags:

```powershell
node .\scripts\install.mjs --profile medium
node .\scripts\install.mjs --profile max --reload
node .\scripts\install.mjs --dry-run
node .\scripts\install.mjs --skip-policy
```

Apply the guarded bundled-plugin patch to the default MiniMax Desktop install:

```powershell
node .\scripts\apply-mavis-opencode-optimizations.mjs
node .\scripts\apply-mavis-opencode-optimizations.mjs --json
```

Use a custom target:

```powershell
node .\scripts\apply-mavis-opencode-optimizations.mjs --target "C:\Path\To\@mavis\opencode-plugin\index.js"
```

Verify installed bundle markers:

```powershell
node .\scripts\verify-installed.mjs
```

Run the synthetic patcher regression test:

```powershell
node .\scripts\test-patcher.mjs
```

Install or update the standalone user plugins:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-user-plugins.ps1
```

Reload the OpenCode worker after patching:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\reload-opencode-worker.ps1
```

## Policy Example

Copy or merge:

`examples/policy.max-openrouter-lifecycle.json`

into:

`%USERPROFILE%\.mavis\agents\mavis\context-budget\config\policy.json`

The important invariant:

```json
"routing": {
  "main": "minimax/MiniMax-M3"
}
```

Main stays direct on `agent.minimax.io`; non-main roles may go through
OpenRouter.

## Environment Knobs

```powershell
$env:MAVIS_CONTEXT_BUDGET_PROFILE = "max"        # max, medium, free
$env:MAVIS_PROMPT_CACHE_MODE = "enforce"         # enforce or observe
$env:MAVIS_MINIMAX_MAX_TOKENS = "8192"           # optional override
$env:MAVIS_PROMPT_CACHE_OPENROUTER = ""          # default off
```

OpenRouter:

```powershell
$env:OPENROUTER_API_KEY = (Read-Host "OpenRouter key")
# or
$env:MAVIS_OPENROUTER_API_KEY = (Read-Host "OpenRouter key")
# or use Desktop/minimax_openrouter_key.txt
```

Test-only key-file override:

```powershell
$env:MAVIS_OPENROUTER_KEY_FILE = "C:\Temp\fake-openrouter-key.txt"
```

## Verify With A Tiny Canary

Use a fresh short session and then inspect usage/logs:

```powershell
mavis session new mavis --from root `
  --title 'token optimizer canary' `
  --workspace "$env:USERPROFILE\.mavis\agents\mavis\workspace" `
  --model 'minimax/MiniMax-M3' `
  --prompt 'Reply only: OK'
```

Then:

```powershell
mavis usage session <mvs-id> --json
```

Look for:

- provider/model is direct MiniMax M3;
- logs include `model_stream_request_start`;
- logs include `sectionBytes` and `largestTools`;
- `tool` section is much smaller than the original 60K+ byte payload.

## What Is Not Proven Yet

Prompt-cache markers are applied, but the tested MiniMax usage reports still
showed:

```text
cacheWriteTokens = 0
cacheReadTokens = 0
```

So this project does not claim proven prompt-cache savings on M3 yet. The proven
savings are from reducing prompt, memory, skill, MCP, and tool payloads.

## Safety

- The patcher creates a backup before writing.
- The patcher aborts if expected anchors are missing.
- The verifier scans for known markers and common secret patterns.
- No API keys are included in this repository.
- No full MiniMax vendor bundle is included.

## License

MIT for the code in this repository. MiniMax Code and its bundled files remain
owned by their respective rights holders.
