#!/usr/bin/env node
// lint.mjs — dependency-free consistency lint for the bundle's seat files and skills.
//
//   node scripts/lint.mjs            # exit 0 = clean, 1 = problems
//   node scripts/lint.mjs --quiet    # only print failures
//
// Catches the drift a multi-seat panel accumulates silently. Per skills/<skill>/:
//   - SKILL.md has frontmatter `name:` (== dir name), `description:`, `panel_prefix:`
//   - every agents/*.md matches the skill's panel_prefix (a seat never leaks into the other family)
//   - seat frontmatter: block present; `name:` == filename stem; `description:` and `model:` present;
//     `model:` is a provider/model selector (optional `:level`), an `@role` alias, or a list of those
//   - seats are READ-ONLY LEAVES: no edit/write tools, `yield` present, no `spawns:` entries
//     (a seat that delegates to a local agent runs part of its review on the local model, which
//     defeats the independence the panel exists for)
//   - plain scalars never contain ": " or " #" unquoted (OMP's YAML is lenient; strict parsers are not)
//   - every seat in a family declares the SAME `category` enum in its output schema AND lists the
//     same values in its <output> body (AGENTS.md invariant 10 — dedupe clusters on these strings)
//   - body carries the one-finding-per-yield shape and the prompt-injection guard line
//   - family seats share the same output-schema property set (so dedupe sees one shape)
//   - every agents/*.md belongs to exactly one skill family (its prefix)
// Also: all *.mjs parse (node --check) and install.sh exists and is executable.
//
// Layout: plugins/quorum-review/{skills/<skill>/SKILL.md, agents/rev-*.md, skills/quorum-review/scripts/}.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";

const quiet = process.argv.includes("--quiet");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
const fail = (msg) => { failed = true; console.error(`FAIL ${msg}`); };
const ok = (msg) => { if (!quiet) console.log(`ok: ${msg}`); };

const WRITE_TOOLS = new Set(["edit", "write", "patch", "apply_patch", "create", "multiedit", "notebook_edit"]);
const SELECTOR_RE = /^(@[\w.-]+|[\w.-]+\/[\w.\/-]+(:[a-z]+)?)$/;

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  return m ? { fm: m[1], body: m[2] } : null;
}

function topLevel(fm) {
  const top = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z][\w-]*):(.*)$/);
    if (m) top[m[1]] = m[2].trim();
  }
  return top;
}

