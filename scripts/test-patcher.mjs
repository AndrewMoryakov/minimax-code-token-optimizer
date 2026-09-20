#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { analyzeBundleFile, analyzeBundleSource } from "./lib/bundle-analysis.mjs";
import { checkSyntax } from "./lib/syntax-check.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-token-optimizer-"));
const fixturePath = path.join(tempDir, "index.js");

const fixture = `function compactDescription(text, maxLen) {
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
`;

fs.writeFileSync(fixturePath, fixture, "utf8");

function runApply(extraArgs = []) {
  const hasTarget = extraArgs.includes("--target");
  const result = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, "scripts", "apply-mavis-opencode-optimizations.mjs"),
      ...(hasTarget ? [] : ["--target", fixturePath]),
      ...extraArgs
    ],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  assert.equal(result.status, 0);
  return result;
}

// The pre-write parse check has to fail on broken source, or it is decoration.
assert.equal(checkSyntax("export const a = 1;\n").ok, true);
assert.equal(checkSyntax("module.exports = { a: 1 };\n").parsedAs, "module");
assert.equal(checkSyntax("const a = 1;\nfunction broken( {\n").ok, false);
assert.ok(checkSyntax("const a = 1;\nfunction broken( {\n").errors.some((line) => /SyntaxError/.test(line)));
assert.equal(checkSyntax(fixture).ok, true);

let analysis = analyzeBundleFile(fixturePath);
assert.equal(analysis.classification, "partially-patched");
assert.equal(analysis.finalPatchPresent, false);

const first = runApply(["--json"]);
const firstReport = JSON.parse(first.stdout);
assert.equal(firstReport.changed, true);
assert.equal(firstReport.beforeClassification, "partially-patched");
assert.equal(firstReport.afterClassification, "fully-patched");
assert.ok(firstReport.changes.includes("upgraded request section/tool diagnostics"));
assert.ok(firstReport.changes.includes("inserted bundle request guard helpers"));
assert.ok(firstReport.changes.includes("enabled bundle provider request guard preflight"));
assert.ok(firstReport.changes.includes("inserted tool-definition trim helpers"));
assert.ok(firstReport.changes.includes("enabled tool-definition trim hook"));
assert.ok(firstReport.changes.includes("capped promptUserProfileCapChars for max profile"));
assert.ok(firstReport.changes.includes("capped promptMemoryTailCapChars for max profile"));
assert.ok(firstReport.changes.includes("capped promptMemorySummaryCapChars for max profile"));
assert.ok(firstReport.changes.includes("inserted static prompt compaction helpers"));
assert.ok(firstReport.changes.includes("enabled base prompt compaction"));
assert.ok(firstReport.changes.includes("enabled session prompt compaction"));

analysis = analyzeBundleFile(fixturePath);
assert.equal(analysis.classification, "fully-patched");
assert.equal(analysis.finalPatchPresent, true);
const missingDiagnosticsAnalysis = analyzeBundleSource(fs.readFileSync(fixturePath, "utf8").replaceAll("descriptionBytes", "descBytesMissingMarker"));
assert.equal(missingDiagnosticsAnalysis.finalPatchPresent, false);
assert.equal(missingDiagnosticsAnalysis.classification, "partially-patched");

