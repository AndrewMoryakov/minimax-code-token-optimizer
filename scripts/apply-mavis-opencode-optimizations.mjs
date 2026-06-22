#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeBundleSource, sha256 } from "./lib/bundle-analysis.mjs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) {
    args.set(key, "1");
  } else {
    args.set(key, next);
    i += 1;
  }
}

const defaultTarget = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Programs",
  "MiniMax Code",
  "resources",
  "resources",
  "daemon",
  "node_modules",
  "@mavis",
  "opencode-plugin",
  "index.js"
);

const target = path.resolve(args.get("target") ?? defaultTarget);
const dryRun = args.has("dry-run");
const jsonMode = args.has("json");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function replaceOnce(source, needle, replacement, label) {
  const count = source.split(needle).length - 1;
  if (count !== 1) {
    fail(`${label}: expected exactly one anchor, found ${count}`);
  }
  return source.replace(needle, replacement);
}

function insertAfterLastUserDetail(source, lines, label) {
  const pattern = /^(\s*)lastUser: 0,?\r?$/gm;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    fail(`${label}: expected exactly one lastUser detail anchor, found ${matches.length}`);
  }
  const indent = matches[0][1];
  const replacement = [
    `${indent}lastUser: 0,`,
    ...lines.map((line) => `${indent}${line}`)
  ].join("\n");
  return source.replace(pattern, replacement);
}

function ensurePrerequisites(source) {
  const analysis = analyzeBundleSource(source);
  if (!analysis.compatibleWithCurrentPatcher) {
    fail([
      "This MiniMax bundle does not expose the expected optimization anchors.",
      "The redistributable patcher does not ship or reconstruct vendor bundle code.",
      "Missing required stages:",
      ...analysis.missingRequiredStages.map((stage) => `  - ${stage}`)
    ].join("\n"));
  }
  return analysis;
}

function stageStatus(analysis, id) {
  return analysis.stages.find((stage) => stage.id === id)?.status ?? "missing";
}

function applyDirectM3OutputCap(source, analysis) {
  let out = source;
  const changed = [];
  const skipped = [];

  if (stageStatus(analysis, "direct-m3-output-cap") === "present") {
    skipped.push("direct M3 output cap already present");
    return { source: out, changed, skipped };
  }

  if (!out.includes("var MINIMAX_DEFAULT_MAX_TOKENS = 8192")) {
    out = replaceOnce(
      out,
      "function isMiniMaxPromptCacheTarget(input, init) {",
      "var MINIMAX_DEFAULT_MAX_TOKENS = 8192;\nfunction isMiniMaxPromptCacheTarget(input, init) {",
      "insert MINIMAX_DEFAULT_MAX_TOKENS"
    );
    changed.push("inserted direct M3 default max_tokens cap");
  }

  if (!out.includes("maxTokensBefore: typeof parsed.max_tokens === \"number\" ? parsed.max_tokens : void 0")) {
    out = insertAfterLastUserDetail(
      out,
      [
        'maxTokensBefore: typeof parsed.max_tokens === "number" ? parsed.max_tokens : void 0,',
        'maxTokensAfter: typeof parsed.max_tokens === "number" ? parsed.max_tokens : void 0'
      ],
      "add max_tokens diagnostics"
    );
    changed.push("added max_tokens diagnostics");
  }

  if (!out.includes("process.env.MAVIS_MINIMAX_MAX_TOKENS")) {
    out = replaceOnce(
      out,
      "  const tools = annotatePromptCacheTools(parsed.tools);\n",
      [
        '  const configuredCap = Number.parseInt(process.env.MAVIS_MINIMAX_MAX_TOKENS ?? "", 10);',
        "  const maxTokenCap = Number.isFinite(configuredCap) && configuredCap > 0 ? configuredCap : MINIMAX_DEFAULT_MAX_TOKENS;",
        "  if (typeof parsed.max_tokens === \"number\" && parsed.max_tokens > maxTokenCap) {",
        "    parsed.max_tokens = maxTokenCap;",
        "    details.maxTokensAfter = maxTokenCap;",
        "    changed = true;",
        "  }",
        "  const tools = annotatePromptCacheTools(parsed.tools);"
      ].join("\n") + "\n",
      "insert max_tokens clamp"
    );
    changed.push("enabled direct M3 max_tokens clamp");
  }

  return { source: out, changed, skipped };
}

