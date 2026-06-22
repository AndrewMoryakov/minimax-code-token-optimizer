#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
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
var SKILL_TOOL_DESCRIPTION = "Load a skill by name.";
function isMiniMaxPromptCacheTarget(input, init) {
  return true;
}
function annotatePromptCacheTools(tools) {
  return { value: tools, added: 0 };
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
assert.ok(firstReport.changes.includes("inserted direct M3 default max_tokens cap"));
assert.ok(firstReport.changes.includes("enabled direct M3 max_tokens clamp"));

analysis = analyzeBundleFile(fixturePath);
assert.equal(analysis.classification, "fully-patched");
assert.equal(analysis.finalPatchPresent, true);

const patchedModule = await import(`${pathToFileURL(fixturePath).href}?v=${Date.now()}`);
const patchedRequest = patchedModule.patchMiniMaxPromptCacheBody(JSON.stringify({
  max_tokens: 32000,
  tools: [{ name: "skill", description: "verbose skill description ".repeat(100) }]
}));
const patchedBody = JSON.parse(patchedRequest.body);
assert.equal(patchedBody.max_tokens, 8192);
assert.equal(patchedRequest.details.maxTokensBefore, 32000);
assert.equal(patchedRequest.details.maxTokensAfter, 8192);
assert.equal(patchedRequest.changed, true);

const second = runApply(["--json"]);
const secondReport = JSON.parse(second.stdout);
assert.equal(secondReport.changed, false);
assert.equal(secondReport.afterClassification, "fully-patched");

console.log("patcher synthetic test passed");
