#!/usr/bin/env node
// The compatibility bootstrap is the path taken when a bundle has none of the
// prompt-cache machinery: the patcher writes the whole request patcher itself.
// It is easy to break while editing the emitted text, and a parse check does
// not catch a wrong identifier, so this exercises the result.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SYNTHETIC_BUNDLE } from "./fixtures/synthetic-bundle.mjs";
import { analyzeBundleFile } from "./lib/bundle-analysis.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-bootstrap-"));
const bundlePath = path.join(tempDir, "index.js");

// Strip everything the bootstrap is supposed to supply.
let bare = SYNTHETIC_BUNDLE
  .replace(/function promptSurfaceLimits\(\) \{\n {2}return \{ profile: "max" \};\n\}\n/, "")
  .replace(/function isMiniMaxPromptCacheTarget[\s\S]*?\n\}\n/, "")
  .replace(/function annotatePromptCacheTools[\s\S]*?\n\}\n/, "")
  .replace(/function annotatePromptCacheTextBlock[\s\S]*?\n\}\n/, "")
  .replace(/function annotateLastContentBlock[\s\S]*?\n\}\n/, "")
  .replace(/function patchMiniMaxPromptCacheBody[\s\S]*?\n\}\nfunction applyMiniMaxPromptCache[\s\S]*?\n\}\n/, "")
  .replace(
    "    const promptCachePatch = applyMiniMaxPromptCache(input, init);\n    const effectiveInit = promptCachePatch.init;\n    const requestDiagnostic = sessionId ? buildProviderRequestDiagnostic(input, effectiveInit) : void 0;\n    const res = await originalFetch(input, effectiveInit);",
    "    const requestDiagnostic = sessionId ? buildProviderRequestDiagnostic(input, init) : void 0;\n    const res = await originalFetch(input, init);"
  );

for (const gone of ["promptSurfaceLimits", "patchMiniMaxPromptCacheBody", "annotatePromptCacheTools", "effectiveInit"]) {
  assert.ok(!bare.includes(gone), `bootstrap fixture still contains ${gone}`);
}
assert.equal(analyzeBundleFile.name, "analyzeBundleFile");
fs.writeFileSync(bundlePath, bare, "utf8");
assert.equal(analyzeBundleFile(bundlePath).compatibleWithCurrentPatcher, false, "the bare fixture must not look patchable yet");

const apply = spawnSync(
  process.execPath,
  [path.join(repoRoot, "scripts", "apply-mavis-opencode-optimizations.mjs"), "--target", bundlePath, "--json"],
  { encoding: "utf8" }
);
assert.equal(apply.status, 0, `${apply.stdout}${apply.stderr}`);
const report = JSON.parse(apply.stdout);
assert.equal(report.afterClassification, "fully-patched");
assert.equal(report.parsedAs, "module");

// The patcher exports the request patcher itself, for exactly this kind of check.
const patched = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

// Every helper the bootstrap emits has to resolve at call time. A missing
// identifier here is the failure mode a syntax check cannot see.
const countMarkers = (value) => (JSON.stringify(value).match(/"cache_control"/g) || []).length;
const result = patched.patchMiniMaxPromptCacheBody(JSON.stringify({
  max_tokens: 32000,
  thinking: { type: "enabled", budget_tokens: 16000 },
  system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  messages: [
    { role: "user", content: [{ type: "text", text: "ctx", cache_control: { type: "ephemeral" } }, { type: "text", text: "q1" }] },
    { role: "assistant", content: [{ type: "text", text: "a1", cache_control: { type: "ephemeral" } }] },
    { role: "user", content: [{ type: "text", text: "dump" }, { type: "text", text: "q2" }] }
  ],
  tools: [{ name: "bash", description: "d" }]
}));
const body = JSON.parse(result.body);
assert.equal(body.max_tokens, 17024, "thinking-aware cap must work on the bootstrap path too");
assert.ok(countMarkers(body) <= 4, `breakpoints: ${countMarkers(body)}`);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("bootstrap path test passed");
