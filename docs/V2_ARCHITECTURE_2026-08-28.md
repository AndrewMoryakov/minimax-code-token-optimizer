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

---

# Phase 1: MCP lifecycle and the desktop_* tools inventory

> **Date added:** 2026-08-28, on branch
> `research/phase-1-architecture`. Continues the investigation
> from the v2 architecture document above. All references to
> asar paths in this section are inside `MiniMax
> Code\resources\app.asar`; the bundle is the same one
> referenced above.

## What Phase 1 closed

The original `V2_ARCHITECTURE_2026-08-28.md` established *what*
runs (matrix stdio, no HTTP MCP). Phase 1 closes the *how*:

1. How v2 loads MCP server config (the `LocalMcpService`
   lifecycle).
2. The complete inventory of `cu` tools (25 of them, the
   `desktop_*` family).
3. Whether a `cu-mcp.ts` adapter already exists that we could
   build on (it does not — the comment in `cu-tool-defs.ts` is
   aspirational).

These findings change the size of the H1 option in the
backlog: building a `cu-mcp-stdio.js` is now a **~50-100 line
file**, not 200-300.

## MCP loading: `LocalMcpService` in `api.ts` (1824 lines, partial)

The full v2 MCP surface lives in
`@mavis/local-runtime/src/mcp/api.ts`. Key findings from a
focused read of the first 350 lines:

- **Class:** `LocalMcpService` (line 242). Owns the mcp.json
  parse cache (`lastReadFile`), public runtime status
  (`publicRuntimeErrors`, `publiclyAvailableServers`), session
  overlay (`sessionServers`), and change-notification
  listeners.
- **Two file locations checked** for mcp config: from
  `config-file.ts`, the loader reads
  `<dataDir>/mcp.json` and `<dataDir>/mcp/mcp.json`. Both
  must exist or fail-soft.
- **The retirement filter is the same for cu and matrix**:
  `listUserConfiguredServers` (line 304-323) drops any entry
  where `builtin === true` OR
  `isRetiredLegacyMatrixMcpServerConfig(name, config)` OR
  `isRetiredLegacyCuMcpServerConfig(name, config)`. Same
  filter in `setUserConfiguredServerEnabled` (line 339-345)
  and in the public-status normalizer (line 1137-1138).
