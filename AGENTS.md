# Agent context — omp-plugins

This repo is an OMP plugin **marketplace**: `.omp-plugin/marketplace.json` lists the plugins under
`plugins/<name>/`. Read the plugin's own `AGENTS.md` / `README.md` before operating on it:

- `plugins/quorum-review/AGENTS.md` — panel-review skills (`quorum-review`, `security-quorum`);
  invariants about seats, packets, dedupe, provenance.
- `plugins/pilotfish/README.md` — two-tier orchestration skill.

Repo-wide rules:

1. Plugin dir name == catalog `name` == `package.json` name; catalog version == `package.json`
   version. Bump a version whenever a plugin's shipped files change.
2. No personal configuration in the repo: no provider routes, model ids, keys, or thinking levels
   in agent files, presets, or docs presented as defaults. Placeholders + "set this in OMP config".
3. Runtime scripts live inside the skill that owns them; `scripts/` at the repo root is tooling only.
4. `node scripts/validate-marketplace.mjs` and every `scripts/lint-*.mjs` must pass before a commit.
5. Never run a plugin's manual installer on a machine that has the plugin installed — hand-copied
   files shadow plugin files by name.
