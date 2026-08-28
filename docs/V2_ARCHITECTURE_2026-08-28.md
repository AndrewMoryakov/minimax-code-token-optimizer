# v2 Architecture Investigation — 2026-08-28

## Scope

Follow-up to `MCP_AUDIT_V2_2026-08-28.md`. That doc identified that
1 of 5 MCPs is active (`matrix` via stdio) and `cu` + `trash` HTTP
endpoints on `127.0.0.1:15321` are not serving. This doc goes
deeper: reads the relevant source from `app.asar` to explain *why*
15321 is not bound and what would be required to revive `cu`.

Evidence collected from `MiniMax Code\resources\app.asar`
(475 MB Electron archive) via `npx asar list` and `asar extract`.
Source paths under `@mavis/local-runtime/src/`.

## v2 MCP architecture, in one diagram

```
┌─────────────────────────────────────────────────────────┐
│  Electron main process (MiniMax Code.exe, PID 11160)    │
│  ├── renderer processes (UI windows)                    │
│  ├── utility: gpu / network / crashpad                  │
│  └── utility: NodeService (PID 30648)                   │
│       ├── in-process: local-runtime v2 (TS)             │
│       │   ├── @mavis/local-runtime/src/mcp/             │
│       │   │   ├── builtin-matrix.ts (the ONE live stdio)│
│       │   │   ├── retired-cu.ts (cu marked retired)     │
│       │   │   ├── config.ts, config-file.ts, api.ts     │
│       │   │   ├── public-facade.ts, runtime/...         │
│       │   │   └── ...                                   │
│       │   ├── @mavis/local-runtime/src/http/            │
│       │   │   ├── server.ts (Hono, in-process)          │
│       │   │   ├── routes.ts, desktop-*.ts               │
│       │   │   └── desktop-mcp-service.ts (CRUD API)     │
│       │   ├── @mavis/local-runtime/src/cu/              │
│       │   │   ├── cu-tool-defs.ts, cu-runtime-tools.ts  │
│       │   │   ├── cu-screenshot-pruner.ts, gate.ts      │
│       │   │   └── (cu lives, but no MCP wrapper)        │
│       │   └── ...                                       │
│       └── stdio child: matrix-mcp-stdio.js (PID 16572)  │
│                                                          │
│  No listening TCP ports anywhere (verified via           │
│  Get-NetTCPConnection for all MiniMax/node PIDs).       │
└─────────────────────────────────────────────────────────┘
```

Three things to take from this:

1. **MCP servers are stdio children of the Electron NodeService,
   not HTTP endpoints.** Only one such child is currently running
   (`matrix`).
2. **`desktop-mcp-service.ts` is a CRUD API for managing MCP server
   configurations.** It runs in-process on the NodeService worker,
   bound to no port; it answers Hono HTTP requests inside the same
   process, served through `server.ts`.
3. **`cu` is officially retired.** Its MCP HTTP path is detected at
   config-load time and rejected.

## Evidence #1: `cu` is retired — `@mavis/local-runtime/src/mcp/retired-cu.ts` (911 bytes)

```ts
import type { LocalMcpServerConfig } from './api.js';

export const RETIRED_BUILTIN_CU_SERVER_NAME = 'cu';

export function isRetiredLegacyCuMcpServerConfig(
  server: string,
  config: LocalMcpServerConfig,
): boolean {
  if (server !== RETIRED_BUILTIN_CU_SERVER_NAME || config.builtin !== true) return false;

  if (
    config.metadata?.['mavisBuiltinMcpServer'] === RETIRED_BUILTIN_CU_SERVER_NAME &&
    config.metadata?.['managedBy'] === 'local-runtime'
  ) {
    return true;
  }

  return isRetiredLoopbackCuEndpoint(config.url);
}

function isRetiredLoopbackCuEndpoint(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') &&
      (url.pathname === '/mavis/mcp/cu' || url.pathname === '/mcp/cu')
    );
  } catch {
    return false;
  }
}
```

Implications:

- The function is exported and is the **only** piece of code that
  decides whether a `cu` server is "retired." It is checked at
  config-load time. A server matching either condition (metadata
  flag OR loopback URL pattern) is filtered out before any HTTP
  listener is created.
- The `/mavis/mcp/cu` URL on loopback is treated as the legacy
  signature of the v1 `cu` MCP. `mcp.json` still has exactly that
  pattern, so v2 silently drops the entry.
- This is a deliberate `cu` retirement, not a configuration bug.
  The function is exported from a single file and is the
  authoritative source of truth.

## Evidence #2: how v2 MCP servers actually run — `@mavis/local-runtime/src/mcp/builtin-matrix.ts`

Relevant snippet (lines 32-60):