function findFunctionRange(source, functionName) {
  const startMarker = `function ${functionName}(`;
  const start = source.indexOf(startMarker);
  if (start === -1) return null;
  const open = source.indexOf("{", start);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return { start, end: i + 1 };
    }
  }
  return null;
}

function replaceFunction(source, functionName, replacement) {
  const range = findFunctionRange(source, functionName);
  if (!range) fail(`replace ${functionName}: function not found or braces are unbalanced`);
  return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}

function exportSymbolBefore(source, symbol, beforeSymbol) {
  if (source.includes(`${symbol},`)) return source;
  const pattern = new RegExp(`(^\\s*)${beforeSymbol}(,?)\\s*$`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    fail(`export ${symbol}: expected exactly one ${beforeSymbol} export anchor, found ${matches.length}`);
  }
  const indent = matches[0][1];
  const comma = matches[0][2] || "";
  return source.replace(pattern, `${indent}${symbol},\n${indent}${beforeSymbol}${comma}`);
}

function fullSummarizeStringRequestBodyFunction() {
  return `function summarizeStringRequestBody(body) {
  const base = {
    bodyKind: "string",
    bodyBytes: Buffer.byteLength(body, "utf8")
  };
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return base;
  }
  const record3 = readRecord(parsed);
  if (!record3) return base;
  const tools = Array.isArray(record3.tools) ? record3.tools : void 0;
  const toolsWithEagerInputStreaming = tools?.filter((tool2) => readRecord(tool2)?.eager_input_streaming === true).length ?? void 0;
  const jsonBytes = (value) => {
    try {
      return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      return void 0;
    }
  };
  const largestTools = tools?.map((tool2) => {
    const record4 = readRecord(tool2);
    const inputSchema = readRecord(record4?.input_schema);
    const schemaProps = readRecord(inputSchema?.properties);
    const nameProp = readRecord(schemaProps?.name);
    const nameEnum = Array.isArray(nameProp?.enum) ? nameProp.enum : void 0;
    return {
      name: readString(record4?.name) ?? "unknown",
      bytes: jsonBytes(tool2) ?? 0,
      descriptionBytes: typeof record4?.description === "string" ? Buffer.byteLength(record4.description, "utf8") : void 0,
      inputSchemaBytes: jsonBytes(record4?.input_schema),
      inputSchemaKeys: inputSchema ? Object.keys(inputSchema).sort() : void 0,
      nameEnumCount: nameEnum?.length,
      nameEnumBytes: nameEnum ? jsonBytes(nameEnum) : void 0,
      propertyKeys: schemaProps ? Object.keys(schemaProps).sort() : void 0
    };
  }).sort((a, b) => b.bytes - a.bytes).slice(0, 5);
  const toolChoice = readRecord(record3.tool_choice);
  return {
    ...base,
    bodyTopLevelKeys: Object.keys(record3).sort(),
    model: readString(record3.model),
    stream: typeof record3.stream === "boolean" ? record3.stream : void 0,
    toolChoiceType: readString(toolChoice?.type),
    toolsCount: tools?.length,
    toolsWithEagerInputStreaming,
    sectionBytes: {
      system: jsonBytes(record3.system),
      messages: jsonBytes(record3.messages),
      tools: jsonBytes(record3.tools)
    },
    largestTools
  };
}`;
}

function applyRequestDiagnostics(source, analysis) {
  let out = source;
  const changed = [];
  const skipped = [];

  if (stageStatus(analysis, "request-diagnostics") === "present") {
    skipped.push("request diagnostics already present");
    return { source: out, changed, skipped };
  }

  if (!out.includes("function summarizeStringRequestBody(body) {")) {
    skipped.push("request diagnostics skipped: summarizeStringRequestBody not found");
    return { source: out, changed, skipped };
  }

  out = replaceFunction(out, "summarizeStringRequestBody", fullSummarizeStringRequestBodyFunction());
  changed.push("upgraded request section/tool diagnostics");
  return { source: out, changed, skipped };
}

