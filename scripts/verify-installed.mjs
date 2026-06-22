#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const target = path.resolve(
  process.argv.includes("--target")
    ? process.argv[process.argv.indexOf("--target") + 1]
    : path.join(
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
      )
);

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function check(condition, message) {
  if (!condition) {
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS ${message}`);
  }
}

if (!fs.existsSync(target)) {
  console.error(`FAIL target not found: ${target}`);
  process.exit(1);
}

const source = fs.readFileSync(target, "utf8");

check(source.includes("function promptSurfaceLimits() {"), "profile-aware prompt limits present");
check(source.includes("var MINIMAX_DEFAULT_MAX_TOKENS = 8192"), "direct M3 output cap present");
check(source.includes("process.env.MAVIS_MINIMAX_MAX_TOKENS"), "output cap env override present");
check(source.includes("function trimFinalToolDescriptionsForMax(tools) {"), "final tool description trim present");
check(source.includes("toolDescriptionsTrimmed"), "tool trim diagnostics present");
check(source.includes("patchMiniMaxPromptCacheBody,"), "request patcher exported for smoke tests");
check(source.includes("sectionBytes"), "request section-byte diagnostics present");
check(source.includes("largestTools"), "largest tool diagnostics present");
check(!source.includes("ghp_"), "no GitHub token literal present");
check(!source.includes("sk-or-"), "no common OpenRouter key literal present");

console.log(`target=${target}`);
console.log(`sha256=${sha256(source)}`);

if (process.exitCode) {
  process.exit(process.exitCode);
}

