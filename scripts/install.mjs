#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "-h") {
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
  console.log(`MiniMax Code Token Optimizer installer

Usage:
  node .\\scripts\\install.mjs [options]

Safe first run:
  node .\\scripts\\diagnose-install.mjs
  node .\\scripts\\install.mjs --profile max --dry-run
  node .\\scripts\\install.mjs --profile max --reload

Options:
  --profile <max|medium|free>       Economy profile. Default: max
  --dry-run                         Preview changes without writing files
  --reload                          Reload OpenCode worker after verification
  --mavis-root <path>               Mavis root. Default: %USERPROFILE%\\.mavis\\agents\\mavis
  --target <path>                   Custom @mavis/opencode-plugin index.js path
  --skip-policy                     Do not merge policy.json
  --skip-plugins                    Do not copy standalone plugins
  --skip-plugin-registration        Do not edit generated opencode.json
  --skip-bundle                     Do not patch bundled @mavis/opencode-plugin
  --skip-verify                     Skip post-install verification
  --help, -h                        Show this help

Notes:
  The installer creates backups before writing.
  If bundle anchors are missing, it stops instead of forcing a patch.
`);
}

if (args.has("help")) {
  usage();
  process.exit(0);
}

const profile = args.get("profile") ?? "max";
const allowedProfiles = new Set(["max", "medium", "free"]);
const home = os.homedir();
const mavisRoot = path.resolve(args.get("mavis-root") ?? path.join(home, ".mavis", "agents", "mavis"));
const target = args.get("target");
const dryRun = args.has("dry-run");
const skipPolicy = args.has("skip-policy");
const skipPlugins = args.has("skip-plugins");
const skipPluginRegistration = args.has("skip-plugin-registration");
const skipBundle = args.has("skip-bundle");
const skipVerify = args.has("skip-verify");
const reload = args.has("reload");

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const printable = [command, ...commandArgs].join(" ");
  console.log(`> ${printable}`);
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options
  });
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0 && !options.allowFailure) {
    fail(`command failed (${result.status}): ${printable}`);
  }
  return result;
}

function runNode(script, extraArgs = [], options = {}) {
  return run(process.execPath, [path.join(repoRoot, script), ...extraArgs], options);
}

