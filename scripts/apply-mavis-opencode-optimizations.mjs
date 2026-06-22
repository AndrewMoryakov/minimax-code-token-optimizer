#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

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

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

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

function ensurePrerequisites(source) {
  const required = [
    "function patchMiniMaxPromptCacheBody(bodyText) {",
    "function promptSurfaceLimits() {",
    "function compactDescription(",
    "var MINIMAX_DEFAULT_MAX_TOKENS",
    "function annotatePromptCacheTools(tools) {"
  ];
  const missing = required.filter((marker) => !source.includes(marker));
  if (missing.length > 0) {
    fail([
      "This MiniMax bundle does not expose the expected optimization anchors.",
      "The redistributable patcher does not ship or reconstruct vendor bundle code.",
      "Missing markers:",
      ...missing.map((marker) => `  - ${marker}`)
    ].join("\n"));
  }
}

function applyFinalToolDescriptionTrim(source) {
  let out = source;
  const changed = [];

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
    out = replaceOnce(
      out,
      "    lastUser: 0,\n",
      [
        "    lastUser: 0,",
        "    toolDescriptionsTrimmed: 0,",
        "    toolDescriptionBytesBefore: 0,",
        "    toolDescriptionBytesAfter: 0,"
      ].join("\n") + "\n",
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

  if (!out.includes("patchMiniMaxPromptCacheBody,")) {
    out = replaceOnce(
      out,
      "  injectDynamicBlocks,\n  transformSystemPrompt",
      "  injectDynamicBlocks,\n  patchMiniMaxPromptCacheBody,\n  transformSystemPrompt",
      "export patchMiniMaxPromptCacheBody"
    );
    changed.push("exported request-body patcher for smoke tests");
  }

  return { source: out, changed };
}

if (!fs.existsSync(target)) {
  fail(`target file not found: ${target}`);
}

const before = fs.readFileSync(target, "utf8");
ensurePrerequisites(before);

const result = applyFinalToolDescriptionTrim(before);
if (result.changed.length === 0) {
  console.log("already patched");
  console.log(`target=${target}`);
  console.log(`sha256=${sha256(before)}`);
  process.exit(0);
}

console.log("planned changes:");
for (const item of result.changed) console.log(`- ${item}`);

if (dryRun) {
  console.log("dry-run: target was not modified");
  console.log(`before_sha256=${sha256(before)}`);
  console.log(`after_sha256=${sha256(result.source)}`);
  process.exit(0);
}

const backupDir = path.join(path.dirname(target), "mavis-token-optimizer-backups");
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
const backup = path.join(backupDir, `index.before-token-optimizer.${stamp}.js`);
fs.copyFileSync(target, backup);
fs.writeFileSync(target, result.source, "utf8");

console.log(`backup=${backup}`);
console.log(`applied=${target}`);
console.log(`before_sha256=${sha256(before)}`);
console.log(`after_sha256=${sha256(result.source)}`);

