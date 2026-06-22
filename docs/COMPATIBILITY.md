# Compatibility And Safety

This project is Windows-first and patches a local MiniMax Code Desktop install.
It does not redistribute MiniMax vendor bundles.

## Supported Shape

The patcher expects recognizable MiniMax/Mavis OpenCode bundle anchors:

- direct-M3 request body patch path;
- prompt-surface profile helpers;
- `transformSystemPrompt` for static prompt compaction;
- `tool.definition` hook for tool-description trimming.

Run:

```powershell
node .\scripts\analyze-bundle.mjs
node .\scripts\diagnose-install.mjs
```

If the bundle is unsupported, the installer stops before writing.

## Safety Rules

- Backups are created before writes.
- Missing anchors stop or skip narrowly; the patcher does not guess broad edits.
- API keys are never required in the repository.
- Prompt-cache savings are not claimed as proven until provider usage reports
  non-zero cache writes/reads.

## Recommended Check

```powershell
node .\scripts\test-patcher.mjs
node .\scripts\check-repo.mjs
node .\scripts\install.mjs --profile max --dry-run
```

