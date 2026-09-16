#!/usr/bin/env node
// tiers.mjs — Verify that pilotfish leaves ACTUALLY ran on their tier, from OMP's own transcripts.
//
// Why this exists: OMP resolves an agent's model as
//   task.agentModelOverrides.<agent>  →  agent file `model:` (here: the role alias `@pf-worker` /
//   `@pf-strong`)  →  the session model.
// Every step of that chain fails SILENTLY. When it did (OMP ≤ 18.2.0 ignored the `model:`
// frontmatter of agents shipped by marketplace-installed plugins — upstream can1357/oh-my-pi#12028
// — and an undefined/typo'd role, a disabled provider or a missing credential behaves the same
// way), every pf-* leaf inherited the orchestrator's own model: the worker tier ran on strong-tier
// tokens, which is the exact outcome the two-tier split exists to prevent. Nothing in the task
// result says so — only the subagent's own transcript does.
//
// So this script reads the transcripts and compares each leaf's recorded model against what the
// leaf's tier is CONFIGURED to be. The orchestrator runs it twice: once on the one-per-tier probe
// leaves before delegating (gate), and once over the run's leaves before the final review (audit).
// Scope: agents whose `model:` pin is a `pf-*` role — this plugin's tiers (other bundles' agents
// carry their own provenance checks).
//
// Usage:
//   tiers.mjs [--session-dir <dir>] [--since <min>] [--probe <task-name>]... [--expected <agent>=<sel>]...
//             [--orchestrator <sel>] [--no-omp] [--json]
//
// Options:
//   --session-dir <d>       The parent session's subagent dir
//                           (~/.omp/agent/sessions/<cwd-slug>/<session-id>/). Default: the newest
//                           session dir under ~/.omp/agent/sessions whose parent session ran in
//                           the current working directory, modified in the last --since minutes.
//   --since <minutes>       Freshness window for that default discovery (default 240).
//   --probe <task-name>     Restrict the check to this spawn's task name (the transcript basename,
//                           e.g. TierProbeWorker); repeatable. A named probe with no transcript is
//                           a failure — the gate must not pass by finding nothing.
//   --expected <a>=<sel>    Expected model for agent <a>, highest precedence. Use it for a
//                           `--config` overlay OMP's persisted settings cannot show, or in tests.
//   --orchestrator <sel>    The orchestrator's own model selector. Default: read from the parent
//                           session file next to the transcripts. Used to NAME the failure.
//   --no-omp                Do not read OMP settings; rows without --expected become "unverified".
//   --json                  Print the report as JSON on stdout instead of the table.
//
// Verdicts: ok (matches the tier's configured model), collapsed (resolved to the ORCHESTRATOR's
// model — the silent fall-through), mismatch (another model entirely), unconfigured (the tier has
// no modelRoles/override, so OMP would run the session model), unverified (nothing to compare).
// Exit 0 when every checked row is ok; 1 on any other verdict or a missing named probe; 2 on a
// usage error.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";

function fail(msg, code = 1) {
  console.error(`tiers: ${msg}`);
  process.exit(code);
}
function home() {
  return process.env.HOME || process.env.USERPROFILE;
}

