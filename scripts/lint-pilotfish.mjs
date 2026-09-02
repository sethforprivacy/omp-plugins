#!/usr/bin/env node
// lint-agents.mjs — dependency-free lint for the pilotfish agent files and presets.
//
//   node scripts/lint-agents.mjs   # exit 0 = clean, 1 = problems
//
// Agent files (plugins/pilotfish/agents/pf-*.md):
//   - frontmatter block present; `name:` equals the filename; `description:` and `model:` present
//   - every top-level scalar value is either quoted or free of ": " and " #" (OMP's parser is
//     lenient, strict YAML parsers are not — a quoted description keeps both happy)
//   - read-only roles (pf-scout, pf-verifier) do not list edit/write tools
//   - body mentions the yield envelope so workers return an object, not a string
//   - no provider route (vllm/, openrouter/, ...) anywhere in an agent file
// Presets (plugins/pilotfish/presets/*.yml):
//   - modelRoles.pf-worker and modelRoles.pf-strong present; values are `provider/model[:level]`
//     selectors or `<placeholder>` tokens (presets ship as templates, never as someone's config)
//   - every key under task.agentModelOverrides (if present) names a shipped pf-* agent

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = join(repoRoot, "plugins", "pilotfish", "agents");
const presetsDir = join(repoRoot, "plugins", "pilotfish", "presets");
let failed = false;
const fail = (msg) => { failed = true; console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok: ${msg}`);

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : null;
}

const SEL_OR_PLACEHOLDER = /^(<[^>]+>(\/<[^>]+>)?(:<?[a-z]+>?)?|[\w.-]+\/[\w.\/-]+(:[a-z]+)?)$/;
const agentNames = new Set();
for (const file of readdirSync(agentsDir).filter((f) => /^pf-.*\.md$/.test(f)).sort()) {
  const path = join(agentsDir, file);
  const text = readFileSync(path, "utf8");
  const parsed = frontmatter(text);
  if (!parsed) { fail(`${file}: missing frontmatter block`); continue; }
  const { fm, body } = parsed;
  const expected = basename(file, ".md");
  agentNames.add(expected);

  const top = {};
  for (const line of fm.split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):(.*)$/); // top-level key (no indentation)
    if (!m) continue;
    top[m[1]] = m[2].trim();
  }
  if (top.name !== expected) fail(`${file}: name: is ${JSON.stringify(top.name)}, expected ${expected}`);
  if (!top.description) fail(`${file}: description: missing`);
  if (!("model" in top)) fail(`${file}: model: missing`);
  const modelList = fm.match(/^model:\n((?:\s+-\s+.*\n?)+)/m);
  const models = modelList ? modelList[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").replace(/\s+#.*$/, "").replace(/^"|"$/g, "").trim()).filter(Boolean) : (top.model ? [top.model.replace(/\s+#.*$/, "").replace(/^["']|["']$/g, "").trim()] : []);
  // Shipped agents are neutral: the ONLY allowed pin is the tier alias. Concrete models, providers
  // and thinking levels are client config (modelRoles / task.agentModelOverrides), never repo.
  const wantAlias = expected === "pf-verifier" ? "@pf-strong" : "@pf-worker";
  if (models.length !== 1 || models[0] !== wantAlias) fail(`${file}: model must be exactly "${wantAlias}" (got ${JSON.stringify(models)}) — concrete models are client config`);
  if ("thinking-level" in top) fail(`${file}: thinking-level: is client config — use a :level suffix on the modelRoles selector`);
  if (/\b(vllm|openrouter|nanogpt|mixroute|prem)\//.test(text)) fail(`${file}: mentions a specific provider route — keep agent files provider-neutral`);

  for (const [key, val] of Object.entries(top)) {
    if (!val) continue; // nested block follows
    const quoted = /^(["']).*\1$/.test(val) || /^[\[{|>]/.test(val);
    if (!quoted && (/:\s/.test(val) || /\s#/.test(val))) {
      fail(`${file}: ${key}: plain scalar contains ': ' or ' #' — quote it (strict YAML rejects this)`);
    }
  }

  const toolsBlock = fm.match(/^tools:\n((?:\s+-\s+.*\n?)+)/m);
  const tools = toolsBlock ? toolsBlock[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean) : [];
  if ((expected === "pf-scout" || expected === "pf-verifier") && tools.some((t) => t === "edit" || t === "write")) {
    fail(`${file}: read-only role lists a write tool (${tools.join(", ")})`);
  }
  if (!/yield/.test(body)) fail(`${file}: body never mentions the yield envelope`);
  if (!/\{"result": \{"data":/.test(body)) fail(`${file}: body should show the exact yield shape {"result": {"data": ...}}`);
  ok(`${file}: frontmatter + role contract`);
}
if (agentNames.size === 0) fail("no pf-*.md agent files found");

if (existsSync(presetsDir)) {
  for (const file of readdirSync(presetsDir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const text = readFileSync(join(presetsDir, file), "utf8");
    const roles = text.match(/^modelRoles:\n((?:\s+[\w-]+:\s*\S+.*\n?)+)/m);
    if (!roles) fail(`presets/${file}: no modelRoles block (pf-worker / pf-strong)`);
    else {
      for (const r of ["pf-worker", "pf-strong"]) {
        const m = roles[1].match(new RegExp(`^\\s+${r}:\\s*(\\S+)`, "m"));
        if (!m) fail(`presets/${file}: modelRoles.${r} missing`);
        else if (!SEL_OR_PLACEHOLDER.test(m[1])) fail(`presets/${file}: modelRoles.${r}: ${m[1]} is not a provider/model selector or <placeholder>`);
        else if (/^[\w.-]+\/[\w.\/-]+(:[a-z]+)?$/.test(m[1])) fail(`presets/${file}: modelRoles.${r} pins a concrete model (${m[1]}) — presets are templates; use <provider>/<model> placeholders`);
      }
    }
    const block = text.match(/^task:\n\s+agentModelOverrides:\n((?:\s+[\w-]+:\s*\S+.*\n?)+)/m);
    if (!block) { ok(`presets/${file}: modelRoles only`); continue; }
    const entries = block[1].split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
    for (const e of entries) {
      const m = e.match(/^([\w-]+):\s*(\S+)/);
      if (!m) { fail(`presets/${file}: unparseable line ${JSON.stringify(e)}`); continue; }
      const [, agent, model] = m;
      if (!agentNames.has(agent)) fail(`presets/${file}: ${agent} is not a shipped agent (${[...agentNames].join(", ")})`);
      if (!SEL_OR_PLACEHOLDER.test(model)) fail(`presets/${file}: ${agent}: ${model} is not a provider/model selector or <placeholder>`);
    }
    ok(`presets/${file}: modelRoles + ${entries.length} per-agent overrides`);
  }
}

if (failed) { console.error("\nagent lint FAILED"); process.exit(1); }
console.log("\nagent lint OK");
