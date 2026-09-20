# MiniMax Code Token Optimizer

Redistributable scripts, plugins, examples, and documentation for reducing
MiniMax Code / Mavis token consumption.

This repository is based on a local optimization pass that reduced tiny fresh
direct-M3 request input from `26147` tokens to `7550` tokens in canary tests on
a **v1** MiniMax Code install. Read "Supported MiniMax Versions" below before
installing: current MiniMax Code (v2) has no patchable bundle, and the installer
refuses to touch it.

## Who This Is For

Use this repository if you run MiniMax Code on Windows and want a safer,
repeatable way to reduce how much context MiniMax Code sends to model
providers. You do not need to know the MiniMax internals before starting, but
you should be comfortable running PowerShell commands and reading command
output.

If you are an AI agent installing this for a user, start with
`AGENT_INSTALL.md`. It is the shorter operational checklist. This README
explains the background, safety model, and manual commands.

## Project Status

Windows-first, experimental, and actively compatibility-gated. The installer
backs up files and aborts when expected MiniMax bundle anchors are missing. The
repo does not ship MiniMax vendor bundles or API keys.

## Supported MiniMax Versions

**This toolkit only applies to v1-era MiniMax Code installs** — the ones that
ship a patchable OpenCode plugin bundle at

```text
%LOCALAPPDATA%\Programs\MiniMax Code\resources\resources\daemon\node_modules\@mavis\opencode-plugin\index.js
```

MiniMax Code v2 (verified on Mavis 3.0.68.134, and the same is true on 3.0.59)
replaced that runtime with `@mavis/local-runtime` inside `app.asar`. On such an
install:

- the bundle above does not exist, so the patcher has nothing to patch;
- `@mavis/local-runtime` keeps opencode only as migration code, and its own
  source says new local sessions no longer use that path;
- a search of every packed `.js`/`.ts` file in `app.asar` finds no reference to
  `MAVIS_PROMPT_CACHE_MODE`, `MAVIS_CONTEXT_BUDGET`, `MAVIS_REQUEST_GUARD`,
  `MAVIS_MINIMAX_MAX_TOKENS`, `opencode.json` or `context-budget/config`, so the
  standalone plugins, the environment knobs and `policy.json` have no effect.

The installer detects this and refuses:

```text
install_layout=v2-local-runtime
ERROR: This MiniMax Code install runs the v2 local-runtime (pi-agent).
```

Do not work around that by passing `--target` at some other file. See
`docs/MCP_AUDIT_V2_2026-08-28.md` and `docs/V2_ARCHITECTURE_2026-08-28.md` for
the evidence.

## Prerequisites

- Windows with MiniMax Code / Mavis already installed.
- Node.js available as `node`.
- Git available as `git`.
- PowerShell for the helper scripts.
- Optional: OpenRouter API key if you want non-main lifecycle roles routed
  through OpenRouter.

Check the local machine:

```powershell
node --version
git --version
mavis --version
```

## Terms Used Here

- `MiniMax Code` / `Mavis`: the local coding agent runtime this project patches.
- `OpenCode`: the provider/tool execution layer inside MiniMax Code.
- `direct M3`: requests sent directly to `agent.minimax.io` using
  `minimax/MiniMax-M3`.
- `OpenRouter`: optional third-party routing for cheaper or smaller non-main
  lifecycle roles.
- `main session`: the primary chat/coding conversation. This project keeps it
  on direct M3.
- `lifecycle roles`: keys in the routing table (`plan`, `build`, `general`,
  `explore`, `small`). Only the ones matching a real Mavis agent take effect.
  The agent names seen in the Mavis runtime databases are `mavis`, `verifier`,
  `general`, `explore`, `worker` and `coder`, so `plan`, `build` and `small`
  entries are inert there; `plan` and `build` come from vanilla OpenCode.
- `bundle patch`: a guarded edit to the installed local
  `@mavis/opencode-plugin` file. The patcher creates a backup first.
- `standalone plugins`: extra `.js` plugins copied into the user's Mavis
  plugin directory. MiniMax Desktop can regenerate `opencode.json`, so these
  are useful but less durable than the bundle patch.

