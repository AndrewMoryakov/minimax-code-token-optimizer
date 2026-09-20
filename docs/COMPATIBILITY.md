# Compatibility And Safety

This project is Windows-first and patches a local MiniMax Code Desktop install.
It does not redistribute MiniMax vendor bundles.

## Supported MiniMax Generations

| Generation | Shape | Status |
|---|---|---|
| v1 | `…\resources\resources\daemon\node_modules\@mavis\opencode-plugin\index.js` exists | patchable |
| v2 | `app.asar` carries `@mavis/local-runtime`, no opencode-plugin bundle | **out of scope, installer refuses** |

`detectInstallLayout` in `scripts/lib/install-layout.mjs` reads only the asar
header (a few MB of a ~480 MB archive) and reports the generation as
`install_layout=` in `diagnose-install.mjs`. Verified on Mavis 3.0.68.134:
`install_layout=v2-local-runtime`, detection took ~0.7 s.

On v2 the standalone plugins, `policy.json` and every `MAVIS_*` environment
variable are inert: no packed file in `app.asar` references them.

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

- The patched source is parse-checked before it is written, as a module and
  then as CommonJS. If neither parses, nothing is written and the target keeps
  its bytes.
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

