# Restore After MiniMax Code Update Or Reinstall

Use this checklist after MiniMax Code updates, is repaired, or is reinstalled.
Updates can replace the installed `@mavis/opencode-plugin` bundle and MiniMax
Desktop can regenerate `opencode.json`, so assume local patches may be gone.

## What Is Durable

- This GitHub repository.
- The installer, patcher, tests, examples, and docs.
- User files under `%USERPROFILE%\.mavis\agents\mavis` if the reinstall did not
  remove them.

## What May Need Reapplying

- The patched MiniMax bundled `@mavis/opencode-plugin`.
- Standalone plugins under `%USERPROFILE%\.mavis\agents\mavis\opencode\plugins`.
- The generated `opencode\opencode.json` plugin list.
- The context-budget policy.
- A worker reload so the running process picks up the patched bundle.

## Restore Commands

```powershell
cd %USERPROFILE%\.mavis\agents\mavis\workspace\minimax-code-token-optimizer
git pull

node .\scripts\diagnose-install.mjs
node .\scripts\install.mjs --profile max --dry-run
node .\scripts\install.mjs --profile max --reload
node .\scripts\diagnose-install.mjs
```

If the repository is missing:

```powershell
cd %USERPROFILE%\.mavis\agents\mavis\workspace
git clone https://github.com/AndrewMoryakov/minimax-code-token-optimizer.git
cd minimax-code-token-optimizer

node .\scripts\install.mjs --profile max --reload
```

## Expected Result

`diagnose-install.mjs` should report:

- bundle exists;
- bundle is compatible;
- bundle is patched / `fully-patched`;
- policy keeps `routing.main = "minimax/MiniMax-M3"`;
- standalone plugin files exist.

It may warn that standalone plugins are not registered in generated
`opencode.json`. That warning is expected on some MiniMax Desktop versions
because Desktop can regenerate that file. The durable bundle patch remains the
main protection path.

## Stop Conditions

Stop and do not force the patch if:

- `diagnose-install.mjs` says the bundle is not compatible;
- `apply-mavis-opencode-optimizations.mjs` says anchors are missing;
- `policy.json` does not parse;
- `verify-installed.mjs` fails after installation.

A new MiniMax Code bundle may need a compatibility pass before it can be
patched safely.

## Local Secrets And State

This repository does not store:

- OpenRouter keys;
- `Desktop\minimax_openrouter_key.txt`;
- `.env` files;
- private runtime logs;
- private request dumps.

After a full machine reinstall, restore those separately if you intentionally
use them. Keep request guard in `observe` until you confirm the updated runtime:

```powershell
$env:MAVIS_REQUEST_GUARD_MODE = "observe"
```

Switch to `enforce` only when blocking oversized provider requests is an
accepted outcome.
