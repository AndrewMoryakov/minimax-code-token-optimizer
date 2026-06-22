// prompt-cache.js
// Phase: 0.5 — Prompt cache investigation. Injects Anthropic-compatible
// cache_control markers into outgoing /messages requests for provider `minimax`.
//
// Modes:
//   MAVIS_PROMPT_CACHE_MODE=observe  -> only log what would be patched
//   MAVIS_PROMPT_CACHE_MODE=enforce  -> actually mutate the request body (default)
//   MAVIS_PROMPT_CACHE_DISABLED=1    -> no fetch patch at all
//
// Breakpoints we add (up to 4 allowed by MiniMax):
//   1. last tool in `tools` array
//   2. last block in `system` array (if array form)
//   3. last text block of last user message (incremental conversation caching)
//
// Loaded AFTER `mavis` in plugin order so Mavis's existing fetch patch
// (thinking mode) runs first and we patch on top.

const disabled = process.env.MAVIS_PROMPT_CACHE_DISABLED === "1";
const mode = process.env.MAVIS_PROMPT_CACHE_MODE || "enforce";
const openrouterCacheEnabled = process.env.MAVIS_PROMPT_CACHE_OPENROUTER === "1";
let openrouterSkipWarned = false;

const log = (event, payload = {}) => {
  try {
    process.stderr.write(
      "[prompt-cache] " +
        event +
        " " +
        JSON.stringify({ ts: new Date().toISOString(), mode, ...payload }) +
        "\n"
    );
  } catch (_) {}
};

if (!disabled) {
  log("loaded", { mode });
}

const TARGET_PATH_RE = /\/v1\/messages(\?|$)/;
const TARGET_HOST = "agent.minimax.io";
const OPENROUTER_HOST = "openrouter.ai";
const OPENROUTER_PATH_RE = /\/api\/v1\/chat\/completions(\?|$)/;

function requestTarget(url, init) {
  if (!url || typeof url !== "string") return false;
  if (init?.method && init.method.toUpperCase() !== "POST") return false;
  try {
    const u = new URL(url, "http://placeholder.local");
    if (TARGET_HOST === u.hostname && TARGET_PATH_RE.test(u.pathname)) return "minimax";
    if (
      openrouterCacheEnabled &&
      OPENROUTER_HOST === u.hostname &&
      OPENROUTER_PATH_RE.test(u.pathname)
    ) {
      return "openrouter";
    }
    return null;
  } catch (_) {
    return null;
  }
}

function isTargetRequest(url, init) {
  return requestTarget(url, init) === "minimax";
}

function annotateTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, added: 0 };
  const out = tools.map((t) => ({ ...t }));
  const last = out[out.length - 1];
  if (!last.cache_control) {
    last.cache_control = { type: "ephemeral" };
    return { tools: out, added: 1 };
  }
  return { tools: out, added: 0 };
}

function annotateSystem(system) {
  if (typeof system === "string" && system.length > 0) {
    return {
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      added: 1,
    };
  }
  if (!Array.isArray(system) || system.length === 0) return { system, added: 0 };
  const out = system.map((b) => ({ ...b }));
  const last = out[out.length - 1];
  if (!last.cache_control) {
    last.cache_control = { type: "ephemeral" };
    return { system: out, added: 1 };
  }
  return { system: out, added: 0 };
}

function annotateLastUserMessage(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, added: 0 };
  // walk back to last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    if (typeof m.content === "string") {
      m.content = [
        { type: "text", text: m.content, cache_control: { type: "ephemeral" } },
      ];
      return { messages, added: 1 };
    }
    if (Array.isArray(m.content) && m.content.length > 0) {
      const lastBlock = m.content[m.content.length - 1];
      if (!lastBlock.cache_control) {
        lastBlock.cache_control = { type: "ephemeral" };
        return { messages, added: 1 };
      }
      return { messages, added: 0 };
    }
    return { messages, added: 0 };
  }
  return { messages, added: 0 };
}

function warnOpenRouterSkipped() {
  if (openrouterSkipWarned) return;
  openrouterSkipWarned = true;
  console.warn("[prompt-cache] openrouter: skipped, unexpected shape");
}

function cloneTextBlocksWithCacheControl(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const out = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object" || Array.isArray(block)) return null;
    if (block.type !== "text" || typeof block.text !== "string") return null;
    out.push({ ...block });
  }
  const last = out[out.length - 1];
  if (!last.cache_control) {
    last.cache_control = { type: "ephemeral" };
  }
  return out;
}

function systemToOpenRouterMessage(system) {
  if (typeof system === "string" && system.trim()) {
    return {
      role: "system",
      content: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
    };
  }
  const content = cloneTextBlocksWithCacheControl(system);
  return content ? { role: "system", content } : null;
}

