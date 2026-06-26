#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { analyzeBundleFile, analyzeBundleSource } from "./lib/bundle-analysis.mjs";

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
function patchMiniMaxPromptCacheBody(bodyText) {
  const parsed = JSON.parse(bodyText);
  const details = {
    tools: 0,
    system: 0,
    lastUser: 0
  };
  let added = 0;
  let changed = false;
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
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "apply-mavis-opencode-optimizations.mjs"), "--target", fixturePath, ...extraArgs],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
  }
  assert.equal(result.status, 0);
  return result;
}

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

const second = runApply(["--json"]);
const secondReport = JSON.parse(second.stdout);
assert.equal(secondReport.changed, false);
assert.equal(secondReport.afterClassification, "fully-patched");

console.log("patcher synthetic test passed");
