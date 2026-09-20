import fs from "node:fs";

// Windows PowerShell 5.1 writes UTF-8 *with* a BOM for -Encoding UTF8, and
// MiniMax Desktop regenerates opencode.json on its own. JSON.parse rejects a
// leading U+FEFF, so every config read in this repo strips it first.
export function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function readJsonText(filePath) {
  return stripBom(fs.readFileSync(filePath, "utf8"));
}

export function parseJsonFile(filePath) {
  return JSON.parse(readJsonText(filePath));
}

// Write without a BOM and with a trailing newline, matching what the installer
// already produced on the Node side.
export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
