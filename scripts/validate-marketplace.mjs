#!/usr/bin/env node
// validate-marketplace.mjs — validate the OMP marketplace catalog + plugin integrity.
// Run in CI (and locally) before publishing a release or after any repo change.
//
//   node scripts/validate-marketplace.mjs   # exit 0 = valid, 1 = broken
//
// Checks:
//   1. .omp-plugin/marketplace.json parses and carries the catalog essentials.
//   2. Marketplace + plugin names obey the OMP naming rules (lowercase/digits/-/., alnum edges).
//   3. Each plugin `source` resolves inside the repo root (no path traversal) and exists.
//   4. skills/<name>/SKILL.md exists for every skills/ entry; agents/*.md are present; the
//      protocol scripts every SKILL.md references live in skills/quorum-review/scripts/.
//   5. Version alignment: catalog metadata.version === plugin.version === package.json version.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let failed = false;
const fail = (msg) => { failed = true; console.error(`FAIL ${msg}`); };
const ok = (msg) => console.log(`ok: ${msg}`);

const NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
function checkName(kind, name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 64 || !NAME_RE.test(name)) {
    fail(`${kind} name ${JSON.stringify(name)} violates OMP naming rules (lowercase letters/digits/hyphens/dots, alphanumeric start+end, <=64 chars)`);
  }
}
function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`cannot read/parse ${path}: ${e.message}`);
    return null;
  }
}

const REQUIRED_SCRIPTS = ["panel.mjs", "packet.mjs", "dedupe.mjs", "minipacket.mjs"];

const catalogPath = join(repoRoot, ".omp-plugin", "marketplace.json");
const catalog = loadJson(catalogPath);
if (catalog) {
  checkName("marketplace", catalog.name);
  if (!catalog.owner?.name) fail("catalog missing owner.name");
  if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) fail("catalog missing plugins[]");

  for (const entry of catalog.plugins ?? []) {
    checkName("plugin", entry.name);
    if (typeof entry.source !== "string" || !entry.source.startsWith("./")) {
      fail(`plugin ${entry.name}: source must be a relative './...' path (got ${JSON.stringify(entry.source)})`);
    }
    const pluginDir = resolve(repoRoot, entry.source);
    if (pluginDir === repoRoot || !pluginDir.startsWith(repoRoot + "/") || !existsSync(pluginDir)) {
      fail(`plugin ${entry.name}: source ${entry.source} must resolve inside the repo root and exist`);
      continue;
    }
    ok(`plugin ${entry.name} -> ${entry.source}`);

    const skillsDir = join(pluginDir, "skills");
    const skills = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
    if (skills.length === 0) fail(`plugin ${entry.name}: no skills/<name>/ directories`);
    for (const name of skills) {
      if (!existsSync(join(skillsDir, name, "SKILL.md"))) fail(`plugin ${entry.name}: skills/${name} has no SKILL.md`);
      else ok(`skills/${name}/SKILL.md present`);
    }

    // Shared protocol scripts live in ONE place (skills/quorum-review/scripts); every SKILL.md
    // points there, so a missing file breaks both skills.
    const scriptsDir = join(skillsDir, "quorum-review", "scripts");
    for (const s of REQUIRED_SCRIPTS) {
      if (existsSync(join(scriptsDir, s))) ok(`skills/quorum-review/scripts/${s} present`);
      else fail(`plugin ${entry.name}: skills/quorum-review/scripts/${s} is missing (referenced by the SKILL.md files)`);
    }

    const agentsDir = join(pluginDir, "agents");
    const agents = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")) : [];
    if (agents.length === 0) fail(`plugin ${entry.name}: no agents/*.md seat files`);
    else ok(`plugin ${entry.name} ships ${agents.length} seat files`);

    const pkgPath = join(pluginDir, "package.json");
    const pkg = existsSync(pkgPath) ? loadJson(pkgPath) : null;
    if (pkg?.version && entry.version && pkg.version !== entry.version) {
      fail(`plugin ${entry.name}: catalog plugin version (${entry.version}) != package.json version (${pkg.version})`);
    }
    if (catalog.metadata?.version && entry.version && catalog.metadata.version !== entry.version) {
      fail(`plugin ${entry.name}: catalog metadata.version (${catalog.metadata.version}) != plugin version (${entry.version})`);
    }
    if (pkg?.version) ok(`plugin ${entry.name} version ${pkg.version}`);
  }
}

if (failed) { console.error("\nmarketplace validation FAILED"); process.exit(1); }
console.log("\nmarketplace validation OK");
