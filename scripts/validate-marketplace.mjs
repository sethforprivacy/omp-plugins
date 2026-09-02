#!/usr/bin/env node
// validate-marketplace.mjs — validate the OMP marketplace catalog and every plugin it lists.
// Generic: knows nothing about individual plugins beyond the OMP plugin layout. Plugin-specific
// checks live in scripts/lint-<plugin>.mjs.
//
//   node scripts/validate-marketplace.mjs   # exit 0 = valid, 1 = broken
//
// Checks:
//   1. .omp-plugin/marketplace.json parses and carries name, owner.name, metadata, plugins[].
//   2. Marketplace + plugin names obey OMP naming rules (lowercase/digits/-/., alphanumeric edges);
//      plugin names are unique; plugin dir name == plugin name.
//   3. Each plugin `source` is a './' path that resolves inside the repo and exists; every
//      plugins/<dir> on disk is listed in the catalog (no orphan plugins).
//   4. Each plugin has skills/<name>/SKILL.md with frontmatter `name:` == dir, and (if present)
//      agents/*.md with frontmatter `name:` == filename stem.
//   5. Every *.mjs under a plugin parses (node --check).
//   6. plugin.version === plugins/<name>/package.json version when that file exists.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, basename, relative } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
const fail = (msg) => { failed = true; console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok: ${msg}`);

const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
function checkName(kind, name) {
  if (typeof name !== "string" || !name || name.length > 64 || !NAME_RE.test(name)) {
    fail(`${kind} name ${JSON.stringify(name)} violates OMP naming rules (lowercase letters/digits/hyphens/dots, alphanumeric start+end, <=64 chars)`);
  }
}
function loadJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { fail(`cannot read/parse ${relative(repoRoot, path)}: ${e.message}`); return null; }
}
function frontmatterName(path) {
  const m = readFileSync(path, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const n = m && m[1].match(/^name:[ \t]*(.+)$/m);
  return n ? n[1].trim().replace(/^["']|["']$/g, "") : null;
}
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const catalog = loadJson(join(repoRoot, ".omp-plugin", "marketplace.json"));
const listed = new Set();
if (catalog) {
  checkName("marketplace", catalog.name);
  if (!catalog.owner?.name) fail("catalog missing owner.name");
  if (!catalog.metadata?.description) fail("catalog missing metadata.description");
  if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) fail("catalog missing plugins[]");

  for (const entry of catalog.plugins ?? []) {
    checkName("plugin", entry.name);
    if (listed.has(entry.name)) fail(`plugin ${entry.name} listed twice`);
    listed.add(entry.name);
    if (typeof entry.source !== "string" || !entry.source.startsWith("./")) {
      fail(`plugin ${entry.name}: source must be a relative './...' path (got ${JSON.stringify(entry.source)})`);
      continue;
    }
    const pluginDir = resolve(repoRoot, entry.source);
    if (pluginDir === repoRoot || !pluginDir.startsWith(repoRoot + "/") || !existsSync(pluginDir)) {
      fail(`plugin ${entry.name}: source ${entry.source} must resolve inside the repo root and exist`);
      continue;
    }
    if (basename(pluginDir) !== entry.name) fail(`plugin ${entry.name}: source dir is named ${basename(pluginDir)} — keep dir name == plugin name`);
    if (!entry.description) fail(`plugin ${entry.name}: description missing`);
    if (!entry.version) fail(`plugin ${entry.name}: version missing`);
    ok(`plugin ${entry.name} -> ${entry.source} (v${entry.version})`);

    const skillsDir = join(pluginDir, "skills");
    const skills = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory()) : [];
    if (skills.length === 0) fail(`plugin ${entry.name}: no skills/<name>/ directories`);
    for (const name of skills) {
      const md = join(skillsDir, name, "SKILL.md");
      if (!existsSync(md)) { fail(`plugin ${entry.name}: skills/${name} has no SKILL.md`); continue; }
      const fmName = frontmatterName(md);
      if (fmName !== name) fail(`plugin ${entry.name}: skills/${name}/SKILL.md frontmatter name is ${JSON.stringify(fmName)}`);
      else ok(`${entry.name}: skill ${name}`);
    }

    const agentsDir = join(pluginDir, "agents");
    if (existsSync(agentsDir)) {
      const agents = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
      for (const a of agents) {
        const fmName = frontmatterName(join(agentsDir, a));
        if (fmName !== basename(a, ".md")) fail(`plugin ${entry.name}: agents/${a} frontmatter name is ${JSON.stringify(fmName)}`);
      }
      ok(`${entry.name}: ${agents.length} agent file(s)`);
    }

    for (const p of walk(pluginDir).filter((f) => f.endsWith(".mjs"))) {
      try { execFileSync(process.execPath, ["--check", p], { stdio: "ignore" }); }
      catch { fail(`${relative(repoRoot, p)} does not parse (node --check)`); }
    }

    const pkgPath = join(pluginDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = loadJson(pkgPath);
      if (pkg?.version && pkg.version !== entry.version) fail(`plugin ${entry.name}: catalog version ${entry.version} != package.json version ${pkg.version}`);
    }
  }
}

const pluginsRoot = join(repoRoot, "plugins");
if (existsSync(pluginsRoot)) {
  for (const d of readdirSync(pluginsRoot)) {
    if (statSync(join(pluginsRoot, d)).isDirectory() && !listed.has(d)) fail(`plugins/${d} exists but is not listed in .omp-plugin/marketplace.json`);
  }
}

if (failed) { console.error("\nmarketplace validation FAILED"); process.exit(1); }
console.log("\nmarketplace validation OK");
