// Smoke test for dsh-search-endpoint-guard.
// Run from anywhere: the package entry is imported by absolute file URL so the
// plugin's own @deepseek-ai/* imports resolve through the profile's node_modules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENTRY = process.env.SMOKE_ENTRY ?? join(homedir(), ".dsh/profiles/web/node_modules/dsh-search-endpoint-guard/lib/index.js");
const { computeEndpoints, classify, apply, probeSearch } = await import(ENTRY);

let passed = 0;
const ok = (name) => { passed += 1; console.log("  PASS", name); };

// Real gateway key from the host credentials store (used only for live probes).
const credsFile = readFileSync(join(homedir(), ".dsh/.credentials.yaml"), "utf8");
const keyLine = credsFile.split("\n").find((l) => l.startsWith("DEEPSEEK_API_KEY:"));
assert.ok(keyLine, "credentials file has DEEPSEEK_API_KEY");
const realKey = keyLine.slice(keyLine.indexOf(":") + 1).trim();
const credentialsStub = { resolve: async () => ({ value: realKey }) };

// ---------- pure endpoint computation ----------
console.log("[1] computeEndpoints / classify (pure)");
const noEnv = { get: () => void 0 };

// The original bug: chat on a proxy/gateway, search still official default.
let ep = computeEndpoints({ baseURL: "https://opencode.ai/zen/go/v1" }, {}, noEnv);
assert.equal(ep.chatOfficial, false);
assert.equal(ep.searchOfficial, true);
assert.equal(classify(ep).status, "misaligned");
ok("bug state classified as misaligned");

// After the fix: search baseURL aligned to the chat endpoint.
ep = computeEndpoints({ baseURL: "https://opencode.ai/zen/go/v1" }, { baseURL: "https://opencode.ai/zen/go/v1" }, noEnv);
assert.equal(classify(ep).status, "aligned");
ok("aligned state classified as aligned");

// Both official: quiet.
ep = computeEndpoints({}, {}, noEnv);
assert.equal(classify(ep).status, "aligned");
assert.equal(ep.chatBaseURL, "https://api.deepseek.com");
assert.equal(ep.searchBaseURL, "https://api.deepseek.com/anthropic/v1");
ok("all-official state is aligned");

// Two different custom endpoints.
ep = computeEndpoints({ baseURL: "https://a.example/v1" }, { baseURL: "https://b.example" }, noEnv);
assert.equal(classify(ep).status, "differing");
ok("different custom endpoints classified as differing");

// Env fallback (DEEPSEEK_SEARCH_BASE_URL) is honored.
ep = computeEndpoints({ baseURL: "https://a.example/v1" }, {}, {
  get: (k) => k === "DEEPSEEK_SEARCH_BASE_URL" ? { value: "https://a.example/v1" } : void 0
});
assert.equal(classify(ep).status, "aligned");
ok("search env fallback honored");

// Trailing slashes compare equal.
ep = computeEndpoints({ baseURL: "https://opencode.ai/zen/go/v1/" }, { baseURL: "https://opencode.ai/zen/go/v1" }, noEnv);
assert.equal(ep.chatBaseURL, ep.searchBaseURL);
ok("trailing-slash normalization");

// Official chat with /v1 suffix counts as official.
ep = computeEndpoints({ baseURL: "https://api.deepseek.com/v1" }, {}, noEnv);
assert.equal(ep.chatOfficial, true);
ok("official /v1 chat base recognized");

// ---------- apply() with a fake ctx ----------
console.log("[2] apply() wiring + search_endpoint_check tool");
const sections = {
  "llm-deepseek": { baseURL: "https://opencode.ai/zen/go/v1" },
  "web-search-deepseek": {}
};
const writes = [];
let injectCb = null;
let registeredTool = null;
let promptSection = null;
const fakeCtx = {
  get: (k) => k === "credentials" ? credentialsStub : void 0,
  inject: (_names, cb) => { injectCb = cb; },
  tools: { register: (tool) => { registeredTool = tool; } },
  systemPrompt: { section: (s) => { promptSection = s; } },
  logger: { info: () => {}, warn: () => {} }
};
apply(fakeCtx, { autoAlign: false, checkOnStartup: false, probeTimeoutMs: 30000 });
injectCb({ settings: {
  get: (ns) => sections[ns],
  update: async (ns, patch) => { writes.push([ns, patch]); sections[ns] = { ...sections[ns], ...patch }; }
} });

assert.ok(registeredTool, "tool registered");
assert.equal(registeredTool.name, "search_endpoint_check");
assert.ok(promptSection && promptSection.name === "search-endpoint-guard:usage");
ok("tool + system prompt section registered");

const r0 = await registeredTool.execute({}, {});
assert.equal(r0.status, "misaligned");
assert.equal(r0.applied, false);
assert.equal(r0.keyPresent, true);
ok("diagnose-only call reports misaligned (key present)");

// Before fixing: probe the official endpoint with the gateway key → must fail.
const r0p = await registeredTool.execute({ probe: true }, {});
assert.ok(r0p.probe && r0p.probe.ok === false, "official-endpoint probe must fail with the gateway key");
assert.match(r0p.probe.detail, /Authentication Fails|HTTP 401|invalid/i);
assert.ok(!r0p.probe.detail.includes("sk-"), "key must never leak into probe detail");
ok("probe against official endpoint fails cleanly (auth error, no key leak)");

const r1 = await registeredTool.execute({ apply: true }, {});
assert.equal(r1.applied, true);
assert.equal(r1.status, "aligned");
assert.deepEqual(writes, [["web-search-deepseek", { baseURL: "https://opencode.ai/zen/go/v1" }]]);
ok("apply:true aligned and persisted via settings");

const r2 = await registeredTool.execute({ apply: true }, {});
assert.equal(r2.status, "aligned");
assert.equal(writes.length, 1, "no second write when already aligned");
ok("second apply is a no-op");

// After fixing: probe the gateway endpoint → must succeed.
const r3 = await registeredTool.execute({ probe: true }, {});
assert.ok(r3.probe && r3.probe.ok === true, "aligned probe should succeed, got: " + JSON.stringify(r3.probe));
assert.ok(!r3.probe.detail.includes("sk-"), "key must never leak into probe detail");
ok("probe against aligned gateway endpoint succeeds (HTTP " + r3.probe.statusCode + ")");

// ---------- direct probeSearch API against the real gateway ----------
console.log("[3] direct probeSearch API");
const probeCtx = {
  get: (k) => k === "credentials" ? credentialsStub : void 0,
  inject: () => {}, tools: { register: () => {} }, systemPrompt: { section: () => {} },
  logger: { info: () => {}, warn: () => {} }
};
const proxySections = {
  "llm-deepseek": { baseURL: "https://opencode.ai/zen/go/v1" },
  "web-search-deepseek": { baseURL: "https://opencode.ai/zen/go/v1" }
};
const probeResult = await probeSearch(probeCtx, (ns) => proxySections[ns], 30000);
assert.equal(probeResult.ok, true, "probe against gateway should succeed, got: " + JSON.stringify(probeResult));
assert.ok(!probeResult.detail.includes("sk-"), "key must never leak into probe detail");
ok("direct probeSearch against gateway succeeds (HTTP " + probeResult.statusCode + ")");

console.log();
console.log("ALL", passed, "SMOKE CHECKS PASSED");