```ts
const MATRIX_MCP_STDIO_BUNDLED_RELATIVE_PATH = 'matrix-mcp-stdio.js';
const MATRIX_MCP_STDIO_WORKSPACE_RELATIVE_PATH =
  '../../../agent-tools/dist/desktop/matrix-mcp-stdio.js';

export function buildBuiltinMatrixServerConfig(
  context?: LocalMcpRuntimeContext,
  options?: { webSearchOnly?: boolean },
): LocalMcpServerConfig {
  const workspaceRoot = resolveMatrixWorkspaceRoot(context);
  const runtimeEnv = buildBuiltinMatrixRuntimeEnv();
  const entrypoint = resolveMatrixMcpStdioEntrypoint();
  if (!entrypoint) {
    throw new Error('Built-in Matrix MCP stdio entrypoint is unavailable.');
  }
  return {
    type: 'stdio',
    command: process.execPath,            // ← Electron binary, re-used as Node
    args: [entrypoint],                   // ← matrix-mcp-stdio.js
    env: {
      ...runtimeEnv,
      MAVIS_MATRIX_WORKSPACE_ROOT: workspaceRoot,
      ...(context?.routingContext?.bedrockLane
        ? { MAVIS_MATRIX_BEDROCK_LANE: context.routingContext.bedrockLane }
        : {}),
      ...resolveMatrixExtraInputRootsEnv(context),
    },
    builtin: true,
    configured: true,
    enabled: true,
    timeout: BUILTIN_MATRIX_TIMEOUT_MS,  // 1_500_000 ms
    description: 'Built-in Matrix MCP server for local desktop runtime. ...',
  };
}
```

Implications:

- `command: process.execPath` is the same `MiniMax Code.exe` that
  runs the UI. It re-uses it as a Node interpreter (the
  `ELECTRON_RUN_AS_NODE=1` trick, same as `mavis-trash.cmd`).
- The `args: [entrypoint]` is the path to a small JS file that
  implements the MCP server protocol over stdio. For Matrix, the
  file is `matrix-mcp-stdio.js` inside `app.asar` (or its
  workspace-dev equivalent).
- This is the *only* MCP wiring pattern used by v2 for built-ins.
  The same recipe would work for `cu`: write a `cu-mcp-stdio.js`
  that imports the existing `cu-tool-defs.ts` and re-exports each
  tool over MCP stdio.
- HTTP-MCP support (`streamable-http`, `http`, `sse` transport
  variants) exists in the type system
  (`LocalMcpTransport.Http`, `.StreamableHttp`, `.Sse` in
  `desktop-mcp-service.ts`) and is accepted as config input. It
  is **not** the path the v2 runtime takes for built-ins. Custom
  user-installed MCPs can still choose HTTP, but no built-in does.

## Evidence #3: `desktop-mcp-service.ts` is a CRUD API, not a runtime endpoint

File: `@mavis/local-runtime/src/http/desktop-mcp-service.ts`
(197 lines, full read). Excerpts:

```ts
import { HTTPException } from 'hono/http-exception';
import type { HttpServiceContext } from '@mavis/thrift-gen/runtime';

export class DesktopMcpService {
  constructor(private readonly service?: DesktopMcpServiceDeps) {}

  async listLocalMcpServers(ctx, req) { /* delegates to LocalMcpService */ }
  async getLocalMcpServer(ctx, req)    { /* ... */ }
  async createLocalMcpServer(ctx, req) { /* ... */ }
  async updateLocalMcpServer(ctx, req) { /* ... */ }
  async deleteLocalMcpServer(ctx, req) { /* ... */ }
  async setLocalMcpServerEnabled(ctx, req) { /* ... */ }
  async testLocalMcpServer(ctx, req)   { /* ... */ }

  private requireService(): DesktopMcpServiceDeps {
    if (!this.service) {
      throw new HTTPException(503, {
        res: jsonError(503, 'Desktop MCP settings service is not configured.', 'MCP_UNAVAILABLE'),
      });
    }
    return this.service;
  }
  // ...mappers stdio<->http, error handling
}
```

The class is bound to no port directly. It is registered as a
Hono handler in `server.ts`/`routes.ts` (the local-runtime HTTP
server, also in-process). It accepts Thrift-gen request types
and is called from the desktop UI to manage MCP server
configuration: list, get, create, update, delete, enable/disable,
test. It is **not** a transport for MCP traffic — it is the
settings panel's backend.

`toDomainConfig` at line 164 confirms the supported transports
(via `LocalMcpTransport.*`): `Stdio`, `Http`, `StreamableHttp`,
`Sse`. So HTTP is *type-supported*; it just isn't used by any
built-in.

## Evidence #4: the `cu` source code is present and intact

```
@mavis/local-runtime/src/cu/
├── cu-runtime-tools.ts       (runtime helpers)
├── cu-screenshot-pruner.ts   (image-size management)
├── cu-tool-defs.ts           (18.8 KB — likely the full desktop_* tool registry)
└── gate.ts                   (gating / permission logic)
```

This is a complete, working `cu` implementation as an *internal*
runtime module — it is consumed by the local-runtime directly,
not via MCP. To expose `cu` as a stdio MCP server, the natural
work is:

1. Write a new file `cu-mcp-stdio.js` analogous to
   `matrix-mcp-stdio.js` in `@mavis/agent-tools/dist/desktop/`.
2. The file imports the `cu-tool-defs.ts` and registers each tool
   in an MCP server, with `process.stdin`/`process.stdout`
   transport.
