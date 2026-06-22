// prompt-surface.js
// Shrinks high-frequency static prompt blocks injected by the Mavis plugin.
// The reducer is intentionally narrow: it only rewrites <available_skills>
// and <available_mcp_servers>, and it fails open on any unexpected shape.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const POLICY_FILE = path.join(os.homedir(), ".mavis", "agents", "mavis", "context-budget", "config", "policy.json");
const DISABLED = process.env.MAVIS_PROMPT_SURFACE_DISABLED === "1";
const DEFAULT_PROFILE = "max";

const PROFILES = {
  max: {
    skillDescChars: 110,
    skillBlockChars: 7000,
    mcpStyle: "compact",
  },
  medium: {
    skillDescChars: 170,
    skillBlockChars: 11000,
    mcpStyle: "balanced",
  },
  free: {
    skillDescChars: 260,
    skillBlockChars: 16000,
    mcpStyle: "balanced",
  },
};

function log(event, payload = {}) {
  try {
    process.stderr.write(
      "[prompt-surface] " +
        event +
        " " +
        JSON.stringify({ ts: new Date().toISOString(), ...payload }) +
        "\n"
    );
  } catch (_) {}
}

function readPolicyProfile() {
  try {
    const policy = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
    return typeof policy.profile === "string" ? policy.profile : null;
  } catch (_) {
    return null;
  }
}

function selectedProfile() {
  const fromEnv = process.env.MAVIS_PROMPT_SURFACE_MODE;
  const profile = fromEnv || readPolicyProfile() || DEFAULT_PROFILE;
  return Object.prototype.hasOwnProperty.call(PROFILES, profile) ? profile : DEFAULT_PROFILE;
}

function compactWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function truncate(text, maxChars) {
  const s = compactWhitespace(text);
  if (s.length <= maxChars) return s;
  return s.slice(0, Math.max(0, maxChars - 3)).trimEnd() + "...";
}

function replaceBlock(text, tag, replacer) {
  const re = new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, "m");
  const match = text.match(re);
  if (!match) return { text, changed: false, before: 0, after: 0 };
  const before = match[0].length;
  const replacement = replacer(match[0]);
  if (typeof replacement !== "string" || replacement.length === 0 || replacement === match[0]) {
    return { text, changed: false, before, after: before };
  }
  return {
    text: text.slice(0, match.index) + replacement + text.slice(match.index + match[0].length),
    changed: true,
    before,
    after: replacement.length,
  };
}

function parseSkills(block) {
  const re = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<\/skill>/g;
  const skills = [];
  let match;
  while ((match = re.exec(block))) {
    const name = compactWhitespace(match[1]);
    const description = compactWhitespace(match[2]);
    if (name) skills.push({ name, description });
  }
  return skills;
}

function renderSkills(skills, cfg) {
  const entries = [];
  let used = "<available_skills>\n".length + "</available_skills>".length;
  for (const skill of skills) {
    const desc = truncate(skill.description, cfg.skillDescChars);
    const entry = [
      "  <skill>",
      `    <name>${skill.name}</name>`,
      `    <description>${desc}</description>`,
      "  </skill>",
    ].join("\n");
    const cost = entry.length + 1;
    if (used + cost > cfg.skillBlockChars) break;
    entries.push(entry);
    used += cost;
  }
  return [
    "<available_skills>",
    ...entries,
    "</available_skills>",
    "",
    "Install skills only when explicitly requested; discover full skill docs by name when needed.",
  ].join("\n");
}

function reduceSkillsBlock(block, cfg) {
  const skills = parseSkills(block);
  if (skills.length === 0) return block;
  return renderSkills(skills, cfg);
}

function compactMcpBlock(style) {
  const detail = style === "compact"
    ? [
        "- cu: desktop control. Key tools: desktop_screenshot, desktop_left_click, desktop_type, desktop_key, desktop_scroll, desktop_window_list, desktop_clipboard_read/write.",
        "- matrix: media understanding/generation and web/image search. Native tool: web_search. Discover exact tools with `mavis mcp tools matrix`.",
        "- playwright: browser automation. Discover exact tools with `mavis mcp tools playwright`.",
        "- trash: recoverable deletion. Prefer `mavis-trash <path>` or the trash tool over permanent delete.",
      ]
    : [
        "- cu: desktop control through desktop_* tools; use screenshots first, then click/type/key/scroll/window/clipboard actions.",
        "- matrix: image/video/audio understanding, media generation, web search, image search, CDN upload. Native tool: web_search.",
        "- playwright: browser automation for navigation, click/fill, screenshots, PDFs, accessibility snapshots.",
        "- trash: recoverable file deletion; use before any irreversible delete operation.",
      ];
  return [
    "<available_mcp_servers>",
    "Local MCP servers are available. Use `mavis mcp tools <server>` for schema discovery and `mavis mcp call <server> <tool> '{\"key\":\"value\"}'` to invoke CLI-only tools.",
    ...detail,
    "</available_mcp_servers>",
  ].join("\n");
}

function reduceMcpBlock(_block, cfg) {
  return compactMcpBlock(cfg.mcpStyle);
}

function reduceSystemPrompt(text, options = {}) {
  if (typeof text !== "string" || text.length === 0) {
    return { text, changed: false, before: 0, after: 0, profile: selectedProfile() };
  }
  const profile = options.profile || selectedProfile();
  const cfg = PROFILES[profile] || PROFILES[DEFAULT_PROFILE];
  let out = text;
  let changed = false;
  let saved = 0;

  const skills = replaceBlock(out, "available_skills", (block) => reduceSkillsBlock(block, cfg));
  out = skills.text;
  changed = changed || skills.changed;
  saved += Math.max(0, skills.before - skills.after);

  const mcp = replaceBlock(out, "available_mcp_servers", (block) => reduceMcpBlock(block, cfg));
  out = mcp.text;
  changed = changed || mcp.changed;
  saved += Math.max(0, mcp.before - mcp.after);

  return { text: out, changed, before: text.length, after: out.length, saved, profile };
}

async function plugin() {
  if (DISABLED) return {};
  const profile = selectedProfile();
  log("loaded", { profile });
  return {
    "chat.params": async (_input = {}, output = {}) => {
      try {
        if (!Array.isArray(output.system) || output.system.length === 0) return;
        const before = output.system.join("\n\n");
        const reduced = reduceSystemPrompt(before, { profile });
        if (!reduced.changed) return;
        output.system.length = 0;
        output.system.push(reduced.text);
        log("reduced", {
          profile: reduced.profile,
          beforeChars: reduced.before,
          afterChars: reduced.after,
          savedChars: reduced.saved,
        });
      } catch (error) {
        log("failed_open", { message: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

plugin.__test = {
  selectedProfile,
  reduceSystemPrompt,
  reduceSkillsBlock,
  reduceMcpBlock,
};

export default plugin;