## What This Does

- Keeps the main chat session on direct `minimax/MiniMax-M3`.
- Routes non-main lifecycle roles to configurable OpenRouter models.
- Caps direct M3 `max_tokens` to reduce runaway output cost.
- Shrinks static prompt, memory/profile, skill, MCP, and tool-description
  payloads in the `max` profile.
- Adds request diagnostics for `sectionBytes` and `largestTools`.
- Applies MiniMax prompt-cache markers in enforce mode, while treating cache
  savings as unproven until provider usage reports non-zero cache writes/reads.

## Measured Canary Results (v1 only)

These numbers were measured on a v1 install with the bundle patch applied. They
do not describe MiniMax Code v2, where the patch cannot be applied at all.

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

The current public patcher expects the MiniMax bundle to contain recognizable
base request-patching and prompt-surface anchors. On compatible bundles, it can
add direct M3 output cap, request diagnostics, schema-preserving tool-definition
trim, max-profile memory caps, max-profile static prompt compaction, and final
tool-description trim. If a future or older bundle lacks required anchors, the
patcher aborts with a clear message instead of corrupting the install.

## What Changes On Disk

The installer can update these local user/machine files:

```text
MiniMax installed bundle:
  %LOCALAPPDATA%\Programs\MiniMax Code\resources\resources\daemon\node_modules\@mavis\opencode-plugin\index.js

Mavis user config and plugins:
  %USERPROFILE%\.mavis\agents\mavis\context-budget\config\policy.json
  %USERPROFILE%\.mavis\agents\mavis\opencode\plugins\*.js
  %USERPROFILE%\.mavis\agents\mavis\opencode\opencode.json
```

Before writing, the installer creates timestamped backups next to the target
files. It does not modify or publish MiniMax vendor source in this repository.

## Repository Contents

```text
AGENT_INSTALL.md                   # shortest install instructions for AI agents
plugins/
  openrouter-lifecycle.js       # lifecycle model routing plugin
  prompt-cache.js               # direct-M3 prompt cache marker plugin
  prompt-surface.js             # standalone static prompt/MCP/skills reducer
  request-guard.js              # observe/enforce preflight request byte guard
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
  COMPATIBILITY.md
```

## Safe Quick Start

For a first install, prefer this sequence:

```powershell
git clone https://github.com/AndrewMoryakov/minimax-code-token-optimizer.git
cd minimax-code-token-optimizer

# 1. Inspect the local MiniMax install. Exit code 2 can be normal before install.
node .\scripts\diagnose-install.mjs

# 2. Preview what the installer would do.
node .\scripts\install.mjs --profile max --dry-run

# 3. Apply the patch.
node .\scripts\install.mjs --profile max

# 4. Reload the OpenCode worker so the running process picks up the patched bundle.
powershell -ExecutionPolicy Bypass -File .\scripts\reload-opencode-worker.ps1

# 5. Verify.
node .\scripts\diagnose-install.mjs
```

Use `--profile medium` for a less aggressive default. Use `--reload` on the
installer if you want it to run the worker reload step automatically after
verification.

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

The installer also makes a best-effort registration of standalone plugins in
`%USERPROFILE%\.mavis\agents\mavis\opencode\opencode.json` after `mavis`:
`openrouter-lifecycle`, `prompt-surface`, `request-guard`, and `prompt-cache`.
MiniMax Desktop may regenerate this file on worker restart, so the durable
optimizations are the guarded bundle patch stages. The provider request guard
is also installed into the durable bundle patcher, so oversized MiniMax and
OpenRouter requests can still be observed or blocked even if Desktop rewrites
the standalone plugin list.

After a MiniMax Code update or reinstall, use
[`docs/RESTORE_AFTER_UPDATE.md`](docs/RESTORE_AFTER_UPDATE.md) to reapply and
verify the optimizer.

## Profiles

Profiles control how aggressively the prompt surface is reduced.

