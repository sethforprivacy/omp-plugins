# Presets — your panel is client config, not repo content

The seat files shipped in `agents/` are **neutral slots**. Each pins `model: "@<seat-name>"` (a
role alias) and nothing else — no provider, no model, no thinking level. Which model a seat runs
is decided entirely in your OMP config, so the repo never carries anyone's router, credentials,
or pins:

```yaml
task:
  agentModelOverrides:                     # per seat: provider/model[:thinking-level]
    rev-quorum-a: <provider>/<model>:medium
    rev-quorum-b: <provider>/<model>:medium
    rev-quorum-c: <provider>/<model>:medium
    rev-quorum-d: <provider>/<model>:minimal
    rev-sec-a: <provider>/<model>:max
    rev-sec-b: <provider>/<model>:xhigh
    rev-sec-c: <provider>/<model>:medium
```

`modelRoles.<seat-name>` is the alternative (that is what the `@<seat-name>` alias resolves to);
`task.agentModelOverrides` wins when both are set. A seat with neither is **unconfigured**:
`panel.mjs` lists it as inactive with the exact key to set, because OMP would otherwise run it on
your session's own model, which is not an independent vote.

Where to put the block:

| Scope | How |
|---|---|
| One session | `omp --config <your-overlay>.yml` (any config.yml-style overlay; repeatable) |
| One repo | `<repo>/.omp/config.yml` |
| Everywhere | `~/.omp/agent/config.yml`, or the `/agents` hub in the TUI (persists the same setting) |

Rules of the road:

- **Pick different vendors for different seats.** Corroboration only means something when the
  seats are independent; two seats on the same model family share blind spots.
- **Pin the thinking level on the selector** (`provider/model:high`). Levels are not in the seat
  files; measure them for your models with the harness in `docs/benchmark.md`.
- **Route-check a model before trusting it** (spawn the seat with "reply exactly OK"). A model
  whose provider has no working credentials makes OMP fall back to the parent session's model
  (`resolvedModelIsFallback`); the protocol treats that as a failed seat.
- **Custom providers** (any OpenAI-compatible gateway or a local router) go in
  `~/.omp/agent/models.yml`; its `apiKey:` may name an environment variable, so the key lives in
  `~/.omp/agent/.env` (`chmod 600`), never in a repo.
- `task.disabledAgents: [rev-quorum-d]` parks a seat for the same scopes; `panel.mjs` honors it.
- Fewer than two configured seats cannot quorum; the skills stop and say so.

Files here:

- `override-template.yml` — the block above with placeholders, ready to copy or pass to `--config`.
- `backstops.yml` — `task.maxRuntimeMs` (a seat that never yields becomes a failed seat instead of
  an open-ended wait) and `task.showResolvedModelBadge` (see which model each spawn ran on).

Nothing here is installed anywhere; these are examples.