function parseDiagnose() {
  const diagnoseArgs = ["--json", "--mavis-root", mavisRoot];
  if (target) diagnoseArgs.push("--target", target);
  const result = runNode("scripts/diagnose-install.mjs", diagnoseArgs, { allowFailure: true, quiet: true });
  try {
    return JSON.parse(result.stdout);
  } catch (err) {
    fail(`could not parse diagnostic JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function backupFile(filePath, label) {
  if (!fs.existsSync(filePath)) return null;
  const backupDir = path.join(path.dirname(filePath), "backups");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const backup = path.join(backupDir, `${path.basename(filePath)}.${label}.${stamp}`);
  if (!dryRun) {
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(filePath, backup);
  }
  return { path: backup, created: !dryRun };
}

function logBackup(backup) {
  if (!backup) return;
  console.log(`${backup.created ? "backup" : "would_backup"}=${backup.path}`);
}

function pluginSourceNames() {
  return ["openrouter-lifecycle.js", "prompt-surface.js", "request-guard.js", "prompt-cache.js"];
}

function pluginConfigNames() {
  return ["openrouter-lifecycle", "prompt-surface", "request-guard", "prompt-cache"];
}

function installPlugins() {
  const sourceDir = path.join(repoRoot, "plugins");
  const targetDir = path.join(mavisRoot, "opencode", "plugins");
  console.log("Installing standalone plugins");
  if (!dryRun) fs.mkdirSync(targetDir, { recursive: true });
  for (const name of pluginSourceNames()) {
    const source = path.join(sourceDir, name);
    const dest = path.join(targetDir, name);
    if (!fs.existsSync(source)) fail(`plugin source missing: ${source}`);
    const backup = backupFile(dest, "before-token-optimizer");
    logBackup(backup);
    if (!dryRun) fs.copyFileSync(source, dest);
    console.log(`${dryRun ? "would_install" : "installed"}=${dest}`);
  }
}

function registerPlugins() {
  const configPath = path.join(mavisRoot, "opencode", "opencode.json");
  if (!fs.existsSync(configPath)) {
    fail(`opencode config not found: ${configPath}`);
  }
  let current;
  try {
    current = readJson(configPath);
  } catch (err) {
    fail(`opencode config does not parse: ${configPath}\n${err instanceof Error ? err.message : String(err)}`);
  }
  const existing = Array.isArray(current.plugin) ? current.plugin : [];
  const withoutManaged = existing.filter((item) => !pluginConfigNames().includes(item));
  const mavisIndex = withoutManaged.indexOf("mavis");
  const base = mavisIndex === -1 ? ["mavis", ...withoutManaged] : withoutManaged;
  const insertAt = base.indexOf("mavis") + 1;
  const nextPlugins = [
    ...base.slice(0, insertAt),
    ...pluginConfigNames(),
    ...base.slice(insertAt),
  ];
  const next = { ...current, plugin: nextPlugins };
  const before = fs.readFileSync(configPath, "utf8");
  const after = stableStringify(next);
  if (before === after) {
    console.log(`plugins_registered_unchanged=${configPath}`);
    return;
  }
  const backup = backupFile(configPath, "before-token-optimizer");
  logBackup(backup);
  if (!dryRun) fs.writeFileSync(configPath, after, "utf8");
  console.log(`${dryRun ? "would_register_plugins" : "registered_plugins"}=${configPath}`);
  console.log(`plugin_order=${nextPlugins.join(",")}`);
}

function readJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

function stableStringify(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mergePolicy() {
  if (!allowedProfiles.has(profile)) {
    fail(`unsupported profile "${profile}". Expected one of: ${Array.from(allowedProfiles).join(", ")}`);
  }
  const examplePath = path.join(repoRoot, "examples", "policy.max-openrouter-lifecycle.json");
  const example = readJson(examplePath);
  const policyPath = path.join(mavisRoot, "context-budget", "config", "policy.json");
  const policyDir = path.dirname(policyPath);
  let existing = {};
  if (fs.existsSync(policyPath)) {
    try {
      existing = readJson(policyPath);
    } catch (err) {
      fail(`policy exists but does not parse: ${policyPath}\n${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const next = {
    ...existing,
    profile,
    profiles_note: {
      ...(existing.profiles_note ?? {}),
      ...example.profiles_note
    },
    openrouter_lifecycle: {
      ...(existing.openrouter_lifecycle ?? {}),
      ...example.openrouter_lifecycle,
      routing: {
        ...(existing.openrouter_lifecycle?.routing ?? {}),
        ...example.openrouter_lifecycle.routing,
        main: "minimax/MiniMax-M3"
      }
    }
  };
  const before = fs.existsSync(policyPath) ? fs.readFileSync(policyPath, "utf8") : null;
  const after = stableStringify(next);
  if (before === after) {
    console.log(`policy_unchanged=${policyPath}`);
    return;
  }
  const backup = backupFile(policyPath, "before-token-optimizer");
  logBackup(backup);
  if (!dryRun) {
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(policyPath, after, "utf8");
  }
  console.log(`${dryRun ? "would_write_policy" : "wrote_policy"}=${policyPath}`);
}

function validateInstallPlan() {
  if (!allowedProfiles.has(profile)) {
    fail(`unsupported profile "${profile}". Expected one of: ${Array.from(allowedProfiles).join(", ")}`);
  }
  if (!skipPlugins) {
    const sourceDir = path.join(repoRoot, "plugins");
    for (const name of pluginSourceNames()) {
      const source = path.join(sourceDir, name);
      if (!fs.existsSync(source)) fail(`plugin source missing: ${source}`);
    }
  }
  if (!skipPolicy) {
    readJson(path.join(repoRoot, "examples", "policy.max-openrouter-lifecycle.json"));
    const policyPath = path.join(mavisRoot, "context-budget", "config", "policy.json");
    if (fs.existsSync(policyPath)) {
      try {
        readJson(policyPath);
      } catch (err) {
        fail(`policy exists but does not parse: ${policyPath}\n${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

console.log("MiniMax Code Token Optimizer installer");
console.log(`repo=${repoRoot}`);
console.log(`mavis_root=${mavisRoot}`);
console.log(`profile=${profile}`);
if (dryRun) console.log("mode=dry-run");

const initial = parseDiagnose();
if (!initial.bundle.exists && !skipBundle) {
  fail([
    "MiniMax bundled opencode plugin was not found.",
    ...(initial.summary?.issues ?? []),
    "Install MiniMax Code or pass --target to the installed @mavis/opencode-plugin index.js."
  ].join("\n"));
}
if (initial.bundle.exists && !initial.bundle.compatible && !skipBundle) {
  console.log("bundle_preflight=compatibility-bootstrap-required");
}
validateInstallPlan();

if (!skipBundle) {
  const patchArgs = [];
  if (target) patchArgs.push("--target", target);
  if (dryRun) patchArgs.push("--dry-run");
  runNode("scripts/apply-mavis-opencode-optimizations.mjs", patchArgs);
} else {
  console.log("skip_bundle=true");
}

if (!skipPlugins) {
  installPlugins();
  if (!skipPluginRegistration) {
    registerPlugins();
  } else {
    console.log("skip_plugin_registration=true");
  }
} else {
  console.log("skip_plugins=true");
}

if (!skipPolicy) {
  mergePolicy();
} else {
  console.log("skip_policy=true");
}

if (!skipVerify && !dryRun) {
  const verifyArgs = [];
  if (target) verifyArgs.push("--target", target);
  runNode("scripts/verify-installed.mjs", verifyArgs);
  const finalReport = parseDiagnose();
  if (!finalReport.bundle.patched) fail("diagnose says bundle is still not patched");
  if (!finalReport.policy.mainDirectM3) fail("diagnose says policy main route is not direct M3");
  const missingPlugins = finalReport.plugins.plugins.filter((plugin) => !plugin.exists);
  if (missingPlugins.length > 0) fail(`diagnose says plugins are missing: ${missingPlugins.map((p) => p.name).join(", ")}`);
  if (!finalReport.opencodeConfig.pluginsRegistered) {
    console.log(`plugin_registration_warning=${finalReport.opencodeConfig.missingPlugins.join(",")}`);
  }
} else if (skipVerify) {
  console.log("skip_verify=true");
}

if (reload && !dryRun) {
  run("powershell", ["-ExecutionPolicy", "Bypass", "-File", path.join(repoRoot, "scripts", "reload-opencode-worker.ps1")]);
} else {
  console.log("reload_not_run=true");
  console.log("reload_command=powershell -ExecutionPolicy Bypass -File .\\scripts\\reload-opencode-worker.ps1");
}

console.log("install_complete=true");
