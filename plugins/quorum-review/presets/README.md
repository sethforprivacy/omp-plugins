# Presets — swap seat models on command, without touching seat files

Each seat's `model:` in `plugins/quorum-review/agents/rev-*.md` is the calibrated default. To run a
seat on a different model for one session, one repo, or permanently, use OMP's own
per-agent override setting — the seat files, the installed copies and this repo stay untouched:

```yaml
task:
  agentModelOverrides:
    rev-quorum-glm: nanogpt/zai-org/glm-5.3:high     # provider/model[:thinking-level]
    rev-sec-kimi: "@slow"                            # or a modelRoles alias
```

Three ways to apply it, most to least temporary:

| Scope | How |
|---|---|
| One session | `omp --config <path-to>/presets/<file>.yml` (any config.yml-style overlay; repeatable). Plugin installs keep the presets under `~/.omp/plugins/cache/plugins/*quorum-review*/presets/` |
| One repo | put the block in `<repo>/.omp/config.yml` |
| Everywhere | put the block in `~/.omp/agent/config.yml`, or use the `/agents` hub in the TUI (persists the same setting) |

`panel.mjs` prints the **effective** model per seat (`… (override; seat file pins …)`) when the
override lives in persisted config. A `--config` overlay or a session-only `/agents` switch is
invisible to it — the delivered result's resolved model is the source of truth (see the
provenance check in each SKILL.md).

Rules of the road:

- `task.agentModelOverrides` wins over the seat file. Routing is fixed at spawn time; OMP's
  `task` tool has no per-call model parameter, so a swap is a config change, not a task argument.
- A model whose provider has no working credentials makes OMP **fall back to the parent session's
  model**. That seat is then not independent; the protocol treats a fallback result as a failed
  seat. Route-check a new model before relying on it.
- Thinking level rides on the selector: `provider/model:high`. Levels were calibrated per seat
  (`docs/thinking-levels.md`, `docs/benchmark.md`); an override resets that calibration for the
  run, so pin one explicitly when you swap.
- `task.disabledAgents: [rev-quorum-nemo]` parks a seat for the same scopes; `panel.mjs` honors it.

- `backstops.yml` sets `task.maxRuntimeMs` (a seat that never yields becomes a failed seat instead
  of an open-ended wait) and `task.showResolvedModelBadge` (see the resolved model on every spawn).

Files here are examples to copy or pass to `--config`. They are not installed anywhere.