function toolDefinitionTrimHelpers() {
  return `function trimSchemaDescriptionsForMax(value, maxLen = 80) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) trimSchemaDescriptionsForMax(item, maxLen);
    return value;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "description" && typeof child === "string") {
      value[key] = compactDescription(child, maxLen);
      continue;
    }
    trimSchemaDescriptionsForMax(child, maxLen);
  }
  return value;
}
function trimToolDefinitionForMax(input, output) {
  if (promptSurfaceLimits().profile !== "max") return;
  if (typeof output.description === "string") {
    output.description = compactDescription(output.description, 180);
  }
  if (input.toolID === "bash") {
    output.description = "Run a non-interactive shell command. Prefer bounded commands and set timeout for long operations.";
  } else if (input.toolID === "skill") {
    output.description = SKILL_TOOL_DESCRIPTION;
  } else if (input.toolID === "todowrite") {
    output.description = "Create or update the concise task checklist for this session.";
  } else if (input.toolID === "ask_user") {
    output.description = "Ask the user only when required to continue safely.";
  } else if (input.toolID === "task") {
    output.description = "Delegate a bounded task to another agent when it materially helps.";
  }
  trimSchemaDescriptionsForMax(output.parameters, 72);
}
`;
}

function insertToolDefinitionTrimCall(source) {
  if (source.includes("trimToolDefinitionForMax(input, output);")) return source;
  const anchor = "    }\n  };\n}\nexport {";
  if (!source.includes('"tool.definition": async (input, output) => {')) {
    fail("insert tool-definition trim call: tool.definition hook not found");
  }
  return replaceOnce(
    source,
    anchor,
    "      trimToolDefinitionForMax(input, output);\n    }\n  };\n}\nexport {",
    "insert tool-definition trim call"
  );
}

function applyToolDefinitionTrim(source, analysis) {
  let out = source;
  const changed = [];
  const skipped = [];

  if (stageStatus(analysis, "tool-definition-trim") === "present") {
    skipped.push("tool-definition trim already present");
    return { source: out, changed, skipped };
  }

  if (!out.includes("function trimSchemaDescriptionsForMax(value")) {
    out = replaceOnce(
      out,
      "function patchMiniMaxPromptCacheBody(bodyText) {",
      `${toolDefinitionTrimHelpers()}function patchMiniMaxPromptCacheBody(bodyText) {`,
      "insert tool-definition trim helpers"
    );
    changed.push("inserted tool-definition trim helpers");
  }

  if (!out.includes("function trimToolDefinitionForMax(input, output) {")) {
    out = replaceOnce(
      out,
      "function patchMiniMaxPromptCacheBody(bodyText) {",
      `${toolDefinitionTrimHelpers()}function patchMiniMaxPromptCacheBody(bodyText) {`,
      "insert tool-definition trim function"
    );
    changed.push("inserted tool-definition trim function");
  }

  if (!out.includes("trimToolDefinitionForMax(input, output);")) {
    out = insertToolDefinitionTrimCall(out);
    changed.push("enabled tool-definition trim hook");
  }

  return { source: out, changed, skipped };
}

function memoryCapFunction(name, fallbackConstant, maxCap) {
  return `function ${name}() {
  return promptSurfaceLimits().profile === "max" ? ${maxCap} : ${fallbackConstant};
}`;
}

function applyMemoryCaps(source, analysis) {
  let out = source;
  const changed = [];
  const skipped = [];

  if (stageStatus(analysis, "memory-caps") === "present") {
    skipped.push("memory caps already present");
    return { source: out, changed, skipped };
  }

  const targets = [
    {
      name: "promptUserProfileCapChars",
      fallback: "MEMORY_TAIL_INJECTION_CAP_CHARS",
      cap: 1200
    },
    {
      name: "promptMemoryTailCapChars",
      fallback: "MEMORY_TAIL_INJECTION_CAP_CHARS",
      cap: 4500
    },
    {
      name: "promptMemorySummaryCapChars",
      fallback: "MEMORY_SUMMARY_INJECTION_CAP_CHARS",
      cap: 1800
    }
  ];

  for (const target2 of targets) {
    if (out.includes(`function ${target2.name}()`)) {
      out = replaceFunction(out, target2.name, memoryCapFunction(target2.name, target2.fallback, target2.cap));
      changed.push(`capped ${target2.name} for max profile`);
    } else {
      skipped.push(`memory cap skipped: ${target2.name} not found`);
    }
  }

  return { source: out, changed, skipped };
}

