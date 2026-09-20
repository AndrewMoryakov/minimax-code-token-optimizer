// Synthetic stand-in for an installed @mavis/opencode-plugin bundle. A fixture,
// not vendor code: it carries the anchors the patcher looks for, and the
// shapes a real bundle has around them.
export const SYNTHETIC_BUNDLE = `function compactDescription(text, maxLen) {
  return typeof text === "string" && text.length > maxLen ? text.slice(0, maxLen) : text;
}
function promptSurfaceLimits() {
  return { profile: "max" };
}
var MEMORY_TAIL_INJECTION_CAP_CHARS = 10240;
var MEMORY_SUMMARY_INJECTION_CAP_CHARS = 20480;
function promptUserProfileCapChars() {
  return MEMORY_TAIL_INJECTION_CAP_CHARS;
}
function promptMemoryTailCapChars() {
  return MEMORY_TAIL_INJECTION_CAP_CHARS;
}
function promptMemorySummaryCapChars() {
  return MEMORY_SUMMARY_INJECTION_CAP_CHARS;
}
var SKILL_TOOL_DESCRIPTION = "Load a skill by name.";
function isMiniMaxPromptCacheTarget(input, init) {
  return true;
}
function annotatePromptCacheTools(tools) {
  return { value: tools, added: 0 };
}
function readRecord(value) {
  return value && typeof value === "object" ? value : undefined;
}
function readString(value) {
  return typeof value === "string" ? value : undefined;
}
function summarizeStringRequestBody(body) {
  const braceInString = "this } brace must not terminate the function scan";
  const base = {
    bodyKind: "string",
    bodyBytes: Buffer.byteLength(body + braceInString.slice(0, 0), "utf8")
  };
  const parsed = JSON.parse(body);
  const tools = Array.isArray(parsed.tools) ? parsed.tools : undefined;
  const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const largestTools = tools?.map((tool2) => ({
    name: tool2?.name ?? "unknown",
    bytes: jsonBytes(tool2)
  })).sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  return {
    ...base,
    largestTools
  };
}
function annotatePromptCacheTextBlock(block) {
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  if (block.type !== "text" || typeof block.text !== "string" || !block.text.trim()) return false;
  if (block.cache_control?.type === "ephemeral") return false;
  block.cache_control = { type: "ephemeral" };
  return true;
}
function annotateLastContentBlock(content) {
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i -= 1) {
      if (annotatePromptCacheTextBlock(content[i])) return true;
    }
  }
  return false;
}
function patchMiniMaxPromptCacheBody(bodyText) {
  const parsed = JSON.parse(bodyText);
  const details = {
    tools: 0,
    system: 0,
    lastUser: 0
  };
  let added = 0;
  let changed = false;
  if (annotateLastContentBlock(parsed.system)) {
    details.lastSystem = 1;
    changed = true;
  }
  if (Array.isArray(parsed.messages)) {
    for (let i = parsed.messages.length - 1; i >= 0; i -= 1) {
      const message = parsed.messages[i];
      if (message?.role === "user" && annotateLastContentBlock(message.content)) {
        details.lastUser = 1;
        changed = true;
        break;
      }
    }
    for (let i = parsed.messages.length - 1; i >= 0; i -= 1) {
      const message = parsed.messages[i];
      if (message?.role === "tool" && annotateLastContentBlock(message.content)) {
        details.lastTool = 1;
        changed = true;
        break;
      }
    }
  }
  const tools = annotatePromptCacheTools(parsed.tools);
  return { body: JSON.stringify(parsed), details, changed, added: added + tools.added };
}
function applyMiniMaxPromptCache(input, init) {
  return { init, mode: "enforce", added: 0, changed: false, details: {} };
}
function extractSessionId() {
  return "synthetic-session";
}
function buildProviderRequestDiagnostic() {
  return {};
}
function logToFile() {}
function installStreamProgressFetchPatch() {
  const current = globalThis.fetch;
  const originalFetch = current.bind(globalThis);
  const wrapped = async (input, init) => {
    const sessionId = extractSessionId(input, init);
    const promptCachePatch = applyMiniMaxPromptCache(input, init);
    const effectiveInit = promptCachePatch.init;
    const requestDiagnostic = sessionId ? buildProviderRequestDiagnostic(input, effectiveInit) : void 0;
    const res = await originalFetch(input, effectiveInit);
    return requestDiagnostic ? res : res;
  };
  globalThis.fetch = wrapped;
}
function injectDynamicBlocks() {}
function transformSystemPrompt(input) {
  let prompt = input.agentInstructions?.trim() || input.systemPrompt?.trim() || "";
  prompt = prompt.replace(/\\n{3,}/g, "\\n\\n").trim();
  const sessionTypePrompt = input.sessionTypePrompt;
  if (sessionTypePrompt?.trim()) {
    prompt = \`\${prompt}

\${sessionTypePrompt.trim()}\`;
  }
  return { systemPrompt: prompt, staticPrompt: prompt };
}
function plugin() {
  return {
    "tool.definition": async (input, output) => {
      if (input.toolID === "skill") {
        output.description = SKILL_TOOL_DESCRIPTION;
      }
      if (input.toolID === "bash") {
        output.description = output.description + " long bash guidance ".repeat(60);
      }
      if (input.toolID === "edit" || input.toolID === "write" || input.toolID === "read") {
        const params = output.parameters;
        const props = params?.properties;
        if (props && !props.description) {
          props.description = {
            description: "Brief description of what this operation does",
            type: "string"
          };
        }
      }
    }
  };
}
function decoyPluginTail() {
  return {
    "other.definition": async () => {
    }
  };
}
export {
  plugin as default,
  injectDynamicBlocks,
  summarizeStringRequestBody,
  transformSystemPrompt
};
`;;
