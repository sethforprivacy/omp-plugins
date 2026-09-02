#!/usr/bin/env node
// panel.mjs — List the ACTIVE panel seats for a seat family (default `rev-quorum-*`) from
// ~/.omp/agent/agents/, with the model each seat will EFFECTIVELY run.
//
// The seat files shipped with this bundle are neutral slots: each pins `model: "@<seat-name>"`,
// a role alias, and nothing else. Which model (and thinking level) a seat runs is CLIENT config:
//   task.agentModelOverrides.<seat>: provider/model[:level]     (wins)
//   modelRoles.<seat>:               provider/model[:level]     (what the alias resolves to)
// A seat with neither is UNCONFIGURED. OMP would silently run it on the parent session's model,
// which is not an independent vote, so this script lists it as inactive with the fix instead.
//
// Usage:
//   panel.mjs [--json] [--prefix <seat-prefix>] [--agents-dir <path>] [--no-omp]
//
// Output (markdown), one seat per line:
//   rev-quorum-a — someprovider/some-model:medium (task.agentModelOverrides)
//
// A seat is ACTIVE when its file matches <prefix>*.md, is not `disable: true`, is not listed in
// OMP's `task.disabledAgents`, and resolves to a concrete model. Settings are read from the
// persisted OMP config via `omp config get ... --json`; pass `--no-omp` to skip (then only seat
// files with a concrete `model:` can be active). Session-only switches (a `--config` overlay, or
// the `/agents` hub used without persisting) are NOT visible here — always confirm the resolved
// model on each delivered result.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

function home() {
  return process.env.HOME || process.env.USERPROFILE;
}

function parseArgs(argv) {
  const args = { json: false, prefix: "rev-quorum-", dir: join(home(), ".omp", "agent", "agents"), omp: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--agents-dir") args.dir = argv[++i];
    else if (a === "--prefix") args.prefix = argv[++i];
    else if (a === "--no-omp") args.omp = false;
    else {
      console.error(`panel: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function frontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return m ? m[1] : "";
}

function frontmatterField(fm, field) {
  const m = fm.match(new RegExp(`^${field}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

// `model:` may be a scalar or an alias-first list (`- "@role"` / `- provider/model`).
function frontmatterModel(fm) {
  const scalar = frontmatterField(fm, "model");
  if (scalar) return scalar;
  const list = fm.match(/^model:[ \t]*\r?\n((?:[ \t]+-[ \t]*.*\r?\n?)+)/m);
  if (!list) return null;
  const items = list[1]
    .split(/\r?\n/)
    .map((l) => l.replace(/^[ \t]*-[ \t]*/, "").replace(/[ \t]+#.*$/, "").replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
  return items.length ? items.join(" → ") : null;
}

function isDisabled(fm) {
  const d = frontmatterField(fm, "disable");
  return d === "true" || d === "yes";
}

// Read one OMP setting via the CLI. Returns { value } or { error }.
function ompSetting(key) {
  try {
    const out = execFileSync("omp", ["config", "get", key, "--json"], {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out);
    return { value: parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : parsed };
  } catch (e) {
    return { error: e.code === "ENOENT" ? "omp not on PATH" : `omp config get ${key} failed` };
  }
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.dir)) {
  console.error(`panel: agents dir not found: ${args.dir}`);
  process.exit(1);
}

let overrides = {};
let roles = {};
let disabledAgents = [];
const notes = [];
if (args.omp) {
  const o = ompSetting("task.agentModelOverrides");
  if (o.error) notes.push(`${o.error} — client model assignments unknown`);
  else if (o.value && typeof o.value === "object") overrides = o.value;
  const r = ompSetting("modelRoles");
  if (!r.error && r.value && typeof r.value === "object") roles = r.value;
  const d = ompSetting("task.disabledAgents");
  if (!d.error && Array.isArray(d.value)) disabledAgents = d.value.map(String);
} else {
  notes.push("--no-omp: client model assignments unknown; only seats with a concrete model: in the file can be active");
}
const asSelector = (v) => (Array.isArray(v) ? v.join(" → ") : v ? String(v) : null);

const seats = [];
const skipped = [];
for (const f of readdirSync(args.dir).sort()) {
  if (!f.startsWith(args.prefix) || !f.endsWith(".md")) continue;
  const fm = frontmatter(readFileSync(join(args.dir, f), "utf8"));
  const name = frontmatterField(fm, "name") || f.replace(/\.md$/, "");
  if (isDisabled(fm)) { skipped.push({ name, why: "disable: true in seat file" }); continue; }
  if (disabledAgents.includes(name)) { skipped.push({ name, why: "listed in OMP task.disabledAgents" }); continue; }
  const pinned = frontmatterModel(fm) || "(no model)";
  const override = asSelector(overrides[name]);
  // Resolve an alias-only pin through modelRoles; a concrete provider/model pin stands as is.
  let model = null, source = null;
  if (override) { model = override; source = "task.agentModelOverrides"; }
  else if (pinned.startsWith("@")) {
    const role = asSelector(roles[pinned.slice(1)]);
    if (role) { model = role; source = `modelRoles.${pinned.slice(1)}`; }
  } else if (pinned !== "(no model)") { model = pinned; source = "seat file"; }
  if (!model) {
    skipped.push({ name, why: `UNCONFIGURED — set task.agentModelOverrides.${name} (or modelRoles.${pinned.slice(1) || name}) to provider/model[:level] in your OMP config` });
    continue;
  }
  seats.push({ name, model, source, pinnedModel: pinned, file: f });
}

if (seats.length === 0) {
  console.error(`panel: no active ${args.prefix}* seats found in ${args.dir}`);
  for (const s of skipped) console.error(`panel:   ${s.name} — skipped (${s.why})`);
  process.exit(1);
}

if (args.json) {
  process.stdout.write(JSON.stringify({ seats, skipped, notes }, null, 2) + "\n");
} else {
  for (const s of seats) process.stdout.write(`${s.name} — ${s.model} (${s.source})\n`);
}
for (const s of skipped) console.error(`panel: ${s.name} — inactive (${s.why})`);
for (const n of notes) console.error(`panel: note — ${n}`);
console.error(
  `panel: ${seats.length} active seat(s). Models come from persisted OMP settings; a --config overlay or a session-only /agents switch is not visible here — confirm the resolved model on every delivered result.`
);