3. Add a `buildBuiltinCuServerConfig` to a new
   `@mavis/local-runtime/src/mcp/builtin-cu.ts`, paralleling
   `builtin-matrix.ts`. This will use the same `process.execPath`
   + `args: [entrypoint]` pattern.
4. Update `retired-cu.ts` to no longer mark the `cu` server as
   retired, or to be more selective (e.g. retire only the
   loopback URL pattern, not the new stdio path).

Effort estimate: 200-300 lines + smoke test. Most of the work is
importing the tool defs and wrapping each in MCP `tool()`
registrations.

## Evidence #5: `mcp.json` and its `cu`/`trash` entries

`~/.minimax/mcp/mcp.json` (5 servers, all `enabled: true`):

| Server      | Transport | URL                                              | Retired? |
| ----------- | --------- | ------------------------------------------------ | -------- |
| `matrix`    | stdio     | — (in-asar)                                      | no       |
| `playwright`| stdio     | — (`npx @playwright/mcp@0.0.70`)                 | no       |
| `cu`        | streamable-http | `http://127.0.0.1:15321/mavis/mcp/cu`      | **yes**  |
| `trash`     | streamable-http | `http://127.0.0.1:15321/mavis/mcp/trash`   | **yes**  |
| `bridge`    | stdio     | — (user-installed at `O:\user files\...`)         | no       |

A diff against the `mcp.json.backup-20260718-140815` (made on
2026-07-18, before this session) shows only one change: the
`bridge` server was added on top of the original 4. `cu` and
`trash` URLs are identical to the backup. So:

- The `cu` and `trash` HTTP entries have been in the config since
  at least 2026-07-18.
- They are v1 leftover config. v2 detects them as retired and
  skips them. No code path tries to start an HTTP server on
  15321 for them.
- The `trash` MCP is functionally **superseded** by
  `~/.minimax/bin/mavis-trash.cmd`, which uses the same
  `process.execPath` + `ELECTRON_RUN_AS_NODE=1` trick and is
  documented as the "no need to go through `mavis mcp call`" path
  in the MCP's own description.
- The `cu` MCP has no fallback. Desktop Computer Use is
  unavailable until a stdio wrapper is written (Evidence #4).

## Why the patcher is irrelevant (re-stated, with evidence)

`scripts/apply-mavis-opencode-optimizations.mjs` in this repo
targets `…\resources\daemon\node_modules\@mavis\opencode-plugin\index.js`.
That path has two problems on this Mavis:

1. **`daemon/` is a v1 path.** v2's code lives at
   `resources/app.asar/node_modules/@mavis/...` directly, with no
   `daemon/` subdirectory.
2. **The patcher is for opencode plugins, but v2 has no opencode
   plugin system.** v2 uses MCP. Patching the opencode entry
   does not affect any live code path.

The patcher's lock check (PR #1) is still useful: it prevents
half-applied states on machines that *do* have the v1 path. The
patcher itself will not be reactivated on v2.

## Reproduction

```powershell
# List @mavis/local-runtime mcp/ dir
& 'C:\Program Files\nodejs\npx.cmd' --no asar list 'C:\Users\hopt\AppData\Local\Programs\MiniMax Code\resources\app.asar' |
  Select-String -Pattern '\\mavis\\local-runtime\\src\\mcp\\'

# Extract one file (extracts to CWD as a file with the same basename)
& 'C:\Program Files\nodejs\npx.cmd' --no asar extract-file 'C:\Users\hopt\AppData\Local\Programs\MiniMax Code\resources\app.asar' 'node_modules/@mavis/local-runtime/src/mcp/retired-cu.ts'

# Confirm no listening sockets from MiniMax
Get-NetTCPConnection -State Listen |
  Where-Object { $_.OwningProcess -in (Get-Process | Where-Object { $_.ProcessName -like '*MiniMax*' }).Id } |
  Select-Object LocalAddress, LocalPort
# (no output expected)

# Find the running stdio MCP
Get-CimInstance Win32_Process -Filter "Name='MiniMax Code.exe'" |
  Where-Object { $_.CommandLine -like '*matrix-mcp-stdio*' } |
  Select-Object ProcessId, CommandLine
# Expected: PID 16572 (matrix-mcp-stdio.js)
```

## What changes in the optimization backlog

- **H1** ("Bring MCP `cu` (Computer Use) back online") is reframed.
  The real choice is **accept retired** vs **build a `cu-mcp-stdio.js`**.
  Building it is a small, well-scoped code task (see Evidence #4)
  that lives in the upstream Mavis repo, not in this
  `minimax-code-token-optimizer` repo.
- **H2** ("Fix `trash` MCP and remove the `mavis-trash` CLI
  workaround") is reframed. The `trash` MCP is permanently
  retired; `mavis-trash.cmd` is the working path. The
  "workaround" framing is wrong — the CLI is the intended path.
  The right action is to **document this in the project, not
  "fix" the MCP**.
- **New finding (no separate item needed):** the patcher is dead
  in v2 by design. The "71% reduction" headline in the README
  is v1-only.

These are reflected in the rebuilt `OPTIMIZATION_BACKLOG.md` in
the same commit.