function staticPromptCompactionHelpers() {
  return `function compactBaseInstructionsForMax(prompt) {
  if (!prompt?.trim()) return prompt;
  return [
    "# Role",
    "",
    "You are running inside MiniMax Code as the active coding agent.",
    "",
    "## Operating Rules",
    "- When the goal is clear, act directly and keep the user looped in.",
    "- For code changes, inspect first, follow local patterns, edit narrowly, and verify.",
    "- Prefer fast, bounded local inspection (rg, short reads, targeted logs).",
    "- Avoid interactive shell commands and unbounded recursive scans.",
    "- On Windows, prefer native PowerShell cmdlets and safe literal paths.",
    "- Preserve user changes; do not revert unrelated work.",
    "- Keep final answers concise, with exact files/tests when useful.",
    "",
    "## Tool Discipline",
    "- Parallelize independent reads/searches.",
    "- Summarize large outputs instead of dumping them into context.",
    "- Use scratch/artifact paths for bulky evidence.",
    "- Start fresh sessions before provider-context caps are reached."
  ].join("\\n");
}
function compactSessionPromptForMax(prompt) {
  if (!prompt?.trim()) return "";
  return [
    "## Session Role",
    "This is a branch/work session. Do the requested work directly, report concise status, and avoid broad context loading unless necessary."
  ].join("\\n");
}
`;
}

function insertBeforeFirstAvailable(source, anchors, insertion, label) {
  for (const anchor of anchors) {
    if (source.includes(anchor)) {
      return replaceOnce(source, anchor, `${insertion}${anchor}`, label);
    }
  }
  fail(`${label}: no insertion anchor found`);
}

function applyStaticPromptCompaction(source, analysis) {
  let out = source;
  const changed = [];
  const skipped = [];

  if (stageStatus(analysis, "static-prompt-compaction") === "present") {
    skipped.push("static prompt compaction already present");
    return { source: out, changed, skipped };
  }

  if (!out.includes("function transformSystemPrompt(")) {
    skipped.push("static prompt compaction skipped: transformSystemPrompt not found");
    return { source: out, changed, skipped };
  }

  if (!out.includes("function compactBaseInstructionsForMax(prompt) {")) {
    out = insertBeforeFirstAvailable(
      out,
      ["function promptUserProfileCapChars() {", "function transformSystemPrompt("],
      staticPromptCompactionHelpers(),
      "insert static prompt compaction helpers"
    );
    changed.push("inserted static prompt compaction helpers");
  }

  if (!out.includes("prompt = compactBaseInstructionsForMax(prompt);")) {
    const anchor = '  prompt = prompt.replace(/\\n{3,}/g, "\\n\\n").trim();\n';
    if (out.includes(anchor)) {
      out = replaceOnce(
        out,
        anchor,
        `${anchor}  if (promptSurfaceLimits().profile === "max") {\n    prompt = compactBaseInstructionsForMax(prompt);\n  }\n`,
        "insert base prompt compaction call"
      );
      changed.push("enabled base prompt compaction");
    } else {
      skipped.push("static prompt compaction skipped: normalized prompt anchor not found");
    }
  }

  if (!out.includes("compactSessionPromptForMax(sessionTypePrompt.trim())")) {
    const needle = "${sessionTypePrompt.trim()}";
    const replacement = '${promptSurfaceLimits().profile === "max" ? compactSessionPromptForMax(sessionTypePrompt.trim()) : sessionTypePrompt.trim()}';
    const count = out.split(needle).length - 1;
    if (count === 1) {
      out = out.replace(needle, replacement);
      changed.push("enabled session prompt compaction");
    } else {
      skipped.push(`static prompt compaction skipped: session prompt anchor count=${count}`);
    }
  }

  return { source: out, changed, skipped };
}

