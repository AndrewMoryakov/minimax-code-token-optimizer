import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Parse-check patched bundle source before it is written.
 *
 * The transforms are anchored string edits and a hand-rolled brace matcher.
 * A bundle shape they mis-read produces a file that is still written and then
 * fails to load, which looks to the user like MiniMax itself breaking. Node
 * parses the candidate as a module first, then as CommonJS, so either bundle
 * flavour is accepted.
 */
export function checkSyntax(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mavis-token-optimizer-check-"));
  const errors = [];
  try {
    for (const ext of ["mjs", "cjs"]) {
      const candidate = path.join(dir, `candidate.${ext}`);
      fs.writeFileSync(candidate, source, "utf8");
      const result = spawnSync(process.execPath, ["--check", candidate], { encoding: "utf8" });
      if (result.status === 0) return { ok: true, parsedAs: ext === "mjs" ? "module" : "commonjs", errors: [] };
      const message = `${result.stderr ?? ""}`.split("\n").find((line) => /SyntaxError|Error:/.test(line));
      errors.push(`${ext}: ${message ?? "did not parse"}`);
    }
    return { ok: false, parsedAs: null, errors };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
