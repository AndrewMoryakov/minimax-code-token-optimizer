# AI Agent Install Instructions

Use this when installing the patch on another Windows machine with MiniMax Code.

## Steps

1. Clone the repo.

```powershell
git clone https://github.com/AndrewMoryakov/minimax-code-token-optimizer.git
cd minimax-code-token-optimizer
```

2. Apply the guarded bundled-plugin patch.

```powershell
node .\scripts\apply-mavis-opencode-optimizations.mjs
```

3. Install the standalone user plugins.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-user-plugins.ps1
```

4. Verify the installed patch.

```powershell
node .\scripts\verify-installed.mjs
node .\scripts\check-repo.mjs
```

5. Reload the OpenCode worker.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\reload-opencode-worker.ps1
```

6. Optional: install the max-economy policy.

Merge `examples\policy.max-openrouter-lifecycle.json` into:

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

