# omp-plugins

An [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) **plugin marketplace**: one repo, one
catalog, several independently versioned plugins. Install only the plugins you want.

```bash
omp plugin marketplace add sethforprivacy/omp-plugins
omp plugin install quorum-review@omp-plugins     # multi-model panel review
omp plugin install pilotfish@omp-plugins         # two-tier orchestration
```

Upgrade (the catalog is cached; refresh it first or `upgrade` reports "up to date"):

```bash
omp plugin marketplace update omp-plugins && omp plugin upgrade quorum-review@omp-plugins
```

## Plugins

| Plugin | Skills | What it does |
|---|---|---|
| [`quorum-review`](plugins/quorum-review/) | `quorum-review`, `security-quorum` | Spawns a panel of independent remote reviewer seats in parallel, dedupes findings by consensus, checks provenance, optional refutation pass. Seats are neutral slots; **you assign models in OMP config**. |
| [`pilotfish`](plugins/pilotfish/) | `pilotfish` | A strong model plans, integrates and does the final review; all volume work runs on a cheaper worker tier; a fresh-context verifier gates acceptance. Port of Nanako0129/pilotfish (MIT). |

Each plugin directory has its own README (usage, configuration), and where applicable an
`AGENTS.md` (invariants for agents operating on it), `presets/` (OMP config overlays), `docs/`.

## Layout and conventions

```
.omp-plugin/marketplace.json   ← the catalog OMP reads; one entry per plugin, versioned per plugin
plugins/<name>/                ← one OMP plugin: package.json (version), skills/<skill>/SKILL.md,
                                 agents/*.md, optional presets/, docs/, README.md, AGENTS.md
scripts/validate-marketplace.mjs ← generic catalog + plugin-layout checks (every plugin)
scripts/lint-<name>.mjs        ← plugin-specific consistency lint (seat contracts, presets, ...)
.github/workflows/ci.yml       ← validate + lints + per-plugin smoke tests (SHA-pinned actions)
.github/workflows/publish.yml  ← tag `<plugin>-v<version>` → GitHub release with that plugin zipped
```

Rules that keep the marketplace lean:

- **Plugin dir name == catalog `name` == `package.json` name.** Versions in the catalog entry and
  `package.json` must match (the validator enforces it). Bump per plugin, not repo-wide.
- **No personal configuration in the repo.** Provider routes, model ids, API keys and thinking
  levels belong in each user's OMP config (`~/.omp/agent/config.yml`, `models.yml`, `.env`).
  Plugins ship neutral defaults or documented placeholders and tell the user what to set.
- **Shared scripts live once**, inside the skill dir that owns them; sibling skills reference that
  path. Repo-root `scripts/` is repo tooling only (validation, lint), never runtime.
- **Every plugin gets a lint and a smoke test in CI** before it is listed.

## Adding a plugin

1. `mkdir plugins/<name>` with `package.json` (`name`, `version`), `skills/<skill>/SKILL.md`
   (frontmatter `name:` == dir), `agents/*.md` (frontmatter `name:` == filename), `README.md`.
2. Add its entry to `.omp-plugin/marketplace.json` (`source: "./plugins/<name>"`, same version).
3. Add `scripts/lint-<name>.mjs` if it has contracts worth enforcing, and a smoke step in
   `.github/workflows/ci.yml`.
4. `node scripts/validate-marketplace.mjs` must pass.

## Development

```bash
node scripts/validate-marketplace.mjs
node scripts/lint-quorum-review.mjs
node scripts/lint-pilotfish.mjs
```

Manual (non-plugin) installs: `plugins/quorum-review/install.sh`, and the copy commands in
`plugins/pilotfish/README.md`. Hand-copied files shadow plugin files by name; pick one path.

## History

`quorum-review` and `pilotfish` started as separate repos (`sethforprivacy/quorum-review`,
`sethforprivacy/omp-pilotfish`); both histories are merged here.
