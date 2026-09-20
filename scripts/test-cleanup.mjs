#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-cleanup-"));

function write(filePath, mtime) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x", "utf8");
  fs.utimesSync(filePath, mtime, mtime);
}

// Ours: per-file backups written by install.mjs.
const ourBackups = path.join(home, ".mavis", "agents", "mavis", "opencode", "backups");
for (let i = 0; i < 8; i += 1) {
  write(path.join(ourBackups, `opencode.json.before-token-optimizer.2026090${i}-120000`), 1_780_000_000 + i * 86_400);
}

// MiniMax's own: pre-migration database snapshots, three files per snapshot,
// each triple sharing one timestamp.
const foreign = path.join(home, ".mavis", "v2", "sqlite", "backups");
const snapshots = ["1786443227166-d37a", "1787634272045-33a8", "1788074872701-d1b5"];
snapshots.forEach((id, index) => {
  for (const suffix of ["", "-shm", "-wal"]) {
    write(path.join(foreign, `runtime-state-before-v2-migration-${id}.sqlite${suffix}`), 1_780_000_000 + index * 86_400);
  }
});

const result = spawnSync(
  process.execPath,
  [path.join(repoRoot, "scripts", "cleanup-backups.mjs"), "--all-dirs", "--keep", "5", "--apply"],
  { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, "AppData", "Local") } }
);
assert.equal(result.status, 0, result.stderr);

// Every MiniMax snapshot file survives, triples intact.
const survivors = fs.readdirSync(foreign).sort();
assert.equal(survivors.length, snapshots.length * 3, `foreign backups were touched: ${survivors.join(", ")}`);
for (const id of snapshots) {
  for (const suffix of ["", "-shm", "-wal"]) {
    assert.ok(survivors.includes(`runtime-state-before-v2-migration-${id}.sqlite${suffix}`));
  }
}
assert.match(result.stdout, /not_ours=.*sqlite[\\/]+backups/);
assert.ok(!result.stdout.includes(`removed=${foreign}`), "must not report removals in a foreign directory");

// Our own directory is still trimmed to the keep count.
assert.equal(fs.readdirSync(ourBackups).length, 5);

fs.rmSync(home, { recursive: true, force: true });
console.log("cleanup scope test passed");
