// openrouter-lifecycle.js
// Injects an OpenRouter provider and routes OpenCode lifecycle agents to
// different models without storing the OpenRouter API key in opencode.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROVIDER_ID = "openrouter";
const BASE_URL = "https://openrouter.ai/api/v1";
const KEY_FILE = path.join(os.homedir(), "Desktop", "minimax_openrouter_key.txt");
const POLICY_FILE = path.join(os.homedir(), ".mavis", "agents", "mavis", "context-budget", "config", "policy.json");
const AUDIT_FILE = path.join(os.homedir(), ".mavis", "agents", "mavis", "context-budget", "ledger", "openrouter-lifecycle-audit.jsonl");
const AUDIT_KEY = "__openrouterLifecycleAuditWritten";

const ROUTING = Object.freeze({
  main: "openrouter/minimax/minimax-m3",
  small: "openrouter/qwen/qwen3-30b-a3b-instruct-2507",
  plan: "openrouter/deepseek/deepseek-v3.2",
  build: "openrouter/minimax/minimax-m3",
  general: "openrouter/deepseek/deepseek-v4-flash",
  explore: "openrouter/deepseek/deepseek-v4-flash",
});

const MODELS = Object.freeze({
  "minimax/minimax-m3": {
    name: "MiniMax M3 via OpenRouter",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    limit: { context: 1048576, output: 128000 },
    modalities: { input: ["text"], output: ["text"] },
  },
  "deepseek/deepseek-v3.2": {
    name: "DeepSeek V3.2 via OpenRouter",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    limit: { context: 131072, output: 64000 },
    modalities: { input: ["text"], output: ["text"] },
  },
  "deepseek/deepseek-v4-flash": {
    name: "DeepSeek V4 Flash via OpenRouter",
    attachment: false,
    reasoning: true,
    temperature: true,
    tool_call: true,
    limit: { context: 1048576, output: 64000 },
    modalities: { input: ["text"], output: ["text"] },
  },
  "qwen/qwen3-30b-a3b-instruct-2507": {
    name: "Qwen3 30B A3B Instruct via OpenRouter",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    limit: { context: 131072, output: 32000 },
    modalities: { input: ["text"], output: ["text"] },
  },
});

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function readPolicy() {
  const policyPath = process.env.MAVIS_OPENROUTER_LIFECYCLE_POLICY_CONFIG || POLICY_FILE;
  const policy = readJsonFile(policyPath);
  return policy && typeof policy === "object" ? policy.openrouter_lifecycle || {} : {};
}

function readKey() {
  const fromEnv = process.env.OPENROUTER_API_KEY || process.env.MAVIS_OPENROUTER_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return { value: fromEnv.trim(), source: "env" };
  }

  const keyFile = process.env.MAVIS_OPENROUTER_KEY_FILE || KEY_FILE;
  try {
    const fromFile = fs.readFileSync(keyFile, "utf8").trim();
    return fromFile ? { value: fromFile, source: keyFile === KEY_FILE ? "desktop-file" : "env-file" } : null;
  } catch (_) {
    return null;
  }
}

function lifecycleEnabled(policy) {
  if (process.env.MAVIS_OPENROUTER_LIFECYCLE_DISABLED === "1") {
    return false;
  }
  if (process.env.MAVIS_OPENROUTER_LIFECYCLE_ENABLED === "1") {
    return true;
  }
  return policy.enabled === true;
}

function ensureObject(target, key) {
  if (!target[key] || typeof target[key] !== "object" || Array.isArray(target[key])) {
    target[key] = {};
  }
  return target[key];
}

function selectedModel(policy, name) {
  const envKey = `MAVIS_OPENROUTER_${name.toUpperCase()}_MODEL`;
  return process.env[envKey] || policy?.routing?.[name] || ROUTING[name];
}

function writeAudit(event) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, "utf8");
  } catch (_) {}
}

function auditOnce(event) {
  if (globalThis[AUDIT_KEY]) return;
  globalThis[AUDIT_KEY] = true;
  writeAudit(event);
}

async function plugin() {
  return {
    config: async (config) => {
      const policy = readPolicy();
      if (!lifecycleEnabled(policy)) {
        auditOnce({
          event: "openrouter_lifecycle_disabled",
          reason: process.env.MAVIS_OPENROUTER_LIFECYCLE_DISABLED === "1" ? "env-disabled" : "policy-not-enabled",
        });
        return;
      }

      const apiKey = readKey();
      if (!apiKey?.value) {
        console.error(`[openrouter-lifecycle] OpenRouter key not found at ${KEY_FILE}`);
        auditOnce({
          event: "openrouter_lifecycle_key_missing",
          enabled: true,
          key_source: "missing",
        });
        return;
      }

      const routing = {
        main: process.env.MAVIS_OPENROUTER_MAIN_MODEL || policy?.routing?.main || ROUTING.main,
        small: process.env.MAVIS_OPENROUTER_SMALL_MODEL || policy?.routing?.small || ROUTING.small,
        plan: selectedModel(policy, "plan"),
        build: selectedModel(policy, "build"),
        general: selectedModel(policy, "general"),
        explore: selectedModel(policy, "explore"),
      };

      const provider = ensureObject(config, "provider");
      provider[PROVIDER_ID] = {
        name: "OpenRouter",
        npm: "@ai-sdk/openai-compatible",
        models: MODELS,
        whitelist: Object.keys(MODELS),
        options: {
          apiKey: apiKey.value,
          baseURL: BASE_URL,
        },
      };

      // Preserve explicit minimax/MiniMax-M3 selection from opencode.json so
      // prompt-cache.js can still apply cache_control on agent.minimax.io traffic.
      // Routing table is still consulted for everything else (plan/general/explore/small/build).
      const explicitDirectM3 = config.model === "minimax/MiniMax-M3";
      config.model = explicitDirectM3 ? config.model : routing.main;
      config.small_model = routing.small;

      const agents = ensureObject(config, "agent");
      for (const [agentName, model] of Object.entries(routing)) {
        if (agentName === "main" || agentName === "small") continue;
        agents[agentName] = {
          ...(agents[agentName] || {}),
          model,
        };
      }

      auditOnce({
        event: "openrouter_lifecycle_enabled",
        enabled: true,
        key_source: apiKey.source,
        provider: PROVIDER_ID,
        base_url: BASE_URL,
        prompt_cache_note: "MiniMax prompt-cache fetch patch targets agent.minimax.io by default; OpenRouter traffic is opt-in via MAVIS_PROMPT_CACHE_OPENROUTER=1.",
        routing,
      });
    },

    "chat.headers": async (input, output) => {
      if (input?.provider?.info?.id !== PROVIDER_ID) {
        return;
      }
      output.headers = {
        ...(output.headers || {}),
        "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || "http://localhost",
        "X-Title": process.env.OPENROUTER_APP_TITLE || "Mavis MiniMax Code",
      };
    },
  };
}

plugin.__test = { readKey, readPolicy, lifecycleEnabled, selectedModel, ROUTING, MODELS };

export default plugin;