function parseArgs(argv) {
  const args = { sessionDir: null, since: 240, probes: [], expected: {}, orchestrator: null, omp: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`, 2);
      return argv[++i];
    };
    if (a === "--session-dir") args.sessionDir = val();
    else if (a === "--probe") args.probes.push(val());
    else if (a === "--orchestrator") args.orchestrator = val();
    else if (a === "--expected") {
      const [agent, sel] = val().split("=");
      if (!agent || !sel) fail("--expected takes <agent>=<selector>", 2);
      args.expected[agent.trim()] = sel.trim();
    } else if (a === "--since") {
      const n = Number(val());
      if (!Number.isFinite(n) || n <= 0) fail("--since must be a positive number of minutes", 2);
      args.since = n;
    } else if (a === "--no-omp") args.omp = false;
    else if (a === "--json") args.json = true;
    else fail(`unknown arg ${a}`, 2);
  }
  return args;
}

// --- discovery -------------------------------------------------------------------------

function firstRecord(file, type) {
  for (const line of readFileSync(file, "utf8").split("\n").slice(0, 40)) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === type) return r;
  }
  return null;
}

// Candidate subagent dirs: every session dir touched inside the window, plus the cwd each parent
// session ran in. The orchestrator's own session is the one that ran in ITS cwd, so callers get the
// right session without knowing its id — but cwd matching is a preference, never a hard filter.
function sessionDirs(root, sinceMs) {
  const out = [];
  if (!existsSync(root)) return out;
  const cutoff = Date.now() - sinceMs;
  for (const slug of readdirSync(root)) {
    const slugDir = join(root, slug);
    let entries;
    try {
      if (!statSync(slugDir).isDirectory()) continue;
      entries = readdirSync(slugDir);
    } catch { continue; }
    for (const e of entries) {
      const d = join(slugDir, e);
      try {
        const st = statSync(d);
        if (!st.isDirectory()) continue;
        const parent = `${d}.jsonl`;
        // A live session's parent transcript is appended every turn while the subagent dir's mtime
        // only moves when a file is created, so freshness is the later of the two — otherwise a
        // session running for hours drops out of its own discovery window. Both stats are cheap;
        // only dirs that survive the window get their parent parsed.
        const hasParent = existsSync(parent);
        const mtimeMs = hasParent ? Math.max(st.mtimeMs, statSync(parent).mtimeMs) : st.mtimeMs;
        if (mtimeMs < cutoff) continue;
        out.push({ dir: d, parent, cwd: hasParent ? firstRecord(parent, "session")?.cwd ?? null : null, mtimeMs });
      } catch { /* vanished */ }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Agent files, in OMP's own precedence order: the user dir shadows plugin agents of the same name.
// Their `model:` is the tier alias (`@pf-worker` / `@pf-strong`), which this script expands through
// modelRoles exactly as OMP does with a frontmatter pin it honors.
function agentAliases() {
  const dirs = [join(home(), ".omp", "agent", "agents")];
  const cache = join(home(), ".omp", "plugins", "cache", "plugins");
  if (existsSync(cache)) {
    for (const p of readdirSync(cache).sort()) {
      const d = join(cache, p, "agents");
      try { if (statSync(d).isDirectory()) dirs.push(d); } catch { /* not a dir */ }
    }
  }
  const aliases = new Map();
  for (const dir of dirs) {
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files.sort()) {
      if (!f.endsWith(".md")) continue;
      const name = basename(f, ".md");
      if (aliases.has(name)) continue;
      const head = readFileSync(join(dir, f), "utf8").slice(0, 20000);
      const m = head.match(/^model:\s*"(@[A-Za-z0-9_-]+)"\s*$/m);
      if (m) aliases.set(name, m[1].slice(1));
    }
  }
  return aliases;
}

// --- settings --------------------------------------------------------------------------

function ompSetting(key) {
  try {
    const out = execFileSync("omp", ["config", "get", key, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : parsed;
  } catch {
    return undefined;
  }
}

// --- transcripts ---------------------------------------------------------------------------

function orchestratorOf(parentFile) {
  if (!parentFile || !existsSync(parentFile)) return null;
  let model = null;
  for (const line of readFileSync(parentFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "model_change" && r.model) model = r.model;
  }
  return model;
}

function parseChild(path) {
  const rec = { transcript: path, taskName: basename(path, ".jsonl"), agent: null, resolvedModel: null, level: null, fallback: null };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "session_init") rec.agent = r.agent ?? rec.agent;
    else if (r.type === "model_change" && r.model) {
      rec.resolvedModel = r.model;
      if (typeof r.resolvedModelIsFallback === "boolean") rec.fallback = r.resolvedModelIsFallback;
    } else if (r.type === "thinking_level_change" && r.thinkingLevel) rec.level = r.thinkingLevel;
  }
  return rec;
}

// `provider/model[:level]` → { id: "provider/model", level }. The level is client config and a
// model's ladder may legitimately clamp it, so model IDENTITY is what is compared.
function splitSelector(sel) {
  const s = typeof sel === "string" ? sel.trim() : "";
  if (!s) return { id: null, level: null };
  const m = s.match(/^([^:]*\/[^:]+):([a-z]+)$/);
  return m ? { id: m[1], level: m[2] } : { id: s, level: null };
}

// --- main ---------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const root = join(home(), ".omp", "agent", "sessions");
if (args.sessionDir && !existsSync(args.sessionDir)) fail(`session dir not found: ${args.sessionDir}`);

let candidates;
if (args.sessionDir) candidates = [{ dir: args.sessionDir, parent: `${args.sessionDir}.jsonl`, cwd: process.cwd(), mtimeMs: 0 }];
else {
  const all = sessionDirs(root, args.since * 60 * 1000);
  const here = all.filter((c) => c.cwd === process.cwd());
  candidates = here.length > 0 ? here : all;
  if (here.length === 0 && all.length > 0) console.error(`tiers: note — no session dir for ${process.cwd()} in the last ${args.since} min; scanning all ${all.length} recent session(s)`);
}

const aliases = agentAliases();
if (aliases.size === 0) fail("no agent files with a `model: \"@role\"` pin found under ~/.omp/agent/agents or ~/.omp/plugins/cache/plugins/*/agents — is the plugin installed?");

const overrides = args.omp ? ompSetting("task.agentModelOverrides") || {} : {};
const roles = args.omp ? ompSetting("modelRoles") || {} : {};

const rows = [];
const seen = new Map(); // task name → newest transcript wins; the rest are noted, never silently dropped
for (const cand of candidates) {
  let files;
  try { files = readdirSync(cand.dir); } catch { continue; }
  const orchestrator = args.orchestrator ?? orchestratorOf(cand.parent);
  for (const f of files.sort()) {
    if (!f.endsWith(".jsonl")) continue;
    const path = join(cand.dir, f);
    try { if (!statSync(path).isFile()) continue; } catch { continue; }
    const task = basename(f, ".jsonl");
    if (args.probes.length > 0 && !args.probes.includes(task)) continue;
    const rec = parseChild(path);
    if (!rec.agent || !aliases.has(rec.agent)) continue; // no agent file with a role pin
    const role = aliases.get(rec.agent);
    if (!role.startsWith("pf-")) continue; // another bundle's agent (quorum seats check their own panel)
    const expected = splitSelector(args.expected[rec.agent] ?? overrides[rec.agent] ?? roles[role] ?? null);
    const actual = splitSelector(rec.resolvedModel);
    const orch = splitSelector(orchestrator);

    let verdict;
    if (!expected.id) verdict = args.omp ? "unconfigured" : "unverified";
    else if (actual.id === expected.id) verdict = "ok";
    else if (orch.id && actual.id === orch.id) verdict = "collapsed";
    else verdict = "mismatch";

    const row = {
      task: rec.taskName, agent: rec.agent, tier: role, verdict,
      expected: expected.id, expectedLevel: expected.level,
      resolvedModel: actual.id, level: rec.level, selectedLevel: actual.level,
      fallback: rec.fallback, orchestrator: orch.id, transcript: path, dir: cand.dir,
    };
    const prior = seen.get(task);
    if (prior) { console.error(`tiers: note — ${task} has ${prior.dir === cand.dir ? "another" : "an older"} transcript in ${prior.dir}; using the newest`); }
    else seen.set(task, row);
  }
}
rows.push(...seen.values());

const found = new Set(rows.map((r) => r.task));
const missingProbes = args.probes.filter((p) => !found.has(p));
const bad = rows.filter((r) => r.verdict !== "ok");

if (args.json) {
  process.stdout.write(JSON.stringify({ rows, missingProbes, dirs: candidates.map((c) => c.dir) }, null, 2) + "\n");
} else {
  for (const r of rows) {
    const level = r.selectedLevel ? `:${r.selectedLevel}` : r.level ? ` (level ${r.level})` : "";
    process.stdout.write(
      `${r.task} — ${r.agent} [${r.tier}] — ${r.resolvedModel}${level} — ${r.verdict}` +
      (r.verdict === "ok" || !r.expected ? "" : ` (configured: ${r.expected}${r.expectedLevel ? `:${r.expectedLevel}` : ""})`) +
      (r.fallback === true ? " [resolvedModelIsFallback]" : "") + "\n",
    );
  }
}

for (const r of rows) {
  if (r.verdict === "collapsed") {
    console.error(`tiers: COLLAPSED — ${r.task} (${r.agent}) ran on the ORCHESTRATOR's model ${r.resolvedModel}; ${r.tier} is configured as ${r.expected}. The tiering silently did not happen.`);
  } else if (r.verdict === "mismatch") {
    console.error(`tiers: MISMATCH — ${r.task} (${r.agent}) ran on ${r.resolvedModel}; ${r.tier} is configured as ${r.expected}.`);
  } else if (r.verdict === "unconfigured") {
    console.error(`tiers: UNCONFIGURED — ${r.task} (${r.agent}) has no modelRoles.${r.tier} and no task.agentModelOverrides.${r.agent}, so OMP would run it on the session model. Set modelRoles.${r.tier} (see presets/tiers-template.yml).`);
  } else if (r.verdict === "unverified") {
    console.error(`tiers: UNVERIFIED — ${r.task} (${r.agent}) ran on ${r.resolvedModel}; settings were not read (--no-omp) and no --expected was given.`);
  }
}
for (const p of missingProbes) console.error(`tiers: NO TRANSCRIPT — probe ${p} produced none in ${candidates.map((c) => c.dir).join(", ")}; it did not run, so the tier is unverified.`);

const failures = bad.length + missingProbes.length;
if (!args.sessionDir && args.since > 1440) {
  console.error(`tiers: note — a ${args.since}-minute window spans likely config changes; expectations are TODAY's config, so a leaf spawned under an older tier mapping reads as mismatch. Prefer --session-dir or a tight --since.`);
}
const expectedSource = Object.keys(args.expected).length > 0
  ? `Expected models: --expected for ${Object.keys(args.expected).join(", ")}, otherwise persisted OMP settings (task.agentModelOverrides → modelRoles.<alias>)`
  : "Expected models come from persisted OMP settings (task.agentModelOverrides → modelRoles.<alias>)";
console.error(
  `tiers: ${rows.length} leaf transcript(s) checked, ${rows.length - bad.length} on tier` +
  (failures ? `; ${failures} problem(s)` : "") +
  `. ${expectedSource}; a --config overlay or a session-only /agents switch is not visible to the settings read — pass --expected for those, and treat the transcript as the truth either way.`,
);
// Set the code rather than calling process.exit(): a pipe write of the whole report is async, and
// an exit there truncates it (a --json payload piped to jq arrives cut mid-string).
process.exitCode = failures === 0 ? 0 : 1;