function patchOpenRouterBody(parsed) {
  // TODO: openrouter-cache-format - explicit cache_control is documented, but
  // model/provider paths vary; this branch is opt-in via MAVIS_PROMPT_CACHE_OPENROUTER=1.
  if (!Array.isArray(parsed.messages)) {
    warnOpenRouterSkipped();
    return { parsed, breakpointsAdded: 0 };
  }

  const messages = parsed.messages.map((m) => ({ ...m }));
  let added = 0;

  if (Object.prototype.hasOwnProperty.call(parsed, "system")) {
    const systemMessage = systemToOpenRouterMessage(parsed.system);
    if (!systemMessage) {
      warnOpenRouterSkipped();
      return { parsed, breakpointsAdded: 0 };
    }
    delete parsed.system;
    messages.unshift(systemMessage);
    added += 1;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    if (typeof message.content !== "string") {
      warnOpenRouterSkipped();
      return { parsed, breakpointsAdded: 0 };
    }
    message.content = [
      { type: "text", text: message.content, cache_control: { type: "ephemeral" } },
    ];
    parsed.messages = messages;
    return { parsed, breakpointsAdded: added + 1 };
  }

  warnOpenRouterSkipped();
  return { parsed, breakpointsAdded: 0 };
}

function patchBody(bodyText, target = "minimax") {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (_) {
    return { body: bodyText, breakpointsAdded: 0, parseError: true, details: {} };
  }

  if (target === "openrouter") {
    try {
      const patched = patchOpenRouterBody(parsed);
      return {
        body: JSON.stringify(patched.parsed),
        breakpointsAdded: patched.breakpointsAdded,
        parseError: false,
        details: { target: "openrouter", messages: patched.breakpointsAdded },
      };
    } catch (_) {
      return { body: bodyText, breakpointsAdded: 0, parseError: false, details: { target: "openrouter", error: true } };
    }
  }

  let added = 0;
  const details = {
    target: "minimax",
    toolsCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    systemShape: typeof parsed.system === "string" ? "string" : Array.isArray(parsed.system) ? "array" : typeof parsed.system,
    messagesCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
    tools: 0,
    system: 0,
    lastUser: 0,
  };
  const t = annotateTools(parsed.tools);
  if (t.added) {
    parsed.tools = t.tools;
    added += t.added;
    details.tools = t.added;
  }
  const s = annotateSystem(parsed.system);
  if (s.added) {
    parsed.system = s.system;
    added += s.added;
    details.system = s.added;
  }
  const m = annotateLastUserMessage(parsed.messages);
  if (m.added) {
    parsed.messages = m.messages;
    added += m.added;
    details.lastUser = m.added;
  }
  return { body: JSON.stringify(parsed), breakpointsAdded: added, parseError: false, details };
}

function installFetchPatch() {
  if (globalThis.__promptCacheFetchPatched) return;
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== "function") {
    log("fetch_unavailable");
    return;
  }
  globalThis.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const target = requestTarget(url, init);
    if (!target) {
      return origFetch.call(this, input, init);
    }
    let body = init?.body;
    let modifiedInit = init;
    let patched = null;
    if (typeof body === "string" && body.length > 0) {
      patched = patchBody(body, target);
      if (patched.parseError) {
        log("body_parse_error", { url });
        return origFetch.call(this, input, init);
      }
      if (patched.breakpointsAdded > 0) {
        if (mode === "enforce") {
          modifiedInit = { ...init, body: patched.body };
          log("enforce_patched", {
            url,
            breakpointsAdded: patched.breakpointsAdded,
            details: patched.details,
          });
        } else {
          log("observe_would_patch", {
            url,
            breakpointsAdded: patched.breakpointsAdded,
            details: patched.details,
          });
        }
      } else {
        log("no_breakpoints_needed", { url, details: patched.details });
      }
    }

    let response;
    try {
      response = await origFetch.call(this, input, modifiedInit);
    } catch (e) {
      // Network / abort errors propagate; nothing we can do at this layer.
      throw e;
    }

    // In enforce mode, if the provider rejects our cache markers (4xx), fail
    // open by retrying without the patch. Otherwise a single incompatible
    // marker would break every model call until the operator intervenes.
    if (
      mode === "enforce" &&
      patched &&
      patched.breakpointsAdded > 0 &&
      response.status >= 400 &&
      response.status < 500
    ) {
      log("retry_unpatched_on_provider_error", { url, status: response.status });
      try { await response.arrayBuffer(); } catch (_) {}
      return origFetch.call(this, input, init);
    }
    return response;
  };
  globalThis.__promptCacheFetchPatched = true;
  log("fetch_patched");
}

export default async function plugin(_input) {
  if (disabled) {
    log("disabled");
    return {};
  }
  installFetchPatch();
  return {};
}

plugin.__test = {
  patchBody,
  requestTarget,
};