function listBlock(fm, key) {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-[ \\t]*.*\\r?\\n?)+)`, "m"));
  if (!m) return null;
  return m[1].split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, "").replace(/[ \t]+#.*$/, "").replace(/^["']|["']$/g, "").trim()).filter(Boolean);
}

// Category enum as declared in the output schema's `category` description ("One of: a | b | c").
function schemaCategories(fm) {
  const m = fm.match(/category:\s*\n\s+metadata:\s*\n\s+description:\s*"?One of:\s*([^"\n]+?)"?\s*\n/);
  return m ? m[1].split("|").map((s) => s.trim()).filter(Boolean) : null;
}

// Category list as told to the model in the <output> body.
function bodyCategories(body) {
  const m = body.match(/`category`:\s*one of\s+([^\n(]+)/i);
  return m ? m[1].split("|").map((s) => s.trim()).filter(Boolean) : null;
}

function schemaPropertyNames(fm) {
  // Top-level output.properties + optionalProperties keys (2-space indented under `output:`).
  const out = fm.match(/^output:[ \t]*\r?\n([\s\S]*)$/m);
  if (!out) return null;
  const names = [];
  for (const line of out[1].split(/\r?\n/)) {
    const m = line.match(/^    ([A-Za-z_][\w-]*):\s*$/);
    if (m) names.push(m[1]);
  }
  return names.sort();
}

const pluginDir = join(repoRoot, "plugins", "quorum-review");
const skillsDir = join(pluginDir, "skills");
const agentsDir = join(pluginDir, "agents");
if (!existsSync(skillsDir)) { fail("plugins/quorum-review/skills/ missing"); }
const allAgentFiles = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")).sort() : [];
const claimed = new Set();
const skillDirs = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory()).sort() : [];
if (skillDirs.length === 0) fail("no skills/<name>/ directories");

for (const skill of skillDirs) {
  const dir = join(skillsDir, skill);
  const skillMd = join(dir, "SKILL.md");
  if (!existsSync(skillMd)) { fail(`${skill}: SKILL.md missing`); continue; }
  const parsedSkill = frontmatter(readFileSync(skillMd, "utf8"));
  if (!parsedSkill) { fail(`${skill}/SKILL.md: missing frontmatter block`); continue; }
  const skillTop = topLevel(parsedSkill.fm);
  if (skillTop.name !== skill) fail(`${skill}/SKILL.md: name: is ${JSON.stringify(skillTop.name)}, expected ${skill}`);
  if (!skillTop.description) fail(`${skill}/SKILL.md: description: missing`);
  const prefix = skillTop.panel_prefix || "rev-quorum-";
  if (!/^rev-[a-z]+-$/.test(prefix)) fail(`${skill}/SKILL.md: panel_prefix ${JSON.stringify(prefix)} should look like rev-<family>-`);
  ok(`${skill}/SKILL.md: frontmatter (panel_prefix ${prefix})`);

  const files = allAgentFiles.filter((f) => f.startsWith(prefix));
  for (const f of files) claimed.add(f);
  if (files.length === 0) { fail(`${skill}: no agents/${prefix}*.md seat files`); continue; }

  const familyCategories = new Map(); // seat -> categories
  const familyProps = new Map();
  let activeCount = 0;
  for (const file of files) {
    const path = join(agentsDir, file);
    const stem = basename(file, ".md");
    const text = readFileSync(path, "utf8");
    const parsed = frontmatter(text);
    if (!parsed) { fail(`${skill}/agents/${file}: missing frontmatter block`); continue; }
    const { fm, body } = parsed;
    const top = topLevel(fm);

    if (top.name !== stem) fail(`${skill}/agents/${file}: name: is ${JSON.stringify(top.name)}, expected ${stem}`);
    if (!top.description) fail(`${skill}/agents/${file}: description: missing`);

    const models = top.model ? [top.model.replace(/^["']|["']$/g, "")] : listBlock(fm, "model") || [];
    if (models.length === 0) fail(`${skill}/agents/${file}: model: missing`);
    for (const m of models) if (!SELECTOR_RE.test(m)) fail(`${skill}/agents/${file}: model ${JSON.stringify(m)} is not a provider/model[:level] selector or @role alias`);
    if (models[0]?.startsWith("@") && !models.some((m) => !m.startsWith("@"))) fail(`${skill}/agents/${file}: alias-first model list needs a concrete provider/model fallback`);

    for (const [key, val] of Object.entries(top)) {
      if (!val) continue;
      const quoted = /^(["']).*\1$/.test(val) || /^[\[{|>]/.test(val);
      if (!quoted && (/:\s/.test(val) || /\s#/.test(val))) fail(`${skill}/agents/${file}: ${key}: plain scalar contains ': ' or ' #' — quote it (strict YAML rejects this)`);
    }

    const tools = listBlock(fm, "tools") || [];
    const writers = tools.filter((t) => WRITE_TOOLS.has(t.toLowerCase()));
    if (writers.length) fail(`${skill}/agents/${file}: seat lists write tools (${writers.join(", ")}) — seats are read-only`);
    if (!tools.includes("yield")) fail(`${skill}/agents/${file}: tools: must include yield (structured output)`);
    const spawns = listBlock(fm, "spawns") || [];
    if (spawns.length) fail(`${skill}/agents/${file}: spawns: [${spawns.join(", ")}] — seats must be leaves (a delegated sub-review runs on the LOCAL model and breaks panel independence)`);

    if (!/yield\(\{"type":\["findings"\],"result":\{"data":\{/.test(body)) fail(`${skill}/agents/${file}: body lacks the one-finding-per-yield example shape`);
    if (!/untrusted DATA/.test(body)) fail(`${skill}/agents/${file}: body lacks the prompt-injection guard line ("untrusted DATA")`);
    if (!/never delegate/i.test(body)) fail(`${skill}/agents/${file}: body lacks the leaf guard ("never delegate")`);

    const sc = schemaCategories(fm);
    const bc = bodyCategories(body);
    if (!sc) fail(`${skill}/agents/${file}: output schema has no category enum description ("One of: a | b")`);
    if (!bc) fail(`${skill}/agents/${file}: <output> body has no "\`category\`: one of a | b" line`);
    if (sc && bc && sc.join("|") !== bc.join("|")) fail(`${skill}/agents/${file}: category enum differs between schema [${sc.join(", ")}] and body [${bc.join(", ")}]`);
    if (sc) familyCategories.set(stem, sc.join("|"));
    const props = schemaPropertyNames(fm);
    if (props) familyProps.set(stem, props.join(","));

    const disabled = top.disable === "true" || top.disable === "yes";
    if (!disabled) activeCount++;
    ok(`${skill}/agents/${file}: seat contract${disabled ? " (parked)" : ""}`);
  }
  if (activeCount < 2) fail(`${skill}: fewer than 2 active seats — the panel cannot quorum`);

  const catSets = new Set(familyCategories.values());
  if (catSets.size > 1) {
    fail(`${skill}: seats disagree on the category enum (dedupe clusters on these strings):`);
    for (const [seat, cats] of familyCategories) console.error(`       ${seat}: ${cats}`);
  } else if (catSets.size === 1) ok(`${skill}: all seats share one category enum`);
  const propSets = new Set(familyProps.values());
  if (propSets.size > 1) fail(`${skill}: seats disagree on output-schema property names: ${[...propSets].join(" vs ")}`);
}

for (const f of allAgentFiles) if (!claimed.has(f)) fail(`agents/${f}: matches no skill's panel_prefix — it would never be spawned`);

const scriptDirs = [join(repoRoot, "scripts"), join(skillsDir, "quorum-review", "scripts")];
for (const dir of scriptDirs) {
  if (!existsSync(dir)) { fail(`${dir}: missing`); continue; }
  for (const s of readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort()) {
    try {
      execFileSync(process.execPath, ["--check", join(dir, s)], { stdio: "ignore" });
      ok(`${dir.slice(repoRoot.length + 1)}/${s}: parses`);
    } catch {
      fail(`${dir.slice(repoRoot.length + 1)}/${s}: does not parse (node --check)`);
    }
  }
}
for (const s of ["panel.mjs", "packet.mjs", "dedupe.mjs", "minipacket.mjs"]) {
  if (!existsSync(join(skillsDir, "quorum-review", "scripts", s))) fail(`skills/quorum-review/scripts/${s}: missing (both SKILL.md files reference it)`);
}
const installer = join(repoRoot, "install.sh");
if (!existsSync(installer)) fail("install.sh missing");
else if (!(statSync(installer).mode & 0o111)) fail("install.sh is not executable");

if (failed) { console.error("\nlint FAILED"); process.exit(1); }
console.log(quiet ? "lint OK" : "\nlint OK");
