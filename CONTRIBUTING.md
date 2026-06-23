# Contributing

Thanks for helping improve MiniMax Code Token Optimizer.

This project is a redistributable patch toolkit for MiniMax Code / Mavis token
optimization. Please keep contributions small, testable, and safe for users who
are not familiar with MiniMax internals.

## Development Setup

```powershell
git clone https://github.com/AndrewMoryakov/minimax-code-token-optimizer.git
cd minimax-code-token-optimizer
node .\scripts\diagnose-install.mjs
node .\scripts\test-patcher.mjs
```

MiniMax Code should already be installed if you want to test against a real
local bundle.

## Before Opening a Pull Request

Run:

```powershell
node .\scripts\test-patcher.mjs
node .\scripts\check-repo.mjs
node .\scripts\install.mjs --profile max --dry-run
```

If your change touches installed-bundle transforms, also run:

```powershell
node .\scripts\analyze-bundle.mjs --json
node .\scripts\verify-installed.mjs
```

## Contribution Guidelines

- Do not commit MiniMax vendor bundle files.
- Do not commit API keys, tokens, `.env` files, ledgers, logs, or request dumps.
- Keep patcher transforms anchored and compatibility-gated.
- Prefer dry-run and diagnostic output before mutating a user's installation.
- Document any new environment variable in `README.md`.
- Add or update tests when changing patcher behavior.
- Treat prompt-cache savings as unproven unless usage data shows cache writes
  or reads.
- Keep Windows PowerShell examples working; this is the primary supported
  environment.

## Good First Contributions

- Improve compatibility diagnostics for new MiniMax Code versions.
- Add safer dry-run output.
- Improve README examples for first-time users.
- Add tests for existing patcher stages.
- Improve request guard reporting without changing its default `observe` mode.

## Review Expectations

Pull requests should explain:

- what user problem is solved;
- what files can be modified on disk;
- how the change was tested;
- whether the change affects runtime requests, provider routing, or token
  accounting.

Small, boring, well-tested changes are strongly preferred.
