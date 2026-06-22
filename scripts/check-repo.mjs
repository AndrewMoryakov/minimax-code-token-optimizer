#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maxAllowedFileBytes = 200_000;
const forbidden = [
  /ghp_[A-Za-z0-9_]+/,
  /sk-or-[A-Za-z0-9_-]+/,
  /OPENROUTER_API_KEY\s*=\s*['"][^'"]+['"]/,
  /MAVIS_OPENROUTER_API_KEY\s*=\s*['"][^'"]+['"]/
];

const ignoredDirs = new Set([".git", "node_modules", "dist", "backups"]);
let failed = false;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    const stat = fs.statSync(full);
    const rel = path.relative(root, full);
    if (stat.size > maxAllowedFileBytes) {
      console.error(`FAIL oversized file: ${rel} (${stat.size} bytes)`);
      failed = true;
    }
    const text = fs.readFileSync(full, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        console.error(`FAIL possible secret in ${rel}: ${pattern}`);
        failed = true;
      }
    }
  }
}

walk(root);

if (failed) process.exit(1);
console.log("repo check passed");
