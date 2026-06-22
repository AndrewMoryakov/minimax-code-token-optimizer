#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeBundleFile } from "./lib/bundle-analysis.mjs";

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
const jsonMode = args.has("json");

if (!fs.existsSync(target)) {
  const report = {
    path: target,
    exists: false,
    classification: "unsupported",
    compatibleWithCurrentPatcher: false,
    issue: "bundle file not found"
  };
  console.log(jsonMode ? JSON.stringify(report, null, 2) : `bundle_not_found=${target}`);
  process.exit(2);
}

const report = analyzeBundleFile(target);
if (jsonMode) {
  console.log(JSON.stringify({ exists: true, ...report }, null, 2));
} else {
  console.log("MiniMax bundle analysis");
  console.log(`path=${report.path}`);
  console.log(`sha256=${report.sha256}`);
  console.log(`size=${report.sizeBytes}`);
  console.log(`classification=${report.classification}`);
  console.log(`compatible_with_current_patcher=${report.compatibleWithCurrentPatcher}`);
  console.log(`final_patch_present=${report.finalPatchPresent}`);
  if (report.missingRequiredStages.length > 0) {
    console.log(`missing_required_stages=${report.missingRequiredStages.join(",")}`);
  }
  for (const stage of report.stages) {
    console.log(`stage.${stage.id}=${stage.status} (${stage.presentCount}/${stage.totalCount})`);
    for (const marker of stage.markers) {
      console.log(`  marker.${marker.name}=${marker.present}`);
    }
  }
}

process.exit(report.compatibleWithCurrentPatcher ? 0 : 2);

