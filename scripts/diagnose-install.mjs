#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

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

const jsonMode = args.has("json");
const home = os.homedir();
const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
const defaultBundle = path.join(
  localAppData,
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
const bundlePath = path.resolve(args.get("target") ?? defaultBundle);
const mavisRoot = path.resolve(args.get("mavis-root") ?? path.join(home, ".mavis", "agents", "mavis"));
const policyPath = path.join(mavisRoot, "context-budget", "config", "policy.json");
const pluginsDir = path.join(mavisRoot, "opencode", "plugins");

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJson(filePath) {
  const text = readText(filePath);
  if (text === null) return { ok: false, exists: false, value: null, error: "not found" };
  try {
    return { ok: true, exists: true, value: JSON.parse(text), error: null };
  } catch (err) {
    return { ok: false, exists: true, value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function commandVersion(command, args2 = ["--version"]) {
  const result = spawnSync(command, args2, { encoding: "utf8", shell: process.platform === "win32" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return {
    found: result.status === 0,
    status: result.status,
    version: output.split(/\r?\n/).find(Boolean) ?? null
  };
}

function marker(source, name, pattern) {
  const present = typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
  return { name, present };
}

function inspectBundle() {
  if (!exists(bundlePath)) {
    return {
      path: bundlePath,
      exists: false,
      compatible: false,
      patched: false,
      markers: [],
      missingRequiredAnchors: ["bundle file"]
    };
  }

  const source = fs.readFileSync(bundlePath, "utf8");
  const stats = fs.statSync(bundlePath);
  const markers = [
    marker(source, "patchMiniMaxPromptCacheBody", "function patchMiniMaxPromptCacheBody(bodyText) {"),
    marker(source, "promptSurfaceLimits", "function promptSurfaceLimits() {"),
    marker(source, "compactDescription", "function compactDescription("),
    marker(source, "annotatePromptCacheTools", "function annotatePromptCacheTools(tools) {"),
    marker(source, "maxTokenCap8192", "var MINIMAX_DEFAULT_MAX_TOKENS = 8192"),
    marker(source, "maxTokenEnvOverride", "process.env.MAVIS_MINIMAX_MAX_TOKENS"),
    marker(source, "requestSectionDiagnostics", "sectionBytes"),
    marker(source, "largestToolDiagnostics", "largestTools"),
    marker(source, "finalToolDescriptionTrim", "function trimFinalToolDescriptionsForMax(tools) {"),
    marker(source, "toolTrimDiagnostics", "toolDescriptionsTrimmed"),
    marker(source, "requestPatcherExport", "patchMiniMaxPromptCacheBody,")
  ];

  const requiredForPatcher = [
    "patchMiniMaxPromptCacheBody",
    "promptSurfaceLimits",
    "compactDescription",
    "annotatePromptCacheTools",
    "maxTokenCap8192"
  ];
  const missingRequiredAnchors = requiredForPatcher.filter((name) => !markers.find((m) => m.name === name)?.present);
  const patchedMarkers = ["finalToolDescriptionTrim", "toolTrimDiagnostics", "requestPatcherExport"];
  const patched = patchedMarkers.every((name) => markers.find((m) => m.name === name)?.present);

  return {
    path: bundlePath,
    exists: true,
    sizeBytes: stats.size,
    modified: stats.mtime.toISOString(),
    sha256: sha256(source),
    compatible: missingRequiredAnchors.length === 0,
    patched,
    markers,
    missingRequiredAnchors
  };
}

function inspectPolicy() {
  const parsed = readJson(policyPath);
  const routing = parsed.value?.openrouter_lifecycle?.routing;
  const expectedRoles = ["main", "small", "plan", "build", "general", "explore"];
  const missingRoutingRoles = expectedRoles.filter((role) => !routing || typeof routing[role] !== "string" || !routing[role]);
  return {
    path: policyPath,
    exists: parsed.exists,
    parseOk: parsed.ok,
    error: parsed.error,
    profile: parsed.value?.profile ?? null,
    openrouterLifecycleEnabled: parsed.value?.openrouter_lifecycle?.enabled ?? null,
    routing: routing ?? null,
    missingRoutingRoles,
    mainDirectM3: routing?.main === "minimax/MiniMax-M3"
  };
}

function inspectPlugins() {
  const pluginNames = ["openrouter-lifecycle.js", "prompt-cache.js"];
  return {
    dir: pluginsDir,
    exists: exists(pluginsDir),
    plugins: pluginNames.map((name) => {
      const filePath = path.join(pluginsDir, name);
      const text = readText(filePath);
      return {
        name,
        path: filePath,
        exists: text !== null,
        sizeBytes: text === null ? null : Buffer.byteLength(text, "utf8"),
        sha256: text === null ? null : sha256(text)
      };
    })
  };
}

function inspectOpenRouterKey() {
  const desktopKey = path.join(home, "Desktop", "minimax_openrouter_key.txt");
  return {
    envOpenRouterApiKey: Boolean(process.env.OPENROUTER_API_KEY?.trim()),
    envMavisOpenRouterApiKey: Boolean(process.env.MAVIS_OPENROUTER_API_KEY?.trim()),
    envKeyFile: process.env.MAVIS_OPENROUTER_KEY_FILE ?? null,
    desktopKeyFileExists: exists(desktopKey),
    desktopKeyFilePath: desktopKey
  };
}

function summarize(report) {
  const issues = [];
  if (!report.bundle.exists) issues.push("MiniMax bundled opencode plugin was not found.");
  if (report.bundle.exists && !report.bundle.compatible) {
    issues.push(`Bundle missing patch anchors: ${report.bundle.missingRequiredAnchors.join(", ")}.`);
  }
  if (report.policy.exists && !report.policy.parseOk) issues.push(`Policy JSON does not parse: ${report.policy.error}.`);
  if (report.policy.exists && report.policy.parseOk && !report.policy.mainDirectM3) {
    issues.push("Policy does not keep routing.main on minimax/MiniMax-M3.");
  }
  const missingPlugins = report.plugins.plugins.filter((p) => !p.exists).map((p) => p.name);
  if (missingPlugins.length > 0) issues.push(`Standalone plugins missing: ${missingPlugins.join(", ")}.`);

  let nextAction = "No action needed.";
  if (!report.bundle.exists || !report.bundle.compatible) {
    nextAction = "Stop and run a compatibility pass for this MiniMax Code version.";
  } else if (!report.bundle.patched) {
    nextAction = "Run: node .\\scripts\\apply-mavis-opencode-optimizations.mjs";
  } else if (missingPlugins.length > 0) {
    nextAction = "Run: powershell -ExecutionPolicy Bypass -File .\\scripts\\install-user-plugins.ps1";
  } else {
    nextAction = "Run verification and then reload worker if needed.";
  }

  return {
    ok: issues.length === 0 && report.bundle.compatible && report.bundle.patched,
    issues,
    nextAction
  };
}

const report = {
  timestamp: new Date().toISOString(),
  platform: {
    os: process.platform,
    arch: process.arch,
    node: process.version,
    home
  },
  commands: {
    git: commandVersion("git"),
    gh: commandVersion("gh"),
    mavis: commandVersion("mavis", ["--version"])
  },
  bundle: inspectBundle(),
  mavisRoot,
  policy: inspectPolicy(),
  plugins: inspectPlugins(),
  openrouterKey: inspectOpenRouterKey()
};
report.summary = summarize(report);

if (jsonMode) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("MiniMax Code Token Optimizer diagnostic");
  console.log(`timestamp=${report.timestamp}`);
  console.log(`bundle=${report.bundle.path}`);
  console.log(`bundle_exists=${report.bundle.exists}`);
  if (report.bundle.exists) {
    console.log(`bundle_sha256=${report.bundle.sha256}`);
    console.log(`bundle_size=${report.bundle.sizeBytes}`);
    console.log(`bundle_compatible=${report.bundle.compatible}`);
    console.log(`bundle_patched=${report.bundle.patched}`);
    for (const item of report.bundle.markers) {
      console.log(`marker.${item.name}=${item.present}`);
    }
  }
  console.log(`mavis_root=${report.mavisRoot}`);
  console.log(`policy_exists=${report.policy.exists}`);
  console.log(`policy_parse_ok=${report.policy.parseOk}`);
  console.log(`policy_profile=${report.policy.profile}`);
  console.log(`policy_main_direct_m3=${report.policy.mainDirectM3}`);
  console.log(`plugins_dir=${report.plugins.dir}`);
  for (const plugin of report.plugins.plugins) {
    console.log(`plugin.${plugin.name}.exists=${plugin.exists}`);
  }
  console.log(`openrouter_key.env_OPENROUTER_API_KEY=${report.openrouterKey.envOpenRouterApiKey}`);
  console.log(`openrouter_key.env_MAVIS_OPENROUTER_API_KEY=${report.openrouterKey.envMavisOpenRouterApiKey}`);
  console.log(`openrouter_key.desktop_file_exists=${report.openrouterKey.desktopKeyFileExists}`);
  if (report.summary.issues.length > 0) {
    console.log("issues:");
    for (const issue of report.summary.issues) console.log(`- ${issue}`);
  }
  console.log(`next_action=${report.summary.nextAction}`);
}

process.exit(report.summary.ok ? 0 : 2);

