#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectInstallLayout, readAsarHeaderText, V1_BUNDLE_RELATIVE_PATH } from "./lib/install-layout.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-install-layout-"));

// Minimal asar container: the four size fields, the JSON directory header, and
// no packed data. Only the header is what detection reads.
function writeAsar(filePath, headerObject) {
  const headerText = Buffer.from(JSON.stringify(headerObject), "utf8");
  const padding = (4 - (headerText.length % 4)) % 4;
  const sizes = Buffer.alloc(16);
  sizes.writeUInt32LE(4, 0);
  sizes.writeUInt32LE(8 + headerText.length + padding, 4);
  sizes.writeUInt32LE(4 + headerText.length + padding, 8);
  sizes.writeUInt32LE(headerText.length, 12);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([sizes, headerText, Buffer.alloc(padding)]));
}

function nestedPackage(...segments) {
  let node = { size: 2, offset: "0" };
  for (const segment of segments.reverse()) {
    node = { files: { [segment]: node } };
  }
  return node;
}

function makeInstall(name, { withBundle = false, asarHeader = null } = {}) {
  const installRoot = path.join(tempDir, name);
  fs.mkdirSync(installRoot, { recursive: true });
  if (withBundle) {
    const bundlePath = path.join(installRoot, V1_BUNDLE_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
    fs.writeFileSync(bundlePath, "// bundle\n", "utf8");
  }
  if (asarHeader) writeAsar(path.join(installRoot, "resources", "app.asar"), asarHeader);
  return installRoot;
}

const v2Header = nestedPackage("node_modules", "@mavis", "local-runtime", "package.json");
const v1AsarHeader = nestedPackage("node_modules", "@mavis", "opencode-plugin", "index.js");

// v1: the patchable bundle is a real file on disk.
const v1 = detectInstallLayout({ installRoot: makeInstall("v1", { withBundle: true, asarHeader: v1AsarHeader }) });
assert.equal(v1.layout, "v1-opencode-plugin");
assert.equal(v1.supported, true);
assert.equal(v1.message, null);

// v2: local-runtime in app.asar, no opencode-plugin anywhere.
const v2 = detectInstallLayout({ installRoot: makeInstall("v2", { asarHeader: v2Header }) });
assert.equal(v2.layout, "v2-local-runtime");
assert.equal(v2.supported, false);
assert.match(v2.message, /local-runtime/);
assert.ok(v2.evidence.some((line) => line.includes("app.asar.local-runtime=true")));

// The v2 verdict must not be handed out just because the bundle file is absent:
// an install whose asar still carries opencode-plugin is "unknown", not v2.
const stillOpenCode = detectInstallLayout({ installRoot: makeInstall("v1-asar-only", { asarHeader: v1AsarHeader }) });
assert.equal(stillOpenCode.layout, "unknown");
assert.equal(stillOpenCode.supported, false);

// Nothing installed at all.
const absent = detectInstallLayout({ installRoot: path.join(tempDir, "does-not-exist") });
assert.equal(absent.layout, "not-installed");

// A truncated archive must not throw and must not be read as v2.
const brokenRoot = makeInstall("broken");
fs.mkdirSync(path.join(brokenRoot, "resources"), { recursive: true });
fs.writeFileSync(path.join(brokenRoot, "resources", "app.asar"), Buffer.alloc(8));
const broken = detectInstallLayout({ installRoot: brokenRoot });
assert.equal(broken.layout, "unknown");
assert.equal(readAsarHeaderText(path.join(brokenRoot, "resources", "app.asar")), null);

// An explicit --target still wins over the default install root.
const custom = path.join(tempDir, "custom-bundle.js");
fs.writeFileSync(custom, "// bundle\n", "utf8");
const targeted = detectInstallLayout({ installRoot: makeInstall("v2-targeted", { asarHeader: v2Header }), bundlePath: custom });
assert.equal(targeted.layout, "v1-opencode-plugin");
assert.equal(targeted.supported, true);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("install layout detection test passed");
