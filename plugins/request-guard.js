// request-guard.js
// Provider request preflight guard. Default mode is observe: log oversized
// request bodies before they reach MiniMax/OpenRouter. Set
// MAVIS_REQUEST_GUARD_MODE=enforce to block requests above byte thresholds.

const mode = normalizeMode(process.env.MAVIS_REQUEST_GUARD_MODE || "observe");
const disabled = process.env.MAVIS_REQUEST_GUARD_DISABLED === "1" || mode === "off";

const DEFAULT_LIMITS = Object.freeze({
  minimax: { bodyBytes: 200000, messageBytes: 180000 },
  openrouter: { bodyBytes: 80000, messageBytes: 80000 },
});

function normalizeMode(value) {
  return ["observe", "enforce", "off"].includes(value) ? value : "observe";
}

function envNumber(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function limitsFor(provider) {
  const key = provider === "openrouter" ? "OPENROUTER" : "MINIMAX";
  const defaults = DEFAULT_LIMITS[provider] || DEFAULT_LIMITS.minimax;
  return {
    bodyBytes: envNumber(`MAVIS_REQUEST_GUARD_${key}_MAX_BODY_BYTES`, defaults.bodyBytes),
    messageBytes: envNumber(`MAVIS_REQUEST_GUARD_${key}_MAX_MESSAGE_BYTES`, defaults.messageBytes),
  };
}

function log(event, payload = {}) {
  try {
    process.stderr.write(
      "[request-guard] " +
        event +
        " " +
        JSON.stringify({ ts: new Date().toISOString(), mode, ...payload }) +
        "\n"
    );
  } catch (_) {}
}

function targetProvider(url, init) {
  if (!url || typeof url !== "string") return null;
  if (init?.method && init.method.toUpperCase() !== "POST") return null;
  try {
    const parsed = new URL(url, "http://placeholder.local");
    if (parsed.hostname === "agent.minimax.io" && /\/v1\/messages(\?|$)/.test(parsed.pathname)) return "minimax";
    if (parsed.hostname === "openrouter.ai" && /\/api\/v1\/chat\/completions(\?|$)/.test(parsed.pathname)) return "openrouter";
    return null;
  } catch (_) {
    return null;
  }
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (_) {
    return 0;
  }
}

function summarizeBody(bodyText) {
  const summary = {
    bodyBytes: Buffer.byteLength(String(bodyText || ""), "utf8"),
    parseOk: false,
    model: null,
    messageBytes: 0,
    systemBytes: 0,
    toolBytes: 0,
    messagesCount: 0,
    toolsCount: 0,
  };
  try {
    const parsed = JSON.parse(bodyText);
    summary.parseOk = true;
    summary.model = typeof parsed.model === "string" ? parsed.model : null;
    summary.messageBytes = jsonBytes(parsed.messages);
    summary.systemBytes = jsonBytes(parsed.system);
    summary.toolBytes = jsonBytes(parsed.tools);
    summary.messagesCount = Array.isArray(parsed.messages) ? parsed.messages.length : 0;
    summary.toolsCount = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
  } catch (_) {}
  return summary;
}

function decision(provider, summary) {
  const limits = limitsFor(provider);
  const reasons = [];
  if (summary.bodyBytes > limits.bodyBytes) {
    reasons.push(`bodyBytes ${summary.bodyBytes} > ${limits.bodyBytes}`);
  }
  if (summary.messageBytes > limits.messageBytes) {
    reasons.push(`messageBytes ${summary.messageBytes} > ${limits.messageBytes}`);
  }
  return {
    overBudget: reasons.length > 0,
    reasons,
    limits,
  };
}

function blockedResponse(provider, summary, verdict) {
  const body = JSON.stringify({
    error: {
      type: "mavis_request_guard_blocked",
      message: `Request blocked by request-guard for ${provider}: ${verdict.reasons.join("; ")}`,
      provider,
      summary,
      limits: verdict.limits,
    },
  });
  return new Response(body, {
    status: 413,
    statusText: "Request Entity Too Large",
    headers: { "content-type": "application/json" },
  });
}

function installFetchPatch() {
  if (globalThis.__mavisRequestGuardFetchPatched) return;
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== "function") {
    log("fetch_unavailable");
    return;
  }

  globalThis.fetch = async function requestGuardFetch(input, init) {
    const url = typeof input === "string" ? input : input?.url;
    const provider = targetProvider(url, init);
    if (!provider || typeof init?.body !== "string") {
      return origFetch.call(this, input, init);
    }

    try {
      const summary = summarizeBody(init.body);
      const verdict = decision(provider, summary);
      if (verdict.overBudget) {
        log("request_over_budget", {
          provider,
          url,
          action: mode === "enforce" ? "block" : "observe",
          ...summary,
          limits: verdict.limits,
          reasons: verdict.reasons,
        });
        if (mode === "enforce") {
          return blockedResponse(provider, summary, verdict);
        }
      }
    } catch (error) {
      log("failed_open", { message: error instanceof Error ? error.message : String(error) });
    }

    return origFetch.call(this, input, init);
  };

  globalThis.__mavisRequestGuardFetchPatched = true;
  log("fetch_patched");
}

export default async function plugin() {
  if (disabled) {
    log("disabled");
    return {};
  }
  log("loaded", { limits: { minimax: limitsFor("minimax"), openrouter: limitsFor("openrouter") } });
  installFetchPatch();
  return {};
}

plugin.__test = {
  targetProvider,
  summarizeBody,
  decision,
  limitsFor,
};
