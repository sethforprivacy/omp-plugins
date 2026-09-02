# pilotfish

Two-tier orchestration skill for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP): a
**premium model orchestrates** — frames the task, plans, makes integration calls, and does the
**final review** — while **ALL volume work, research, and implementation runs on a second,
cheaper model tier**, typically your own local router.

A port of [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) (MIT) compressed
to two tiers and wired through OMP's own agent files and `task` protocol.

> Published as an OMP plugin: `omp plugin marketplace add sethforprivacy/omp-plugins`, then
> `omp plugin install pilotfish@omp-plugins`.

## Why this is the ideal mix of efficacy and cost savings for local AI

Most tokens in any coding session go to search, repetitive edits, test suites, and docs — not to
judgment. This skill prices that reality in:

- **Volume work runs on hardware you already own.** A local OpenAI-compatible router on a
  reasonable GPU (or even a shared one) serves flash-class work at near-zero marginal cost per token.
  The long-tail of a session — recon, mechanical edits, broad research — never touches a paid API.
- **Premium tokens are spent only where they change the outcome:** planning/architecture,
  integration judgment, and one fresh-context **final review** by a model that did *not* do the
  work. Instead of paying for millions of run-of-the-mill tokens, you pay for the handful of
  turns that actually decide correctness.
- **Independence is built in.** The model that produced the work never grades its own work: a
  fresh-context premium verifier (`CONFIRMED` / `REFUTED` / `INCONCLUSIVE`) gates every
  acceptance boundary.

For someone running local inference on consumer/mid-range hardware, this is the pattern that
gets frontier-quality *decisions* at local *throughput* — the best cost/efficacy mix available.

## Architecture

| Role | Tier | Job |
|---|---|---|
| Orchestrator (main session) | premium | framing, planning, approval, integration, **final review** |
| `pf-scout` | worker | read-only recon, facts with `file:line` |
| `pf-mech-executor` | worker | fully-specified, same-shape repetition |
| `pf-executor` | worker | bounded implementation with local judgment |
| `pf-verifier` | premium | fresh-context outcome verification → CONFIRMED / REFUTED / INCONCLUSIVE |

Roles are resolved **by agent name** (config overrides, then agent `model:` frontmatter), not in
skill logic — so the skill itself is router/model agnostic. Any OpenAI-compatible provider works (local vLLM, Ollama, OpenRouter,
and any other OpenAI-compatible gateway).

## Pick your two tiers (required)

The plugin ships **no models**. Each agent pins only a role alias — workers `"@pf-worker"`, the
verifier `"@pf-strong"` — and your OMP config says what those resolve to:

```yaml
modelRoles:
  pf-worker: <provider>/<cheap-fast-model>     # pf-scout, pf-mech-executor, pf-executor
  pf-strong: <provider>/<strong-model>:high    # pf-verifier
```

Guidance, not a recommendation of any vendor: put the worker tier on the cheapest model that
reliably follows a fully-specified brief (a local flash-class model is the sweet spot), the strong
tier on the best model you can afford for judgment, and launch the orchestrator with `--model`
set to that same strong tier or better. Until both roles are set, OMP resolves the agents onto
your session model — the tiering silently disappears — so set them before the first run.

## Install (plugin, recommended)

```bash
omp plugin marketplace add sethforprivacy/omp-plugins
omp plugin install pilotfish@omp-plugins
```

### Upgrading

`omp plugin upgrade` compares against a **cached copy of the marketplace catalog**, so refresh the
catalog first or it will report "up to date" and reinstall the old version:

```bash
omp plugin marketplace update omp-plugins
omp plugin upgrade pilotfish@omp-plugins
omp plugin list   # should show pilotfish@omp-plugins (<new version>)
```

If it still shows the old version, the cached catalog clone is stale beyond a fast-forward; drop and
re-add it:

```bash
omp plugin marketplace remove omp-plugins
omp plugin marketplace add sethforprivacy/omp-plugins
omp plugin install pilotfish@omp-plugins --force
```

Then make sure no hand-copied `~/.omp/agent/agents/pf-*.md` or `~/.omp/agent/skills/pilotfish`
remain — user-level files win over plugin files by name and would shadow the upgrade:

```bash
ls ~/.omp/agent/agents/pf-*.md ~/.omp/agent/skills/pilotfish 2>/dev/null && echo "manual copies present: move them aside"
```

