---
name: pilotfish
description: OMP port of Nanako0129/pilotfish (MIT) — two-tier orchestration. The main session is the orchestrator (a strong model) and owns planning, decisions, integration, and the FINAL review; ALL work, research, and implementation is delegated to a second, cheaper worker tier, typically your local router. A fresh-context strong-tier verifier gates acceptance. Load whenever the user says "pilotfish", "orchestrate this", "two-model", "run the work on the local router, X reviews", "delegate the work, review with the strong model", or wants frontier judgment over locally-executed work.
---

# Pilotfish — two-tier orchestration (OMP port)

> Port of [Nanako0129/pilotfish](https://github.com/Nanako0129/pilotfish) (MIT) to the Oh My Pi
> coding agent. Original: frontier model keeps planning/approval/integration/final judgment in the
> main session; small fast role agents do the volume work; fresh-context verifiers gate acceptance.
> This port compresses that to **two tiers** — one orchestrator, one worker pool — and wires the
> tiers through OMP's own agent files and `task` protocol.

**The idea in one line:** most coding-session tokens are spent on search, repetitive edits, tests,
and docs — not judgment. Route those to a model that is nearly free to run locally, and spend your
strong-model tokens only where they change the outcome: planning, integration, and the final review.

## Model contract — roles are pinned by agent name, never in this skill

This skill never names a concrete model in its logic. Every tier is an **OMP agent file** shipped
with the plugin, and OMP resolves each agent's model in this order (first match wins):

1. `task.agentModelOverrides.<agent-name>` in config (`~/.omp/agent/config.yml`, a project
   `<repo>/.omp/config.yml`, or a one-shot `omp --config <overlay>.yml`)
2. the agent file's own `model:` — shipped as the role alias only: workers `"@pf-worker"`,
   verifier `"@pf-strong"`, resolved through `modelRoles.pf-worker` / `modelRoles.pf-strong` in
   config. No concrete model or thinking level ships in the plugin.
3. the session model — a silent loss of the tiering. If `modelRoles.pf-worker` or
   `modelRoles.pf-strong` is undefined, tell the user which key to set (see `presets/
   tiers-template.yml`) before delegating anything. An undefined role is not the only way to land
   here: a harness that drops the agent file's `model:` (OMP ≤ 18.2.0 for marketplace-installed
   plugins — can1357/oh-my-pi#12028), a disabled provider, or missing credentials land in the same
   place. Nothing in a task result reveals it, which is why step 0 exists.

| Role | Agent | Tier | Job |
|------|-------|------|-----|
| Orchestrator | *(main session — the `--model` you launch with)* | strong | framing, planning, approval, integration, **final review** |
| Recon | `pf-scout` | worker | read-only search/recon, facts with `file:line` |
| Mechanical executor | `pf-mech-executor` | worker | fully-specified, same-shape repetition |
| Judgment executor | `pf-executor` | worker | bounded implementation with local judgment |
| Verifier | `pf-verifier` | strong | fresh-context outcome verification → CONFIRMED / REFUTED / INCONCLUSIVE |

Swapping models is a config change, not a file edit: `presets/tiers-template.yml` next to this
plugin is the overlay template (`omp --config <filled-in copy> --model <orchestrator>`) — two
`modelRoles` keys move a whole tier, per-agent `task.agentModelOverrides` pin one seat. Model routing is fixed at launch — the `task`
tool has no per-call model parameter. If the user asks for a different worker model mid-session,
do not improvise: give them the one-line override (`modelRoles.pf-worker: <model>` for the tier, or
`task.agentModelOverrides.pf-executor: <model>` for one seat) and continue with the current routing, or stop so they can relaunch.

**Rules that are NOT optional:**
- The orchestrator (main session) must run on the strong tier. At step 1 you state your own model
  and the resolved worker/verifier models — verified by the step-0 preflight, not read off config.
  If your own model is the worker model, you are not pilotfishing — say so and stop; if a probe
  came back `collapsed`, stop and report instead of delegating.
- Workers do ALL volume work. Workers never spawn sub-agents (leaf roles) and never run on the strong
  tier.
- The verifier is a **strong-tier, fresh-context** gate — it exists because the model that did the
  work must not grade its own work. Verdicts are evidence for your final review, not authority.
- Applying this skill to a task does not remove general harness duties (tests, docs, cleanup) from
  the orchestrator's final sweep — it moves *production* of those to the worker tier.
- Never edit installed agent files to change models. Use overrides (above). Installed copies that
  drift from the plugin are how a "quick swap" turns into an unreproducible setup.

## When to use

- User asks for it: "pilotfish", "orchestrate this", "delegate to the local router".
- Task is priced by token volume: multi-file refactors, broad research, docs generation, test
  suites, mechanical migration — anything where most of the work is volume, not judgment.
- A boundary exists where an independent final review is worth a strong-model round-trip.

**Stay direct (dispatch brake).** Keep it in the main session when the work is a single-file read,
a coupled investigation where each finding changes the next question, root-cause diagnosis that is
still evolving, plan synthesis, integration judgment, or anything the user reserved for you. Do NOT
use pilotfish for small bounded tasks you can finish in one pass (splitting has a coordination
cost), or genuinely novel architecture where the strong model should just do the work.

## Protocol

Run these steps in order. The packet script is deterministic context capture; you orchestrate.

### 0. Tier preflight — one trivial probe per tier, before any real dispatch

Model routing fails **silently**: OMP resolves `task.agentModelOverrides.<agent>` → the agent file's
`model:` alias → the session model, and any link in that chain can drop without an error. It has:
OMP ≤ 18.2.0 ignored the `model:` frontmatter of agents shipped by marketplace-installed plugins
(upstream can1357/oh-my-pi#12028), so every `pf-*` leaf inherited the ORCHESTRATOR's model — the
worker tier ran on strong-tier tokens and nothing in any task result said so. An undefined role, a
disabled provider, missing credentials, and a hand-edited agent file all fail the same way.

So prove the tiers before you delegate. ONE `task` call, two trivial leaves:

- `TierProbeWorker` — `agent: "pf-scout"`, task = "Reply with exactly: worker probe ok"
- `TierProbeStrong` — `agent: "pf-verifier"`, task = "Reply with exactly: strong probe ok"

They must use the real role agents (that is the resolution path under test), and their names must
stay unique in this run. Then check what actually ran — the transcript is the only place the
resolved model is recorded:

```
node <skill-dir>/scripts/tiers.mjs --probe TierProbeWorker --probe TierProbeStrong --since 30
```

`ok` on both lines and exit 0 = the tiering is real; keep the output as the roster's source.
Anything else — `collapsed`, `mismatch`, `unconfigured`, `unverified`, `no transcript` — is a STOP:
report the verdict to the user with the fix and do not start volume work until it is green. Common
causes, in order: OMP older than 18.2.1 (upgrade; `omp plugin list` shows what is installed), no
`modelRoles.pf-worker` / `modelRoles.pf-strong`, or `pf-worker` pointed at your own model. Pinning
the seats (`task.agentModelOverrides.pf-scout`, `.pf-executor`, `.pf-mech-executor`,
`.pf-verifier` in `~/.omp/agent/config.yml`) works on every version, because the override path is
not the one that breaks. Running collapsed is worse than not pilotfishing: it silently bills your
strong model for volume work, which is the single thing this skill exists to prevent.

### 1. Frame + roster (orchestrator, strong)
Write one to three sentences: what is being done, what "done" means, and the constraints. Then one
roster line: `orchestrator=<your model> workers=<model> verifier=<model>`. Your own model you know;
for the others cite the step-0 preflight — the model `tiers.mjs` observed each tier's probe running
on. A model you only read out of config is `unverified` until a probe confirms it, because an
override or overlay you cannot see may be active, and a configuration that never took effect is
exactly what the preflight exists to catch. If the outcome or acceptance is unclear, ask a
direction-changing question first (interaction shape `co_discover`); otherwise `explore_then_plan`
for broad/high-impact work, `execute` for bounded work. Long runs: keep a ledger — one line per
slice (`slice N: <what> → <worker> → <verdict>`) appended to a file next to your packets — so a
resumed or compacted session can see what is already done instead of redoing it.

### 2. Dispatch recon — ONE parallel batch, capped
For genuinely independent evidence surfaces (multiple subsystems, large unknown codebase), spawn
`pf-scout` for each disjoint surface in a single `task` call — one entry per scout, each with
`agent: "pf-scout"` — so they run concurrently. Each scout gets the exact question + scope, never a pre-decided conclusion.

- **Cap concurrent workers at the router's capacity — 3 or 4 on a single local endpoint.** Eight
  parallel scouts on one GPU pair are slower than two batches of four and risk the session ending
  before they yield. Batch the rest.
- Block fan-out when: scopes overlap, the synthesis owner is missing, or integration cost exceeds
  the benefit. Bounded task-local search belongs to the orchestrator; do not split work you would
  have to reassemble anyway.
- Collect ALL results before cross-surface comparison. Scouts report facts; the orchestrator
  reconciles and writes the plan.

### 3. Plan + approval gate (orchestrator, strong)
Synthesize ONE plan from scout results. For large/architectural/risky cross-surface work, present
the plan and WAIT for explicit user approval before any source edit. Broad initial request is not
approval of an unseen plan.

### 4. Execute (workers)
Choose the worker by shape:
- `pf-mech-executor` — fully specified repetition: one complete one-shot brief, exclusive
  ownership, independent items, per-item acceptance.
- `pf-executor` — bounded judgment under an approved contract: `goal + constraints + done-criteria`.
- Parallel writers: only with `isolated` (worktree) tasks and disjoint ownership; otherwise one
  shared-checkout worker at a time. Read-only roles may share the checkout. If you must run
  disjoint-ownership writers in one shared tree, no worker runs the suite while another writes —
  you integrate and run it afterwards.

Brief hygiene (every dispatch, including scouts and the verifier):
- **Every `tasks[]` entry sets `agent:` to the pf role** — `agent: "pf-scout"`, `"pf-executor"`,
  `"pf-mech-executor"`, or `"pf-verifier"`. An entry without `agent:` runs on the generic `task`
  agent on YOUR model, which silently defeats the tiering — and the harness will not tell you
  (a single-spawn result only echoes the name). Re-read the call before you send it. If a worker's
  report shows it ran on your model, decide which cause it is: no `agent:` is your omission (respawn
  with it set); `agent:` set and still on your model means the harness dropped the role pin — the
  step-0 preflight is what rules that out, so treat it as a stop-and-report, not a one-off to shrug at.
- The shared brief goes in the `task` call's `context` field or in a real file at an **absolute
  filesystem path** (repo, worktree, or your packet directory). Never a `local://`, `agent://`, or
  other internal URI — workers cannot open those and will work from a truncated task string.
- Name the absolute repo root or worktree the worker owns and the files it may touch. Tell it what
  NOT to run (repo-wide suites, CI) when you will integrate.

Rules:
- Worker files are worker-owned until you collect the result. Never redo a worker's changes.
- Never build a `pf-scout → pf-executor` pipeline for a single unknown bug — root-cause
  diagnosis stays orchestrator work until the cause, scope, files, constraints, and done-criteria
  are stable without rediscovery.
- **Budgets.** A worker that is past ~40 turns (≈30 minutes on a local router) without converging,
  or that keeps failing the same edit, is a failure even if it has not said so: cancel it via `hub`
  and count it toward the two-failure rule. Turn count beats token price — a cheap model that
  needs three times the turns is not cheap. Set `task.maxRuntimeMs` / `task.softRequestBudget` in
  config if you want a hard backstop.
- After two failures from the same worker tier, escalate (stronger worker config) or take the work
  over yourself — never a third same-tier retry.
- A worker that reports a genuine architecture fork or spec conflict stops and escalates; you
  decide, never let it guess.

### 5. Verify (verifier, strong) — the final-review gate
Give `pf-verifier` the EXACT claim + acceptance conditions + the relevant diff/paths, built with
this skill's packet script (`scripts/packet.mjs` next to this SKILL.md). Plugin installs live under
`~/.omp/plugins/cache/plugins/*pilotfish*/skills/pilotfish/scripts/packet.mjs`; manual installs
under `~/.omp/agent/skills/pilotfish/scripts/packet.mjs`. Run it from the repo root being verified:

```
mkdir -p /tmp/pilotfish && node <skill-dir>/scripts/packet.mjs \
  --focus "<what was done>" \
  --claim "<exact acceptance: 'done means …'>" \
  --summary "<3-8 factual bullets of worker output>" \
  --out /tmp/pilotfish            # a directory → pilotfish-packet-<rev8>-<NN>.md, never overwritten
```

The packet carries a **State** table (root, revision, branch, fingerprint of the diff). Read the
stderr summary: it lists every file that was embedded and every secret-like file that was NOT.
Tests, builds, and static checks you or the workers ran are intermediate evidence during iteration,
not a replacement for this fresh verification.

Then ONE `task` call with `agent: "pf-verifier"`, body = "Verify the claim in <packet path> per
your role contract; return your calibrated verdict." Name the absolute root/worktree. The verifier is
read-and-run only, never edits. Cap concurrent verifiers like scouts (3–4 on one local router).

### 6. Dispose + final review (orchestrator, strong)
| Verdict | Response |
|---|---|
| CONFIRMED | Pass to final review — read the integrated result yourself, then ship |
| REFUTED | Fix the reproduced P0-P2 block yourself or via worker, verify the fix, then ONE fresh verifier pass on the new state (never reverify identical state) |
| INCONCLUSIVE | One retry only after stated missing evidence/contract/prerequisite changed materially; otherwise pause and surface to the user |

"Identical state" is checkable: a new packet whose fingerprint equals the last one has nothing new
to verify. Any required post-verdict change invalidates a CONFIRMED; rerun primary acceptance plus
one fresh verifier when claim-relevant. Your final review is a judgment pass over the integrated
result and the verifier's evidence — this is where the strong model earns its keep. Finish by
stating what changed, what you ignored and why, and the current verdict.

Before that review, audit what the run actually used — the same script, over every leaf this run
spawned (default window: the last 4 hours; scope it with `--since`):

```
node <skill-dir>/scripts/tiers.mjs --since 240
```

It lists each `pf-*` leaf with the model its transcript recorded. Every row must be `ok`; a leaf
that ran off its tier is a failed leaf — name it in the final review, and do not fold its output in
as if the tiering held. A worker result produced on your own model is not independent worker work,
and the cost was yours, not the router's.

## Safety

- Credentials/secrets/identity/crypto work: never route unwittingly to a worker pool that lacks a
  verification gate — the verifier gate above is mandatory for any security-sensitive slice.
- The packet script never embeds files with credential-like names (`.env*`, `*.pem`, `*.key`,
  `*token*`, `*secret*`, …) or binaries, and lists on stderr everything it did embed. Read that list
  before sending a packet to a remote verifier; use `--no-untracked` when the tree holds scratch
  files you do not want shipped.
- The worker pool is your own local router: it is trusted, but a fresh-context verifier still
  exists because proximity ≠ independence.
- Long-running commands: workers run foreground and return the exact command if it exceeds ~10
  minutes — never detach (lost work is the failure mode; see `pf-*` role contracts).

## Tooling

- Scripts live in `scripts/` alongside this SKILL.md (use your installed skill dir absolute
  path; cwd varies by project).
- `packet.mjs`: `--focus` (required), `--claim`, `--summary` (or `--focus-file` / `--claim-file` /
  `--summary-file <path>` for multi-line text), `--files a,b,c` (explicit, no VCS),
  `--no-untracked`, `--limit <bytes>` (diff), `--embed-limit <bytes>` (per embedded file),
  `--out <file|dir>`, `--json`. Auto-detects git (`git status --porcelain` + `git diff HEAD`) and jj
  (`jj status` + `jj diff --git`). Stamps root, revision, branch, and a sha256 fingerprint.
- `presets/tiers-template.yml`: `modelRoles.pf-worker` / `modelRoles.pf-strong` (whole tier) plus
  optional `task.agentModelOverrides` (single seat), with placeholders. Changing tier models =
  `omp --config <filled-in copy>` for one run, or the same block in `~/.omp/agent/config.yml` or
  `<repo>/.omp/config.yml` permanently, plus the `--model` you launch OMP with. Register provider
  endpoints in `~/.omp/agent/models.yml` (keys by env-var name, values in `~/.omp/agent/.env`).
  `omp models` lists what each provider can serve.
- `tiers.mjs`: the tier proof (step 0 gate + step 6 audit). `--probe <task-name>` (repeatable)
  restricts the check to named spawns and FAILS when one produced no transcript; `--session-dir`
  pins the session (default: the newest session dir for the current cwd within `--since <min>`);
  `--expected <agent>=<selector>` states a tier OMP's persisted settings cannot show (a `--config`
  overlay); `--orchestrator <sel>` overrides the parent model it reads from the parent transcript;
  `--no-omp` skips settings; `--json` for machines. Verdicts: `ok`, `collapsed` (ran on the
  orchestrator's model), `mismatch`, `unconfigured`, `unverified`; exit 1 unless every checked row
  is `ok`. It reads `session_init.resolvedModel` / `model_change` from the subagent transcripts
  under `~/.omp/agent/sessions/<cwd-slug>/<session-id>/` — the same ground truth quorum-review's
  `collect.mjs` uses for seat provenance.
