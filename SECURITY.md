# Security Policy

## Status

This project is experimental, Windows-first, and community-maintained. It is not
an official MiniMax product.

The optimizer patches a local MiniMax Code installation by applying guarded
source transforms to files already present on the user's machine. This
repository does not ship MiniMax vendor bundles, API keys, or private runtime
logs.

## Supported Versions

Security fixes target the current `main` branch. Older commits are not
maintained as separate release lines.

## Reporting a Vulnerability

Please report security issues privately before opening a public issue if the
report includes:

- API keys, tokens, cookies, or account identifiers;
- local file paths containing private project names;
- request/response bodies with user prompts or code;
- a way to corrupt a MiniMax Code installation;
- a way to bypass request guard or safety checks.

Use GitHub private vulnerability reporting if available on the repository. If it
is not available, open a minimal public issue that says a private security
report is needed, without posting secrets or exploit details.

## Secret Handling

Never commit:

- OpenRouter keys;
- MiniMax/Mavis tokens;
- `.env` files;
- `minimax_openrouter_key.txt`;
- local `policy.json` files containing private routing or key paths;
- runtime logs, ledgers, request dumps, or provider payloads.

The repository `.gitignore` excludes common local secret and log patterns, but
contributors are still responsible for checking their diffs before publishing.

## Vendor Code

Do not publish patched MiniMax vendor files in this repository. Patches should
be represented as scripts, anchored transforms, tests, and documentation only.

If a MiniMax update changes bundle anchors, add compatibility tests and update
the patcher instead of pasting vendor source into an issue or pull request.

## Safe Testing

Prefer:

```powershell
node .\scripts\install.mjs --profile max --dry-run
node .\scripts\test-patcher.mjs
node .\scripts\check-repo.mjs
```

Use `MAVIS_REQUEST_GUARD_MODE=observe` until oversized request behavior is
understood. Switch to `enforce` only when blocking provider requests is an
accepted outcome.
