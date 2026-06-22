#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { analyzeBundleFile } from "./lib/bundle-analysis.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-token-optimizer-"));
const fixturePath = path.join(tempDir, "index.js");

const fixture = `function compactDescription(text, maxLen) {
  return typeof text === "string" && text.length > maxLen ? text.slice(0, maxLen) : text;
}
function promptSurfaceLimits() {
  return { profile: "max" };
}
var MINIMAX_DEFAULT_MAX_TOKENS = 8192;
var configuredCap = process.env.MAVIS_MINIMAX_MAX_TOKENS;
var SKILL_TOOL_DESCRIPTION = "Load a skill by name.";
function isMiniMaxPromptCacheTarget(input, init) {
  return true;
}
function annotatePromptCacheTools(tools) {
  return { value: tools, added: 0 };
}
function patchMiniMaxPromptCacheBody(bodyText) {
  const details = {
    tools: 0,
    system: 0,
    lastUser: 0,
    maxTokensBefore: 32000,
    maxTokensAfter: 8192
  };
  const parsed = JSON.parse(bodyText);
  const tools = annotatePromptCacheTools(parsed.tools);
  return { body: JSON.stringify(parsed), details, changed: false, added: tools.added };
}
function injectDynamicBlocks() {}
function transformSystemPrompt() {}
export {
  injectDynamicBlocks,
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
assert.equal(analysis.classification, "base-compatible");
assert.equal(analysis.finalPatchPresent, false);

const first = runApply(["--json"]);
const firstReport = JSON.parse(first.stdout);
assert.equal(firstReport.changed, true);
assert.equal(firstReport.beforeClassification, "base-compatible");
assert.equal(firstReport.afterClassification, "fully-patched");

analysis = analyzeBundleFile(fixturePath);
assert.equal(analysis.classification, "fully-patched");
assert.equal(analysis.finalPatchPresent, true);

const second = runApply(["--json"]);
const secondReport = JSON.parse(second.stdout);
assert.equal(secondReport.changed, false);
assert.equal(secondReport.afterClassification, "fully-patched");

console.log("patcher synthetic test passed");
