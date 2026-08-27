#!/usr/bin/env node
//
// Trim backup files left behind by the patcher and the installer.
//
// Every install creates a timestamped backup. Without cleanup, the
// directories grow by one ~600KB bundle file per run, plus small JSON
// backups for policy.json and opencode.json. After a few dozen
// installs the patcher backup dir is many MB of dead weight.
//
// Usage:
//   node .\scripts\cleanup-backups.mjs                 # keep 5 newest per dir, dry-run
//   node .\scripts\cleanup-backups.mjs --keep 3       # keep 3 per dir
//   node .\scripts\cleanup-backups.mjs --keep 3 --apply # actually delete
//   node .\scripts\cleanup-backups.mjs --all-dirs     # also clean the
//                                                       # per-file `backups/`
//                                                       # dirs created by install.mjs
//
// The --keep value is per directory. The patcher backup dir keeps N
// most-recent bundle snapshots. The per-file `backups/` dirs each
// keep N most-recent copies of their file type.
//
// The default mode is dry-run. Pass --apply to perform deletions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "-h" || arg === "--help") {
    args.set("help", "1");
    continue;
  }
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

function usage() {
  console.log(`Cleanup backup files left by install / patch runs.

Usage:
  node .\\scripts\\cleanup-backups.mjs [options]

Options:
  --keep <N>        Keep the N most recent files per directory. Default: 5
  --apply            Actually delete. Default is dry-run.
  --all-dirs         Also clean the per-file "backups" dirs (config, policy,
                    plugins) created by install.mjs. Default: only the
                    patcher backup dir.
  --target <path>    Override the patcher bundle path (uses the same default
                    as apply-mavis-opencode-optimizations.mjs otherwise)
  --help, -h         Show this help

Notes:
  Without --apply the script only reports what it would delete.
`);
}

if (args.has("help")) {
  usage();
  process.exit(0);
}

const keepRaw = args.get("keep") ?? "5";
const keep = Number.parseInt(keepRaw, 10);
if (!Number.isInteger(keep) || keep < 0) {
  console.error(`ERROR: --keep must be a non-negative integer, got "${keepRaw}"`);
  process.exit(1);
}

const apply = args.has("apply");
const allDirs = args.has("all-dirs");

const defaultBundle = path.join(
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
const bundle = path.resolve(args.get("target") ?? defaultBundle);
const patcherBackupDir = path.join(path.dirname(bundle), "mavis-token-optimizer-backups");

const home = os.homedir();
const mavisRoot = path.join(home, ".mavis", "agents", "mavis");
const perFileBackupDirs = [
  path.join(mavisRoot, "opencode", "plugins", "backups"),
  path.join(mavisRoot, "opencode", "backups"),
  path.join(mavisRoot, "context-budget", "config", "backups")
];

const dirsToClean = [patcherBackupDir];
if (allDirs) {
  for (const dir of perFileBackupDirs) dirsToClean.push(dir);
}

function cleanDir(dir, keep) {
  if (!fs.existsSync(dir)) {
    console.log(`absent=${dir}`);
    return { scanned: 0, removed: 0, kept: 0 };
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    console.log(`skip_not_dir=${dir}`);
    return { scanned: 0, removed: 0, kept: 0 };
  }
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const full = path.join(dir, entry.name);
      const st = fs.statSync(full);
      return { name: entry.name, path: full, mtimeMs: st.mtimeMs, sizeBytes: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const survivors = entries.slice(0, keep);
  const doomed = entries.slice(keep);
  for (const file of doomed) {
    if (apply) {
      try {
        fs.unlinkSync(file.path);
        console.log(`removed=${file.path} (${file.sizeBytes} bytes)`);
      } catch (err) {
        console.log(`remove_failed=${file.path} ${err.message}`);
      }
    } else {
      console.log(`would_remove=${file.path} (${file.sizeBytes} bytes)`);
    }
  }
  return {
    scanned: entries.length,
    removed: apply ? doomed.length : 0,
    kept: survivors.length
  };
}

console.log(`mode=${apply ? "apply" : "dry-run"}`);
console.log(`keep=${keep}`);
console.log(`all_dirs=${allDirs}`);
console.log("");

let totalScanned = 0;
let totalRemoved = 0;
let totalKept = 0;
for (const dir of dirsToClean) {
  console.log(`dir=${dir}`);
  const result = cleanDir(dir, keep);
  totalScanned += result.scanned;
  totalRemoved += result.removed;
  totalKept += result.kept;
  console.log("");
}

const totalToRemove = totalScanned - totalKept;
console.log(`totals scanned=${totalScanned} kept=${totalKept} ${apply ? "removed" : "would_remove"}=${apply ? totalRemoved : totalToRemove}`);
if (!apply && totalToRemove > 0) {
  console.log(`hint: pass --apply to actually delete ${totalToRemove} file(s)`);
}
