#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptCachePath = pathToFileURL(path.join(repoRoot, "plugins", "prompt-cache.js")).href;
const promptCache = (await import(promptCachePath)).default;
const { patchBody, countBreakpoints, MAX_BREAKPOINTS } = promptCache.__test;

const countMarkers = (text) => (text.match(/"cache_control"/g) || []).length;
const MINIMAX_URL = "https://agent.minimax.io/mavis/api/v1/llm/v1/messages";

const freshBody = {
  model: "MiniMax-M3",
  system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
  messages: [{ role: "user", content: [{ type: "text", text: "file" }, { type: "text", text: "q" }] }],
  tools: [{ name: "bash", description: "d" }]
};

const fresh = patchBody(JSON.stringify(freshBody), "minimax");
assert.equal(fresh.breakpointsAdded, 3);
assert.equal(countMarkers(fresh.body), 3);

// A body that already carries the ceiling is returned byte for byte.
const saturated = JSON.stringify({
  system: [
    { type: "text", text: "a", cache_control: { type: "ephemeral" } },
    { type: "text", text: "b", cache_control: { type: "ephemeral" } }
  ],
  messages: [{
    role: "user",
    content: [
      { type: "text", text: "ctx", cache_control: { type: "ephemeral" } },
      { type: "text", text: "q", cache_control: { type: "ephemeral" } }
    ]
  }],
  tools: [{ name: "bash", description: "d" }]
});
assert.equal(countBreakpoints(JSON.parse(saturated)), MAX_BREAKPOINTS);
const saturatedResult = patchBody(saturated, "minimax");
assert.equal(saturatedResult.breakpointsAdded, 0);
assert.equal(saturatedResult.body, saturated);
assert.equal(saturatedResult.details.existingBreakpoints, MAX_BREAKPOINTS);

// Partially marked: only the remaining budget is spent.
const partly = JSON.stringify({
  system: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }],
  tools: [{ name: "bash", description: "d" }, { name: "read", description: "d" }]
});
const partlyResult = patchBody(partly, "minimax");
assert.ok(countMarkers(partlyResult.body) <= MAX_BREAKPOINTS);
assert.equal(partlyResult.breakpointsAdded, 1);

// Retry policy: the plugin installs one fetch wrapper per process, so each case
// swaps the underlying fetch it delegates to.
let attempts = [];
let respond = () => new Response("{}", { status: 200 });
globalThis.fetch = async (input, init) => {
  attempts.push(init?.body ? countMarkers(init.body) : 0);
  return respond();
};
await promptCache();

async function send(makeResponse) {
  attempts = [];
  respond = makeResponse;
  const response = await fetch(MINIMAX_URL, { method: "POST", body: JSON.stringify(freshBody) });
  return { attempts: [...attempts], status: response.status, text: await response.text() };
}

const rateLimited = await send(() => new Response('{"error":"rate limited"}', { status: 429 }));
assert.equal(rateLimited.attempts.length, 1, "429 must not be retried");
assert.equal(rateLimited.status, 429);

// Retry is gated on the status as well as the message: a 429 whose body happens
// to mention cache_control must still not be retried.
const rateLimitedMentioningCache = await send(() => new Response(
  '{"error":{"message":"rate limited while validating cache_control"}}',
  { status: 429 }
));
assert.equal(rateLimitedMentioningCache.attempts.length, 1, "429 must not be retried even when it mentions cache_control");

const guardBlocked = await send(() => new Response('{"error":{"type":"mavis_request_guard_blocked"}}', { status: 413 }));
assert.equal(guardBlocked.attempts.length, 1, "413 must not be retried");

const unrelated400 = await send(() => new Response('{"error":{"message":"model not found"}}', { status: 400 }));
assert.equal(unrelated400.attempts.length, 1, "an unrelated 400 must not be retried");
assert.equal(unrelated400.status, 400);
assert.match(unrelated400.text, /model not found/, "the original error body must survive");

const cacheError = await send(() => new Response(
  '{"error":{"message":"A maximum of 4 blocks with cache_control may be provided"}}',
  { status: 400 }
));
assert.equal(cacheError.attempts.length, 2, "a cache_control 400 is retried once");
assert.equal(cacheError.attempts[0], 3);
assert.equal(cacheError.attempts[1], 0, "the retry sends the original unpatched body");

console.log("plugin behaviour test passed");