fs.appendFileSync(fixturePath, "\nexport { mavisBuildRequestGuardDecision, trimToolDefinitionForMax, promptUserProfileCapChars, promptMemoryTailCapChars, promptMemorySummaryCapChars };\n", "utf8");
const patchedModule = await import(`${pathToFileURL(fixturePath).href}?v=${Date.now()}`);
const directGuardDecision = patchedModule.mavisBuildRequestGuardDecision(
  "https://agent.minimax.io/mavis/api/v1/llm/v1/messages",
  {
    method: "POST",
    body: JSON.stringify({
      model: "MiniMax-M3",
      messages: [{ role: "user", content: "x".repeat(200000) }]
    })
  }
);
assert.equal(directGuardDecision.target, true);
assert.equal(directGuardDecision.provider, "minimax");
assert.equal(directGuardDecision.mode, "observe");
assert.equal(directGuardDecision.overBudget, true);
assert.equal(directGuardDecision.action, "observe");
const openRouterGuardDecision = patchedModule.mavisBuildRequestGuardDecision(
  "https://openrouter.ai/api/v1/chat/completions",
  {
    method: "POST",
    body: JSON.stringify({
      model: "openrouter/deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "x".repeat(90000) }]
    })
  }
);
assert.equal(openRouterGuardDecision.target, true);
assert.equal(openRouterGuardDecision.provider, "openrouter");
assert.equal(openRouterGuardDecision.overBudget, true);
const patchedRequest = patchedModule.patchMiniMaxPromptCacheBody(JSON.stringify({
  max_tokens: 32000,
  tools: [{ name: "skill", description: "verbose skill description ".repeat(100) }]
}));
const patchedBody = JSON.parse(patchedRequest.body);
assert.equal(patchedBody.max_tokens, 8192);
assert.equal(patchedRequest.details.maxTokensBefore, 32000);
assert.equal(patchedRequest.details.maxTokensAfter, 8192);
assert.equal(patchedRequest.changed, true);

// The cap must never land at or below thinking.budget_tokens: providers reject
// that outright, and it would truncate reasoning plus tool call.
const thinkingRequest = patchedModule.patchMiniMaxPromptCacheBody(JSON.stringify({
  max_tokens: 32000,
  thinking: { type: "enabled", budget_tokens: 16000 },
  messages: [{ role: "user", content: "hi" }]
}));
const thinkingBody = JSON.parse(thinkingRequest.body);
assert.equal(thinkingBody.max_tokens, 17024);
assert.ok(thinkingBody.max_tokens > thinkingBody.thinking.budget_tokens);

// A small budget still gets the normal cap, and a request already under the cap
// is left alone.
const smallBudget = JSON.parse(patchedModule.patchMiniMaxPromptCacheBody(JSON.stringify({
  max_tokens: 32000,
  thinking: { type: "enabled", budget_tokens: 2048 },
  messages: []
})).body);
assert.equal(smallBudget.max_tokens, 8192);
const disabledThinking = JSON.parse(patchedModule.patchMiniMaxPromptCacheBody(JSON.stringify({
  max_tokens: 4096,
  thinking: { type: "disabled", budget_tokens: 16000 },
  messages: []
})).body);
assert.equal(disabledThinking.max_tokens, 4096);
// Breakpoint budget: a body that already carries four markers must come back
// untouched, and a fresh body must not spend more than the remaining budget.
const countMarkers = (value) => (JSON.stringify(value).match(/"cache_control"/g) || []).length;
const fullBody = {
  system: [
    { type: "text", text: "a", cache_control: { type: "ephemeral" } },
    { type: "text", text: "b", cache_control: { type: "ephemeral" } }
  ],
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "ctx", cache_control: { type: "ephemeral" } },
      { type: "text", text: "q", cache_control: { type: "ephemeral" } }
    ]
  }]
};
const fullResult = patchedModule.patchMiniMaxPromptCacheBody(JSON.stringify(fullBody));
assert.equal(countMarkers(JSON.parse(fullResult.body)), 4);

const freshBody = {
  system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  messages: [{ role: "user", content: [{ type: "text", text: "file" }, { type: "text", text: "q" }] }]
};
const freshResult = JSON.parse(patchedModule.patchMiniMaxPromptCacheBody(JSON.stringify(freshBody)).body);
assert.equal(countMarkers(freshResult), 2);
assert.equal(freshResult.system[1].cache_control.type, "ephemeral");
assert.equal(freshResult.system[0].cache_control, undefined);

