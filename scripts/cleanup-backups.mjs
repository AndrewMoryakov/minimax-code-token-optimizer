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
                    plugins, skills/bridge, sqlite) created by install.mjs.
                    Auto-detects both v1 and v2 paths. Default: only the
                    patcher backup dir (also auto-detected).
  --target <path>    Override the patcher bundle path (uses the same default
                    as apply-mavis-opencode-optimizations.mjs otherwise)
  --help, -h         Show this help

Notes:
  Without --apply the script only reports what it would delete.

  v1 vs v2 paths: the v1 patcher path is under
    <LocalAppData>\\Programs\\MiniMax Code\\resources\\resources\\daemon\\...
    (duplicated 'resources' segment is v1-only). On v2 (Mavis 3.0.67.128+),
    that path does not exist; the equivalent backup dir is
    <home>/.mavis/agents/mavis/workspace/bundle-patches/mavis-opencode-plugin/backups.
    v2 also creates new backup dirs (skills/bridge, v2/sqlite) that
    the v1 script did not know about. This script auto-detects whichever
    exist on the running install.
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
const mavisTop = path.join(home, ".mavis");

// v1 backup paths (still present on most installs as stale data).
// Discovered by running this script on Mavis 3.0.67.128 (v2) — these
// were left behind from an earlier v1 install and are still valid
// targets for cleanup.
const v1PerFileBackupDirs = [
  path.join(mavisRoot, "opencode", "plugins", "backups"),
  path.join(mavisRoot, "opencode", "backups"),
  path.join(mavisRoot, "context-budget", "config", "backups"),
];

// v2 backup paths discovered during the 2026-08-28 audit:
// - skills/bridge/backups: pre/post install snapshots of the bridge SKILL.md
// - workspace/bundle-patches/.../backups: pre-reapply snapshots of the
//   patched bundle index.js (1.2 MB each)
// - v2/sqlite/backups: pre-v2-migration runtime-state.sqlite (9.3 MB)
const v2PerFileBackupDirs = [
  path.join(mavisRoot, "skills", "bridge", "backups"),
  path.join(mavisRoot, "workspace", "bundle-patches", "mavis-opencode-plugin", "backups"),
  path.join(mavisTop, "v2", "sqlite", "backups"),
];

// v2 patcher backup path (the v1 path does not exist on v2).
// If found, auto-included in the default scan.
const v2PatcherBackup = path.join(
  mavisRoot,
  "workspace",
  "bundle-patches",
  "mavis-opencode-plugin",
  "backups"
);

const dirsToClean = [patcherBackupDir];
if (fs.existsSync(v2PatcherBackup) && !dirsToClean.includes(v2PatcherBackup)) {
  dirsToClean.push(v2PatcherBackup);
}
if (allDirs) {
  for (const dir of v1PerFileBackupDirs) dirsToClean.push(dir);
  for (const dir of v2PerFileBackupDirs) dirsToClean.push(dir);
}
// Dedupe (v2PatcherBackup may be in v2PerFileBackupDirs).
const uniqueDirsToClean = [...new Set(dirsToClean)];

function cleanDir(dir, keep) {
  if (!fs.existsSync(dir)) {
    console.log(`absent=${dir}`);
    return { scanned: 0, removed: 0, kept: 0 };
  }
  // fs.readdirSync on a non-directory would throw ENOTDIR; no extra
  // isDirectory() check needed.
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
  let actuallyRemoved = 0;
  for (const file of doomed) {
    if (!apply) {
      console.log(`would_remove=${file.path} (${file.sizeBytes} bytes)`);
      continue;
    }
    try {
      fs.unlinkSync(file.path);
      actuallyRemoved += 1;
      console.log(`removed=${file.path} (${file.sizeBytes} bytes)`);
    } catch (err) {
      console.log(`remove_failed=${file.path} ${err.message}`);
    }
  }
  return {
    scanned: entries.length,
    removed: actuallyRemoved,
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
for (const dir of uniqueDirsToClean) {
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
