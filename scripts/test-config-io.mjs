#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseJsonFile, readJsonText, stripBom, writeJsonFile } from "./lib/json-file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-config-io-"));

const bomPath = path.join(tempDir, "with-bom.json");
fs.writeFileSync(bomPath, "﻿" + JSON.stringify({ plugin: ["mavis"] }), "utf8");

// The bare read is what used to fail, so the test states it.
assert.throws(() => JSON.parse(fs.readFileSync(bomPath, "utf8")), SyntaxError);
assert.deepEqual(parseJsonFile(bomPath).plugin, ["mavis"]);
assert.equal(readJsonText(bomPath).charCodeAt(0), "{".charCodeAt(0));
assert.equal(stripBom("﻿{}"), "{}");
assert.equal(stripBom("{}"), "{}");

const written = path.join(tempDir, "written.json");
writeJsonFile(written, { plugin: ["mavis"] });
assert.equal(fs.readFileSync(written, "utf8").charCodeAt(0), "{".charCodeAt(0), "written config must have no BOM");
assert.ok(fs.readFileSync(written, "utf8").endsWith("\n"));

// diagnose-install.mjs must read a BOM-prefixed opencode.json as valid rather
// than reporting the install as broken.
const mavisRoot = path.join(tempDir, "mavis-root");
fs.mkdirSync(path.join(mavisRoot, "opencode"), { recursive: true });
fs.writeFileSync(
  path.join(mavisRoot, "opencode", "opencode.json"),
  "﻿" + JSON.stringify({ plugin: ["mavis", "openrouter-lifecycle", "prompt-surface", "request-guard", "prompt-cache"] }),
  "utf8"
);
const diagnose = spawnSync(
  process.execPath,
  [path.join(repoRoot, "scripts", "diagnose-install.mjs"), "--json", "--mavis-root", mavisRoot],
  { encoding: "utf8" }
);
const report = JSON.parse(diagnose.stdout);
assert.equal(report.opencodeConfig.parseOk, true, `parse error: ${report.opencodeConfig.error}`);
assert.equal(report.opencodeConfig.pluginsRegistered, true);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("config io test passed");