// The standalone plugin runs outside the bundle and marks first. The two
// together must still stay within the four-breakpoint ceiling; before the
// budget existed this combination produced five.
const promptCachePlugin = (await import(pathToFileURL(path.join(repoRoot, "plugins", "prompt-cache.js")).href)).default;
const pluginPatched = promptCachePlugin.__test.patchBody(JSON.stringify({
  ...freshBody,
  tools: [{ name: "bash", description: "d" }]
}), "minimax");
const afterBoth = JSON.parse(patchedModule.patchMiniMaxPromptCacheBody(pluginPatched.body).body);
assert.ok(countMarkers(afterBoth) <= 4, `combined breakpoints: ${countMarkers(afterBoth)}`);

const diagnostic = patchedModule.summarizeStringRequestBody(JSON.stringify({
  system: [{ type: "text", text: "system" }],
  messages: [{ role: "user", content: "hello" }],
  tools: [{
    name: "skill",
    description: "verbose skill description",
    input_schema: {
      properties: {
        name: { enum: ["alpha", "beta"], type: "string" }
      }
    }
  }]
}));
assert.equal(typeof diagnostic.sectionBytes.tools, "number");
assert.equal(diagnostic.largestTools[0].descriptionBytes, Buffer.byteLength("verbose skill description", "utf8"));
assert.equal(typeof diagnostic.largestTools[0].inputSchemaBytes, "number");
assert.deepEqual(diagnostic.largestTools[0].propertyKeys, ["name"]);
const params = {
  annotations: { marker: true },
  properties: {
    timeout: {
      type: "number",
      description: "timeout guidance ".repeat(80)
    }
  }
};
const toolOutput = {
  description: "Run shell commands. " + "very long guidance ".repeat(200),
  parameters: params
};
patchedModule.trimToolDefinitionForMax({ toolID: "bash" }, toolOutput);
assert.equal(toolOutput.parameters, params);
assert.equal(toolOutput.parameters.annotations.marker, true);
assert.ok(toolOutput.description.length < 140);
assert.ok(toolOutput.parameters.properties.timeout.description.length < 120);
const hookOutput = {
  description: "Run shell commands. " + "very long guidance ".repeat(200),
  parameters: {
    properties: {
      command: {
        type: "string",
        description: "command guidance ".repeat(80)
      }
    }
  }
};
const hooks = patchedModule.default();
await hooks["tool.definition"]({ toolID: "bash" }, hookOutput);
assert.ok(hookOutput.description.length < 140);
assert.ok(hookOutput.parameters.properties.command.description.length < 120);
// Enumerations inside a tool description are the only list of valid values the
// model gets. Trimming keeps them even when the prose is replaced.
const taskOutput = {
  description: [
    "Launch a subagent. " + "long preamble ".repeat(50),
    "<available_agents>",
    "  <agent><name>verifier</name></agent>",
    "  <agent><name>explore</name></agent>",
    "</available_agents>"
  ].join("\n"),
  parameters: { properties: {} }
};
patchedModule.trimToolDefinitionForMax({ toolID: "task" }, taskOutput);
assert.ok(taskOutput.description.includes("<available_agents>"), "agent list must survive the trim");
assert.ok(taskOutput.description.includes("verifier"));
assert.ok(!taskOutput.description.includes("long preamble long preamble"), "prose is still replaced");

const bigList = {
  description: "x " + "<available_agents>" + "y".repeat(4000) + "</available_agents>",
  parameters: {}
};
patchedModule.trimToolDefinitionForMax({ toolID: "task" }, bigList);
assert.ok(bigList.description.length < 1400, `oversized list must not be carried back in: ${bigList.description.length}`);

// The same protection applies to the final request-body trim.
const finalTools = [{
  name: "task",
  description: "verbose ".repeat(80) + "\n<available_agents><agent>verifier</agent></available_agents>"
}];
patchedModule.patchMiniMaxPromptCacheBody(JSON.stringify({ tools: finalTools, messages: [] }));