- **Matrix has a second path that bypasses the filter**:
  `buildBuiltinMatrixServerConfig` (already documented in
  Evidence #2 above) injects matrix back as a built-in
  server regardless of `mcp.json`. That is why matrix runs
  while the user-config cu/trash entries in `mcp.json` are
  silently dropped.
- **Session MCP servers are not subject to the retirement
  filter.** `configureSessionServers` (line 271-296) accepts
  any non-builtin config and rejects only configs where
  `configToTransportConfig` returns `undefined` (i.e. no
  `command` AND no `url`). This means a session-ephemeral
  cu/trash server could in principle be created at runtime
  via API — but no UI surface currently exposes that.

### Transport mapping (from `config.ts`)

`configToTransportConfig(config)` is the single chokepoint
that converts a normalized `LocalMcpServerConfig` into a
runtime `TransportConfig`:

| config.type     | Required field | Result transport |
| --------------- | -------------- | ---------------- |
| `stdio`         | `command`      | `stdio`          |
| (none) + `command` | `command`  | `stdio`          |
| `sse`           | `url`          | `sse`            |
| `http` / `streamable-http` | `url` | `http`    |
| (none) + `url`  | `url`          | `http`           |
| anything else   | —              | `undefined` (entry fails closed) |

This is why the `trash` entry in `mcp.json` (with
`type: "streamable-http"`, `url: "http://127.0.0.1:15321/..."`)
maps to a valid transport on paper. The retirement filter
intercepts it before transport construction happens.

### Public façade (`public-facade.ts`)

`LocalMcpPublicFacade` is a thin adapter exposing
`listLocalMcpServers`, `listMcpCapabilities`,
`configureSessionServers`, `clearSessionServers` to the rest
of the runtime. It does not start MCP servers itself; it
delegates to `LocalMcpService`. The UI/Thrift server (Hono
in `http/server.ts`) calls this façade, never `LocalMcpService`
directly.

### Transport implementations live elsewhere

The four files under
`@mavis/local-runtime/src/mcp/runtime/transport/` are
**re-exports from `@mavis/mcp`**:

- `factory.ts` (110 bytes) — `createTransport` re-export
- `http.ts` (214 bytes) — `createHttpTransport` re-export
- `stdio.ts` (220 bytes) — `createStdioTransport` re-export
- `connection-pool.ts` (132 bytes) — `McpConnectionPool`
  re-export
- `types.ts` (475 bytes) — full re-export of
  `@mavis/mcp/runtime/types`

This is the v1 layer's "facade over @mavis/mcp" pattern. The
actual transport logic (stdio child spawn, HTTP retry, JSON-RPC
framing) lives in the separate `@mavis/mcp` package.

## `cu` source tree: still alive, never wired to MCP

A re-confirmation of the prior finding, with one new wrinkle:

```
@Mavis/local-runtime/src/cu/
├── cu-tool-defs.ts          (18.8 KB — single source of truth)
├── cu-runtime-tools.ts      (9.2 KB  — RuntimeTool[] adapter)
├── cu-screenshot-pruner.ts  (4.9 KB)
├── gate.ts                  (1.3 KB)
└── (no cu-mcp.ts)
```

The `cu-tool-defs.ts` header explicitly states (line 4-7):

> Each entry declares the LLM-facing tool contract (name,
> description, TypeBox schema) AND the runtime wiring (action,
> hasImage, buildInput) so both **the MCP server
> (`cu-mcp.ts`)** and the native RuntimeTool adapter
> (`cu-runtime-tools.ts`) consume the same single source of
> truth.

**`cu-mcp.ts` does not exist** in the asar. The reference is
aspirational. So if H1 is taken ("build `cu-mcp-stdio.js`"),
the implementation is **the missing `cu-mcp.ts`** — a small
adapter that iterates `CU_TOOL_DEFS`, registers each as an
MCP tool with its TypeBox schema, and delegates calls to
`execute()` from `@mavis/local-runtime/src/services/cu/`.

The other side — the native `cu-runtime-tools.ts` — is
already a complete `RuntimeTool[]` adapter that PiTurnRunner
consumes directly. It is wired through
`@mavis/local-runtime/src/services/cu/` (`index.ts`,
`native.ts`, `state.ts`), and gated on the renderer's
`isEnabled()` toggle. So **Computer Use works in-process for
in-app sessions** (the agent can drive the desktop via
direct RuntimeTool calls), but does not work for sessions
that come in via a separate MCP process (like a remote
agent or a multi-agent setup where cu would need to be
exposed as MCP).

## Complete `desktop_*` tool inventory (25 tools, from `cu-tool-defs.ts`)

All 25 tools in `CU_TOOL_DEFS`. Coordinates are 0-1000
normalized (top-left = [0,0], center = [500,500], bottom-right
= [1000,1000]). Tools marked `hasImage: true` return image
content (used for visual feedback to the model).

### Screenshots and zoom (3, all `hasImage: true`)

| Tool | Action | Input | Purpose |
| --- | --- | --- | --- |
| `desktop_screenshot` | `screenshot` | `task_description?` | Full primary display |
| `desktop_screenshot_region` | `screenshot_region` | `region: {x,y,width,height}` | Rectangular crop |
| `desktop_zoom` | `zoom` | `region` | Sub-region at full resolution |

### Cursor (2)

| Tool | Action | Input | Purpose |
| --- | --- | --- | --- |
| `desktop_cursor_position` | `cursor_position` | (none) | Read cursor coords |
| `desktop_mouse_move` | `mouse_move` | `coordinate \| (x,y)` | Move without click |

### Click family (5)

| Tool | Action | Input | Purpose |
| --- | --- | --- | --- |
| `desktop_left_click` | `left_click` | `coordinate? \| (x,y)?` | Single left click |
| `desktop_right_click` | `right_click` | same | Right click |
| `desktop_middle_click` | `middle_click` | same | Middle click |
| `desktop_double_click` | `double_click` | same | Double left |
| `desktop_triple_click` | `triple_click` | same | Triple left |

### Drag / press (3)

| Tool | Action | Input | Purpose |
| --- | --- | --- | --- |
| `desktop_left_click_drag` | `left_click_drag` | `coordinate + start_coordinate?` | Drag from start to end |
| `desktop_left_mouse_down` | `left_mouse_down` | `coordinate?` | Press without release |
| `desktop_left_mouse_up` | `left_mouse_up` | `coordinate?` | Release |

### Scroll (1)

| Tool | Action | Input | Purpose |
| --- | --- | --- | --- |
| `desktop_scroll` | `scroll` | `coordinate? + direction ∈ {up,down,left,right} + amount?` | Mouse wheel |

### Keyboard (4)

| Tool | Action | Input | Purpose |
| --- | --- | --- | --- |
| `desktop_type` | `type` | `text: string` | UTF-8 type |
| `desktop_key` | `key` | `combo: string` | Single key or combo (`ctrl+c`, `cmd+space`) |
| `desktop_hold_key` | `hold_key` | `combo + duration_ms (1-30000)` | Hold + release |
| `desktop_wait` | `wait` | `duration_ms (0-30000)` | Sleep |

### Window manager (5)

| Tool | Action | Input | Purpose |
| --- | --- | --- | --- |
| `desktop_window_list` | `window_list` | (none) | List windows with id + title |
| `desktop_window_focus` | `window_focus` | `window_id? \| window_title?` | Bring to foreground |
| `desktop_window_minimize` | `window_minimize` | same | Minimize |
| `desktop_window_move` | `window_move` | `bounds: {x,y,w,h} + window_id? \| window_title?` | Move + resize |
| `desktop_window_resize` | `window_resize` | same | Resize + reposition |

### Clipboard (2)

| Tool | Action | Input | Purpose |
| --- | --- | --- | --- |
| `desktop_clipboard_read` | `clipboard_read` | (none) | Read clipboard text |
| `desktop_clipboard_write` | `clipboard_write` | `text: string` | Write to clipboard |

### Common coordinate resolution helper

The `resolveCoord(coordinate, x, y)` helper accepts both the
preferred `coordinate: [x, y]` tuple and the legacy `x` + `y`
fields. Tuples are first-class; legacy fields exist for
backward compatibility. Models should use tuples.

### Schema choices that matter for LLM clients

- All coordinate fields are **0-1000 integers**, not 0-1
  floats. The descriptions explicitly say *"Use 500 for
  center, not 0.5."*
- `desktop_wait` and `desktop_hold_key` cap at 30 s. Long
  waits need repeated calls.
- `desktop_key` uses nut-js / mmx key name conventions
  (`"Return"`, `"Escape"`, `"ctrl+c"`); the LLM should not
  invent key names.
- All screenshot-region tools use the same `Region` schema
  (normalized coordinates, exclusive-minimum width/height).
- Window operations use **absolute pixel bounds** for
  `BoundsSchema` (x, y, width, height are plain integers)
  but the screenshots use **normalized 0-1000**. This
  asymmetry is by design but worth knowing.

## What this changes in the backlog

### H1 (re-estimated)

The original H1 said "build `cu-mcp-stdio.js`" was 200-300
lines. With the new information:

- A `cu-mcp.ts` adapter that consumes `CU_TOOL_DEFS` and
  registers each as an MCP tool, delegating to
  `services/cu/index.ts:execute()`, is approximately **50-100
  lines**.
- The "stdio" plumbing (`process.execPath` + `args:[entrypoint]`)
  is already a one-liner pattern in `builtin-matrix.ts`.
- The H1 estimate is now **half a day at most**, not half a
  day to a full day.
- **The work still belongs in the upstream Mavis repo**, not
  in `minimax-code-token-optimizer`.

### H1 alternative: "session MCP" instead of "stdio"

`LocalMcpService.configureSessionServers` accepts a `cu`
server with the same transport rules as a regular MCP. If
a user-facing surface (likely the "Tools" tab in the
desktop UI) lets a session add cu as a session-ephemeral
MCP, the retirement filter does not block it. This is a
**second, lighter option** to bring cu back without writing
any new code — only a UI affordance. Effort: a few hours of
desktop UI work, not a stdio adapter. Trade-off: cu is only
available for the lifetime of the session, not globally.

## Reproduction

```powershell
# Extract targeted files (note: extract-file drops to CWD)
$asar = 'C:\Users\hopt\AppData\Local\Programs\MiniMax Code\resources\app.asar'
Set-Location F:\Temp\asar-phase1  # or anywhere outside Desktop
& 'C:\Program Files\nodejs\npx.cmd' --no asar extract-file $asar 'node_modules/@mavis/local-runtime/src/mcp/api.ts'
& 'C:\Program Files\nodejs\npx.cmd' --no asar extract-file $asar 'node_modules/@mavis/local-runtime/src/mcp/config.ts'
& 'C:\Program Files\nodejs\npx.cmd' --no asar extract-file $asar 'node_modules/@mavis/local-runtime/src/mcp/cu/cu-tool-defs.ts'

# Confirm cu-mcp.ts does NOT exist
& 'C:\Program Files\nodejs\npx.cmd' --no asar list $asar |
  Select-String -Pattern 'cu-mcp' -SimpleMatch
# (no output expected)

# Confirm retirement filter applies to BOTH cu and matrix
Get-Content api.ts | Select-String -Pattern 'isRetiredLegacy' |
  Select-Object LineNumber, Line | Format-Table -AutoSize
```

## What this does NOT cover

- `@mavis/local-runtime-v2/src/` — the v2 successor module
  that supersedes `local-runtime` for the active runtime
  path. We extracted its `package.json` only (v0.1.0). The
  actual application code (`dist/application/`,
  `dist/service/turn-system/agent-host/`) is unexamined.
  Reading those would tell us whether v2 is *really* running
  v2 code or still falling back to v1.
- `@mavis/mcp/runtime/` — the actual transport / connection
  pool / RPC implementation behind the v1-layer re-exports.
  We see the façade; the implementation is opaque. This
  matters for understanding stdio child lifecycle and
  shutdown.
- The cu `services/cu/{index,native,state}.ts` — the actual
  `execute()` dispatcher that all 25 desktop_* tools route
  through. Needed to size the "build `cu-mcp.ts`" effort
  precisely.

These belong in Phase 6 of the research plan (synthesis) or
a follow-up Phase 1.5 if H1 is taken.