function applyFinalToolDescriptionTrim(source, analysis) {
  let out = source;
  const changed = [];
  const skipped = [];

  if (stageStatus(analysis, "final-tool-description-trim") === "present") {
    skipped.push("final request-body tool description trim already present");
  }

  if (!out.includes("function trimFinalToolDescriptionsForMax(tools) {")) {
    const helper = `function trimFinalToolDescriptionsForMax(tools) {
  if (promptSurfaceLimits().profile !== "max" || !Array.isArray(tools)) {
    return { changed: false, count: 0, beforeBytes: 0, afterBytes: 0 };
  }
  let changed = false;
  let count = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  for (const tool2 of tools) {
    if (!tool2 || typeof tool2 !== "object" || typeof tool2.description !== "string") continue;
    const before = tool2.description;
    let after;
    if (tool2.name === "skill") {
      after = SKILL_TOOL_DESCRIPTION;
    } else if (tool2.name === "bash") {
      after = "Run a non-interactive shell command. Prefer bounded commands and set timeout for long operations.";
    } else if (tool2.name === "task") {
      after = "Delegate a bounded task to another agent when it materially helps.";
    } else {
      after = compactDescription(before, 220);
    }
    if (after !== before) {
      beforeBytes += Buffer.byteLength(before, "utf8");
      afterBytes += Buffer.byteLength(after, "utf8");
      tool2.description = after;
      changed = true;
      count += 1;
    }
  }
  return { changed, count, beforeBytes, afterBytes };
}
`;
    out = replaceOnce(
      out,
      "function patchMiniMaxPromptCacheBody(bodyText) {",
      `${helper}function patchMiniMaxPromptCacheBody(bodyText) {`,
      "insert trimFinalToolDescriptionsForMax"
    );
    changed.push("inserted final tool description trim helper");
  }

  if (!out.includes("toolDescriptionsTrimmed: 0,")) {
    out = insertAfterLastUserDetail(
      out,
      [
        "toolDescriptionsTrimmed: 0,",
        "toolDescriptionBytesBefore: 0,",
        "toolDescriptionBytesAfter: 0,"
      ],
      "add trim diagnostics"
    );
    changed.push("added trim diagnostics");
  }

  if (!out.includes("const finalToolDescriptions = trimFinalToolDescriptionsForMax(parsed.tools);")) {
    out = replaceOnce(
      out,
      "  const tools = annotatePromptCacheTools(parsed.tools);\n",
      [
        "  const finalToolDescriptions = trimFinalToolDescriptionsForMax(parsed.tools);",
        "  if (finalToolDescriptions.changed) {",
        "    details.toolDescriptionsTrimmed = finalToolDescriptions.count;",
        "    details.toolDescriptionBytesBefore = finalToolDescriptions.beforeBytes;",
        "    details.toolDescriptionBytesAfter = finalToolDescriptions.afterBytes;",
        "    changed = true;",
        "  }",
        "  const tools = annotatePromptCacheTools(parsed.tools);"
      ].join("\n") + "\n",
      "call final tool description trim"
    );
    changed.push("enabled final request-body tool trim");
  }

  if (stageStatus(analysis, "request-patcher-test-export") === "present") {
    skipped.push("request patcher test export already present");
  }

  if (!out.includes("patchMiniMaxPromptCacheBody,")) {
    out = exportSymbolBefore(
      out,
      "patchMiniMaxPromptCacheBody",
      "transformSystemPrompt"
    );
    changed.push("exported request-body patcher for smoke tests");
  }

  return { source: out, changed, skipped };
}