assert.equal(patchedModule.promptUserProfileCapChars(), 1200);
assert.equal(patchedModule.promptMemoryTailCapChars(), 4500);
assert.equal(patchedModule.promptMemorySummaryCapChars(), 1800);
const transformed = patchedModule.transformSystemPrompt({
  agentInstructions: "very long instructions ".repeat(500),
  sessionTypePrompt: "branch session details ".repeat(100)
});
assert.ok(transformed.systemPrompt.includes("## Operating Rules"));
assert.ok(transformed.systemPrompt.includes("## Session Role"));
assert.ok(!transformed.systemPrompt.includes("very long instructions very long instructions very long instructions"));
assert.ok(!transformed.systemPrompt.includes("branch session details branch session details branch session details"));

// A bundle patched by an older version carries the two-line cap with no
// thinking guard. The patcher must upgrade it in place, not skip it as done.
const legacyPath = path.join(tempDir, "legacy.js");
const legacySource = fs.readFileSync(fixturePath, "utf8")
  .replace("  const maxTokenCap = minimaxMaxTokensCap(parsed);", [
    '  const configuredCap = Number.parseInt(process.env.MAVIS_MINIMAX_MAX_TOKENS ?? "", 10);',
    "  const maxTokenCap = Number.isFinite(configuredCap) && configuredCap > 0 ? configuredCap : MINIMAX_DEFAULT_MAX_TOKENS;"
  ].join("\n"))
  .replace(/function minimaxMaxTokensCap\(parsed\) \{[\s\S]*?\n\}\n/, "");
fs.writeFileSync(legacyPath, legacySource, "utf8");
assert.ok(!legacySource.includes("minimaxMaxTokensCap"));
assert.equal(analyzeBundleFile(legacyPath).finalPatchPresent, false);

const upgrade = JSON.parse(runApply(["--json", "--target", legacyPath]).stdout);
assert.equal(upgrade.changed, true);
assert.ok(upgrade.changes.includes("upgraded existing max_tokens clamp to respect thinking budget"));
assert.equal(analyzeBundleFile(legacyPath).finalPatchPresent, true);
const upgradedModule = await import(`${pathToFileURL(legacyPath).href}?v=${Date.now()}`);
const upgradedBody = JSON.parse(upgradedModule.patchMiniMaxPromptCacheBody(JSON.stringify({
  max_tokens: 32000,
  thinking: { type: "enabled", budget_tokens: 16000 },
  messages: []
})).body);
assert.equal(upgradedBody.max_tokens, 17024);

// A bundle whose source defeats the brace matcher must not be written. This
// fixture hides a brace inside a regular expression literal, which the matcher
// counts as real, so replaceFunction slices past the end of the function.
const trapPath = path.join(tempDir, "trap.js");
const trapSource = fixture.replace(
  "function promptMemoryTailCapChars() {\n  return MEMORY_TAIL_INJECTION_CAP_CHARS;\n}",
  "function promptMemoryTailCapChars() {\n  const braceInRegex = /[{]/;\n  return braceInRegex.test(\"x\") ? 0 : MEMORY_TAIL_INJECTION_CAP_CHARS;\n}"
);
assert.ok(trapSource.includes("braceInRegex"), "trap fixture must differ from the plain fixture");
fs.writeFileSync(trapPath, trapSource, "utf8");
const trapRun = spawnSync(
  process.execPath,
  [path.join(repoRoot, "scripts", "apply-mavis-opencode-optimizations.mjs"), "--target", trapPath],
  { cwd: repoRoot, encoding: "utf8" }
);
assert.notEqual(trapRun.status, 0, "the patcher must refuse a bundle it cannot patch cleanly");
assert.match(`${trapRun.stderr}`, /braces are unbalanced|does not parse; nothing was written/);
assert.equal(fs.readFileSync(trapPath, "utf8"), trapSource, "the target must be left byte for byte unchanged");

const second = runApply(["--json"]);
const secondReport = JSON.parse(second.stdout);
assert.equal(secondReport.changed, false);
assert.equal(secondReport.afterClassification, "fully-patched");

console.log("patcher synthetic test passed");
