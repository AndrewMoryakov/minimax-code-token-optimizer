# AI Agent Install Instructions

Use this when installing the patch on another Windows machine with MiniMax Code.

## Steps

1. Clone the repo.

```powershell
git clone https://github.com/AndrewMoryakov/minimax-code-token-optimizer.git
cd minimax-code-token-optimizer
```

2. Run the one-command installer.

First diagnose. Exit code `2` means the install is incomplete or incompatible;
read `next_action`.

```powershell
node .\scripts\diagnose-install.mjs
```

If only bundle compatibility matters, run:

```powershell
node .\scripts\analyze-bundle.mjs
```

```powershell
node .\scripts\install.mjs --profile max
```

The installer applies the guarded bundle patch, installs standalone plugins,
makes a best-effort registration of those plugins in `opencode\opencode.json`,
merges the max-economy policy with a backup, and verifies the result.

3. Optional: reload the worker.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\reload-opencode-worker.ps1
```

Or let the installer reload after verification:

```powershell
node .\scripts\install.mjs --profile max --reload
```

4. Manual verification.

```powershell
node .\scripts\verify-installed.mjs
node .\scripts\check-repo.mjs
node .\scripts\diagnose-install.mjs
```

Expected diagnostic signals:

- `bundle_patched=true`
- `policy_main_direct_m3=true`
- `opencode_plugins_registered=true` is useful, but not durable on every
  MiniMax Desktop restart because Desktop can regenerate `opencode.json`.

`request-guard` defaults to observe mode. Set
`MAVIS_REQUEST_GUARD_MODE=enforce` only after the user accepts that oversized
provider requests may be blocked before they are sent. If Desktop regenerates
`opencode.json`, standalone plugins may need a runtime-specific registration
hook before they load.

5. Manual fallback commands.

```powershell
node .\scripts\apply-mavis-opencode-optimizations.mjs
powershell -ExecutionPolicy Bypass -File .\scripts\install-user-plugins.ps1
```

6. Optional: install the max-economy policy.

The installer does this automatically unless `--skip-policy` is used. Manual
path: merge `examples\policy.max-openrouter-lifecycle.json` into:

```text
%USERPROFILE%\.mavis\agents\mavis\context-budget\config\policy.json
```

Keep this invariant:

```json
"main": "minimax/MiniMax-M3"
```

## Stop Conditions

- If `apply-mavis-opencode-optimizations.mjs` says anchors are missing, stop.
  The local MiniMax Code bundle is not compatible with this patcher.
- Do not paste or commit API keys.
- Do not publish the installed MiniMax vendor bundle.
- If verification fails, do not continue to canary testing.

## Tiny Canary

After verification, run one small session:

```powershell
mavis session new mavis --from root --title 'token optimizer canary' --workspace "$env:USERPROFILE\.mavis\agents\mavis\workspace" --model 'minimax/MiniMax-M3' --prompt 'Reply only: OK'
```

Then inspect:

```powershell
mavis usage session <mvs-id> --json
```

Expected: direct MiniMax M3 usage and a much smaller request than the old
baseline. Prompt-cache reads/writes may still be zero; that is not a failure of
the proven token-surface optimization.