function applyStages(source) {
  const beforeAnalysis = ensurePrerequisites(source);
  const stages = [];
  const outputCap = applyDirectM3OutputCap(source, beforeAnalysis);
  stages.push({
    id: "direct-m3-output-cap",
    changed: outputCap.changed,
    skipped: outputCap.skipped
  });
  const afterOutputCapAnalysis = analyzeBundleSource(outputCap.source);
  const diagnostics = applyRequestDiagnostics(outputCap.source, afterOutputCapAnalysis);
  stages.push({
    id: "request-diagnostics",
    changed: diagnostics.changed,
    skipped: diagnostics.skipped
  });
  const afterDiagnosticsAnalysis = analyzeBundleSource(diagnostics.source);
  const toolDefinitionTrim = applyToolDefinitionTrim(diagnostics.source, afterDiagnosticsAnalysis);
  stages.push({
    id: "tool-definition-trim",
    changed: toolDefinitionTrim.changed,
    skipped: toolDefinitionTrim.skipped
  });
  const afterToolDefinitionTrimAnalysis = analyzeBundleSource(toolDefinitionTrim.source);
  const memoryCaps = applyMemoryCaps(toolDefinitionTrim.source, afterToolDefinitionTrimAnalysis);
  stages.push({
    id: "memory-caps",
    changed: memoryCaps.changed,
    skipped: memoryCaps.skipped
  });
  const afterMemoryCapsAnalysis = analyzeBundleSource(memoryCaps.source);
  const staticPromptCompaction = applyStaticPromptCompaction(memoryCaps.source, afterMemoryCapsAnalysis);
  stages.push({
    id: "static-prompt-compaction",
    changed: staticPromptCompaction.changed,
    skipped: staticPromptCompaction.skipped
  });
  const afterStaticPromptCompactionAnalysis = analyzeBundleSource(staticPromptCompaction.source);
  const finalTrim = applyFinalToolDescriptionTrim(staticPromptCompaction.source, afterStaticPromptCompactionAnalysis);
  stages.push({
    id: "final-tool-description-trim",
    changed: finalTrim.changed,
    skipped: finalTrim.skipped
  });
  const afterAnalysis = analyzeBundleSource(finalTrim.source);
  return {
    source: finalTrim.source,
    changed: [...outputCap.changed, ...diagnostics.changed, ...toolDefinitionTrim.changed, ...memoryCaps.changed, ...staticPromptCompaction.changed, ...finalTrim.changed],
    skipped: [...outputCap.skipped, ...diagnostics.skipped, ...toolDefinitionTrim.skipped, ...memoryCaps.skipped, ...staticPromptCompaction.skipped, ...finalTrim.skipped],
    stages,
    beforeAnalysis,
    afterAnalysis
  };
}

if (!fs.existsSync(target)) {
  fail(`target file not found: ${target}`);
}

const before = fs.readFileSync(target, "utf8");
const beforeHash = sha256(before);
const result = applyStages(before);

if (result.changed.length === 0) {
  const report = {
    target,
    changed: false,
    beforeSha256: beforeHash,
    afterSha256: beforeHash,
    beforeClassification: result.beforeAnalysis.classification,
    afterClassification: result.afterAnalysis.classification,
    skipped: result.skipped
  };
  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("already patched");
    console.log(`target=${target}`);
    console.log(`classification=${report.afterClassification}`);
    console.log(`sha256=${beforeHash}`);
    for (const item of result.skipped) console.log(`skipped=${item}`);
  }
  process.exit(0);
}

const afterHash = sha256(result.source);
const baseReport = {
  target,
  changed: true,
  dryRun,
  beforeSha256: beforeHash,
  afterSha256: afterHash,
  beforeClassification: result.beforeAnalysis.classification,
  afterClassification: result.afterAnalysis.classification,
  changes: result.changed,
  skipped: result.skipped
};

const backupDir = path.join(path.dirname(target), "mavis-token-optimizer-backups");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const backup = path.join(backupDir, `index.before-token-optimizer.${stamp}.js`);
if (!dryRun) {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(target, backup);
  fs.writeFileSync(target, result.source, "utf8");
}

const report = {
  ...baseReport,
  backup: dryRun ? null : backup
};

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("planned changes:");
  for (const item of result.changed) console.log(`- ${item}`);
  console.log(`before_classification=${result.beforeAnalysis.classification}`);
  console.log(`after_classification=${result.afterAnalysis.classification}`);
  if (dryRun) {
    console.log("dry-run: target was not modified");
  } else {
    console.log(`backup=${backup}`);
    console.log(`applied=${target}`);
  }
  console.log(`before_sha256=${beforeHash}`);
  console.log(`after_sha256=${afterHash}`);
}
