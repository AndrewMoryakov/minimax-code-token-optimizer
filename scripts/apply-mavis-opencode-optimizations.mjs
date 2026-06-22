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
    out = replaceOnce(
      out,
      "  injectDynamicBlocks,\n  transformSystemPrompt",
      "  injectDynamicBlocks,\n  patchMiniMaxPromptCacheBody,\n  transformSystemPrompt",
      "export patchMiniMaxPromptCacheBody"
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
  const finalTrim = applyFinalToolDescriptionTrim(outputCap.source, afterOutputCapAnalysis);
  stages.push({
    id: "final-tool-description-trim",
    changed: finalTrim.changed,
    skipped: finalTrim.skipped
  });
  const afterAnalysis = analyzeBundleSource(finalTrim.source);
  return {
    source: finalTrim.source,
    changed: [...outputCap.changed, ...finalTrim.changed],
    skipped: [...outputCap.skipped, ...finalTrim.skipped],
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
