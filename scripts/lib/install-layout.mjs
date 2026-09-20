import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the v1 MiniMax Desktop kept the patchable OpenCode plugin bundle. The
// duplicated "resources" segment is not a typo; that is the shipped layout.
export const V1_BUNDLE_RELATIVE_PATH = path.join(
  "resources",
  "resources",
  "daemon",
  "node_modules",
  "@mavis",
  "opencode-plugin",
  "index.js"
);

export function defaultInstallRoot(env = process.env, home = os.homedir()) {
  const localAppData = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return path.join(localAppData, "Programs", "MiniMax Code");
}

export function defaultBundlePath(env = process.env, home = os.homedir()) {
  return path.join(defaultInstallRoot(env, home), V1_BUNDLE_RELATIVE_PATH);
}

// Reads only the asar header (a JSON directory listing at the head of the
// archive), never the packed file data. A MiniMax app.asar is ~480 MB; the
// header is a few MB.
export function readAsarHeaderText(asarPath) {
  let fd;
  try {
    fd = fs.openSync(asarPath, "r");
  } catch {
    return null;
  }
  try {
    const sizes = Buffer.alloc(16);
    if (fs.readSync(fd, sizes, 0, 16, 0) !== 16) return null;
    const headerLength = sizes.readUInt32LE(12);
    if (!Number.isInteger(headerLength) || headerLength <= 0 || headerLength > 64 * 1024 * 1024) return null;
    const header = Buffer.alloc(headerLength);
    if (fs.readSync(fd, header, 0, headerLength, 16) !== headerLength) return null;
    return header.toString("utf8");
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
  }
}

const UNSUPPORTED_V2_MESSAGE = [
  "This MiniMax Code install runs the v2 local-runtime (pi-agent).",
  "It ships no @mavis/opencode-plugin bundle, so there is nothing for this patcher to patch.",
  "Do not point --target at another file: the optimization anchors do not exist in this install.",
  "Standalone opencode plugins and context-budget policy.json are not read by this runtime either."
].join("\n");

/**
 * Classify a local MiniMax Code installation.
 *
 * v1 installs expose the OpenCode plugin bundle as a plain file on disk and can
 * be patched. v2 installs (Mavis 3.0.6x+) moved the runtime into app.asar as
 * @mavis/local-runtime, keeping opencode only as migration code, and nothing in
 * this toolkit reaches them.
 */
export function detectInstallLayout(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const installRoot = path.resolve(options.installRoot ?? defaultInstallRoot(env, home));
  const bundlePath = path.resolve(options.bundlePath ?? path.join(installRoot, V1_BUNDLE_RELATIVE_PATH));
  const asarPath = path.join(installRoot, "resources", "app.asar");

  const evidence = [];
  const bundleExists = fs.existsSync(bundlePath);
  evidence.push(`${bundleExists ? "found" : "missing"}=${bundlePath}`);

  if (bundleExists) {
    return {
      layout: "v1-opencode-plugin",
      supported: true,
      installRoot,
      bundlePath,
      asarPath,
      evidence,
      message: null
    };
  }

  const installRootExists = fs.existsSync(installRoot);
  if (!installRootExists) {
    return {
      layout: "not-installed",
      supported: false,
      installRoot,
      bundlePath,
      asarPath,
      evidence: [...evidence, `missing=${installRoot}`],
      message: `No MiniMax Code installation found at ${installRoot}.`
    };
  }

  const headerText = readAsarHeaderText(asarPath);
  if (headerText === null) {
    return {
      layout: "unknown",
      supported: false,
      installRoot,
      bundlePath,
      asarPath,
      evidence: [...evidence, `unreadable=${asarPath}`],
      message: `MiniMax Code is installed at ${installRoot}, but neither the patchable bundle nor a readable app.asar was found.`
    };
  }

  const hasLocalRuntime = headerText.includes('"local-runtime"');
  const hasOpenCodePlugin = headerText.includes('"opencode-plugin"');
  evidence.push(`app.asar.local-runtime=${hasLocalRuntime}`);
  evidence.push(`app.asar.opencode-plugin=${hasOpenCodePlugin}`);

  if (hasLocalRuntime && !hasOpenCodePlugin) {
    return {
      layout: "v2-local-runtime",
      supported: false,
      installRoot,
      bundlePath,
      asarPath,
      evidence,
      message: UNSUPPORTED_V2_MESSAGE
    };
  }

  return {
    layout: "unknown",
    supported: false,
    installRoot,
    bundlePath,
    asarPath,
    evidence,
    message: `Unrecognized MiniMax Code layout at ${installRoot}. Run a compatibility pass before patching anything.`
  };
}