| Profile | Intended use | Target behavior |
|---|---|---|
| `max` | Maximum economy | Strong prompt, memory, skill, MCP, and tool trimming. Best for cost control. |
| `medium` | Balanced daily use | Keeps more prompt surface while still applying the main savings. |
| `free` | More permissive | Lowest interference, useful when debugging optimizer side effects. |

The current measured canary result in this README is for `max`.

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
node .\scripts\install.mjs --skip-plugin-registration
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

Request guard modes:

```powershell
# default: observe oversized provider requests and log request_guard_over_budget
$env:MAVIS_REQUEST_GUARD_MODE = "observe"

# optional: block oversized provider requests before they are sent
$env:MAVIS_REQUEST_GUARD_MODE = "enforce"

# optional per-provider limits, bytes
$env:MAVIS_REQUEST_GUARD_MINIMAX_MAX_BODY_BYTES = "200000"
$env:MAVIS_REQUEST_GUARD_OPENROUTER_MAX_BODY_BYTES = "80000"
```

Run the synthetic patcher regression test:

```powershell
node .\scripts\test-patcher.mjs
```

Recommended pre-publish/local health check:

```powershell
node .\scripts\test-patcher.mjs
node .\scripts\check-repo.mjs
node .\scripts\install.mjs --profile max --dry-run
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

The plugin fails safe in both directions. If `policy.json` is missing or does
not parse, `main` stays on direct M3 rather than falling back to OpenRouter. If
`opencode.json` already names a model, that choice is kept. A routing value
naming a model the plugin does not register is skipped with a
`skipped routing entries` warning instead of being handed to OpenCode as an
unresolvable id.

## Environment Knobs

```powershell
$env:MAVIS_CONTEXT_BUDGET_PROFILE = "max"        # max, medium, free
$env:MAVIS_PROMPT_CACHE_MODE = "enforce"         # enforce or observe, ceiling of 4 breakpoints
$env:MAVIS_MINIMAX_MAX_TOKENS = "8192"           # optional override, see note below
$env:MAVIS_PROMPT_CACHE_OPENROUTER = ""          # default off
$env:MAVIS_REQUEST_GUARD_MODE = "observe"        # observe, enforce, off
```

`MAVIS_MINIMAX_MAX_TOKENS` caps direct M3 output. The cap is never applied below
`thinking.budget_tokens + 1024` when the request enables thinking: a provider
rejects `max_tokens` at or below the thinking budget, and a cap with no room
left after reasoning truncates the tool call the model was writing.

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

Prompt cache markers are capped at four `cache_control` breakpoints per request,
counting markers that are already in the body. Anthropic-compatible endpoints
reject a fifth one, and both the standalone plugin and the patched bundle add
markers, so each counts what the other already placed. When the provider does
reject the markers with a `400` mentioning `cache_control`, the plugin retries
once without them; any other error, including `429` and `413`, is passed back
unchanged rather than re-sent.

If `cacheWriteTokens` and `cacheReadTokens` stay at `0`, do not treat that as a
failed install. The prompt-cache path is still under investigation. The primary
proven saving is the smaller request context.

## Troubleshooting

If `diagnose-install.mjs` exits with code `2`, read the printed issue list and
`next_action`. This usually means the patch is not installed yet or the local
MiniMax bundle is not compatible with the current patcher.

If it prints `install_layout=v2-local-runtime`, stop: that MiniMax version is
out of scope for this toolkit, and no flag makes it work.

If the patcher says anchors are missing, stop and do not force the patch. That
MiniMax version needs a compatibility pass.

If standalone plugins disappear from `opencode.json` after a MiniMax Desktop
restart, that is expected on some versions. The durable bundle patch remains the
main protection path.

If requests are too large, keep `MAVIS_REQUEST_GUARD_MODE=observe` first and
review `request_guard_over_budget` log events. Switch to `enforce` only when you
accept that oversized provider requests may be blocked before they are sent.

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

## Related

Controlled Codex-to-MiniMax collaboration bridge and canary checks:

https://github.com/AndrewMoryakov/mavis-minimax-bridge

## License

MIT for the code in this repository. MiniMax Code and its bundled files remain
owned by their respective rights holders.