Model routing survives upgrades because it lives in `~/.omp/agent/config.yml`, not in the plugin
(see [Customizing the model tiers](#customizing-the-model-tiers)).

## Install (manual copy)

```bash
# 1. Skill + scripts → global skill dir
cp -R plugins/pilotfish/skills/pilotfish ~/.omp/agent/skills/pilotfish
# 2. Role agents → global agent dir
cp plugins/pilotfish/agents/pf-*.md ~/.omp/agent/agents/
```

## Customizing the model tiers

Models are resolved **by agent name**, so you never edit installed files. OMP picks each `pf-*`
agent's model in this order (first match wins):

1. `task.agentModelOverrides.<agent>` in config — `~/.omp/agent/config.yml` (global), a project
   `<repo>/.omp/config.yml`, or a one-shot `omp --config <overlay>.yml`
2. the agent file's `model:` — shipped as the role alias only (`"@pf-worker"` / `"@pf-strong"`),
   which resolves through `modelRoles.pf-worker` / `modelRoles.pf-strong`
3. the session model (a silent loss of the tiering — always define the roles)

The orchestrator is always the `--model` you launch OMP with. Routing is fixed at launch (the
`task` tool has no per-call model parameter), so a swap is a relaunch, not a mid-session request.
Thinking level rides on the selector (`provider/model:high`); the agent files pin none.

### Template (one run or persistent)

`presets/tiers-template.yml` is the block above with placeholders:

```bash
omp --config <plugin-dir>/presets/tiers-template.yml --model <strong-model>   # after filling it in
```

`<plugin-dir>` is `~/.omp/plugins/cache/plugins/omp-plugins___pilotfish___<version>` for a plugin
install, or wherever you cloned this repo. For a persistent setup paste the same block into
`~/.omp/agent/config.yml` (or `<repo>/.omp/config.yml` to make one repository use different tiers).
Pin one agent off its tier with `task.agentModelOverrides.<agent>: <provider>/<model>`. Try a new
worker model for one run without touching anything else:

```bash
omp --config <(printf 'modelRoles:\n  pf-worker: <provider>/<model>\n') --model <strong-model>
```

### Shipped defaults

| Role | Agent | Shipped `model:` |
|---|---|---|
| Orchestrator | your `omp --model …` | (you choose; strong tier) |
| Recon / Mechanical / Judgment | `pf-scout`, `pf-mech-executor`, `pf-executor` | `"@pf-worker"` (→ `modelRoles.pf-worker`) |
| Verifier | `pf-verifier` | `"@pf-strong"` (→ `modelRoles.pf-strong`) |

Editing the four `agents/pf-*.md` files still works for a fork, but overrides are the supported
path — drifted installed copies are how a quick swap becomes an unreproducible setup.

### Provider registration (`~/.omp/agent/models.yml`)

OpenRouter is built into OMP — no entry needed, just a key. Local vLLM routers get a
`providers:` entry:

```yaml
providers:
  vllm:
    baseUrl: http://my-router.local:8000/v1   # your local OpenAI-compatible router
```

Keys: `openrouter` reads `OPENROUTER_API_KEY` from your environment or `~/.omp/agent/.env`:

```bash
echo "OPENROUTER_API_KEY=sk-or-…" >> ~/.omp/agent/.env
chmod 600 ~/.omp/agent/.env   # or create the file via editor/secrets manager
```

Any other OpenAI-compatible gateway (PREM, Venice, …) follows the same pattern: add a
`providers:` entry with `baseUrl` (+ `apiKey`/env name if it needs one), then address its
models as `<provider>/<model-id>` in overrides.

### Verifying your routes

```bash
omp models   # lists every provider + model OMP can currently serve
```

Every model you pin must be served by that provider for your account — if a role's model
doesn't appear, the route is wrong (bad provider name, missing key, or model not available to
that account).

## Usage

Start OMP on the premium tier, invoke the skill:

```bash
omp --model <strong-model>
# in the session:
#   "pilotfish: <task>"
#   or "orchestrate this with the worker tier doing the work and the strong tier reviewing"
```

The orchestrator runs the six-gate protocol (frame + roster → capped recon fan-out → plan/approval →
worker execution with budgets → fresh-context verification of a fingerprinted packet → final
review). Full protocol in `SKILL.md`.

Hardening built in: the packet script never embeds credential-like files (`.env*`, `*.pem`,
`*token*`, …) and stamps each packet with root, revision, and a diff fingerprint so a verifier can
refuse a moved tree and the orchestrator never re-verifies identical state; workers carry turn
budgets and an explicit output contract; concurrent scouts/verifiers are capped to what one local
router can serve.

Sample end-to-end run with real output: [`docs/sample-run.md`](plugins/pilotfish/skills/pilotfish/docs/sample-run.md).

## Publishing (maintainer)

This repo is both the marketplace catalog (`./.omp-plugin/marketplace.json`) and the plugin
(`./plugins/pilotfish/`). CI keeps it publishable:

- **Every push/PR** — `ci.yml` validates the catalog + plugin integrity, lints agent frontmatter
  and presets (`scripts/lint-pilotfish.mjs`), smoke-tests the packet script, and proves an untracked
  `.env` never reaches a packet.
- **Every `v*` tag** — `publish.yml` validates, archives `plugins/pilotfish/` as
  `pilotfish-<version>.zip`, and attaches it to a GitHub release (release notes auto-generated).

Bump versions in both `.omp-plugin/marketplace.json` and `plugins/pilotfish/package.json`
(the validator enforces they match), then tag. Users pull updates with `omp plugin upgrade`.

## Credit

Adapted from [pilotfish](https://github.com/Nanako0129/pilotfish) by Nanako0129 — MIT licensed.
Original: frontier model keeps planning/approval/integration/final judgment in the main session;
small fast role agents do the volume work; fresh-context verifiers gate acceptance. This port
compresses that topology to two tiers and implements it natively for the Oh My Pi agent.

## License

MIT — see [LICENSE](plugins/pilotfish/skills/pilotfish/LICENSE). Pilotfish's review gates and
severity/verifier vocabulary carry through from the upstream project.
