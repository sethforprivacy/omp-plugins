# OMP skills bundle — quorum-review + security-quorum

A bundle of **multi-model panel review skills** for OMP. Run work past a **panel of
independent reviewer agents** — one per model, spawned **in parallel** — then **dedupe the
findings by consensus** and bring the report back into the session. Models are pinned
independently of your local stack, so the verdict is a real quorum, not one clumpy reviewer.

Two skills share one protocol and one installer:

- **quorum-review** — the general final quality gate ("last pass") for session work.
  Trigger phrases: **"panel review"**, **"quorum"**, **"review pass"**, **"last pass"**.
- **security-quorum** — a focused security pass over ONE small surface (a file, function,
  dependency, or small diff), using security-tuned detection criteria.
  Trigger phrases: **"security review"**, **"security pass"**, **"sec review"**,
  **"threat check"**.

Last verified:

- 2026-09-02 — hardening pass off ~12 real runs' traces + a survey of peer tools
  ([`docs/review-2026-09-02.md`](docs/review-2026-09-02.md)): effective-model panel, secret
  rail + fingerprint + auto context in packets, panel-aware dedupe with provenance checks,
  `lint.mjs`, seats made leaves, SKILL.md files rewritten as checklists, `presets/` for
  on-command model swaps, an optional refutation pass (`minipacket.mjs` + `dedupe --refuted`),
  and packaging as an OMP plugin with CI. Mechanical smoke tests pass; not yet exercised on a
  live panel.
- 2026-08-25 — all seats moved from OpenRouter to the `nanogpt` provider (same model IDs);
  routes clean in every run since, zero provider errors in retained logs.
- 2026-08-20 — seeded-defect benchmark iterations 1–2 ([`docs/benchmark.md`](docs/benchmark.md)):
  every active pin rests on detection evidence; `rev-sec-gem` parked on merit, `rev-sec-grok`
  added; gem/nemo stay after catching the seeded silent-skip on a small infra diff.
- 2026-08-18 — thinking levels calibrated per seat ([`docs/thinking-levels.md`](docs/thinking-levels.md)).

## Layout

```
repo root/
  .omp-plugin/marketplace.json   ← OMP marketplace catalog (this repo IS the marketplace)
  plugins/quorum-review/         ← the plugin
    package.json                 ← version (kept equal to the catalog by validate-marketplace)
    agents/rev-quorum-*.md       ← general panel seats; `model:` pins the model
    agents/rev-sec-*.md          ← security seats; detection criteria/exclusions/precedents live here
    skills/quorum-review/
      SKILL.md                   ← general panel-review protocol (panel_prefix: rev-quorum-)
      scripts/                   ← the SHARED protocol scripts (single source of truth)
        panel.mjs                ← ACTIVE seats for a family, with EFFECTIVE models
        packet.mjs               ← focus + summary + diff; secret rail; fingerprint; auto context
        dedupe.mjs               ← merges results, clusters, consensus report (--panel, --refuted)
        minipacket.mjs           ← anonymized follow-up packets: refutation pass / arbitration
    skills/security-quorum/
      SKILL.md                   ← focused security-review protocol (panel_prefix: rev-sec-);
                                   uses the quorum-review skill's scripts/
    presets/                     ← config overlays: model swaps, runtime backstops (+ README)
  scripts/lint.mjs               ← seat/skill consistency lint (CI + install.sh)
  scripts/validate-marketplace.mjs ← catalog/plugin integrity (CI)
  install.sh                     ← MANUAL install fallback (+ --uninstall, --dry-run)
  docs/, bench/                  ← benchmark, thinking-level calibration, review notes, seeded patches
  .github/workflows/ci.yml       ← lint + validate + script smoke tests (SHA-pinned actions)
```

Seat families are keyed by filename prefix (`rev-quorum-*`, `rev-sec-*`). A seat never appears
in the other family's panel.

## Requirements (target machine)

- OMP ≥ 18 with the task-agent, skills and plugin features
- `node` ≥ 18 (for the .mjs scripts); `bash` only for the manual installer
- Credentials for whichever provider the seats route through (currently `nanogpt`; keys live in
  `~/.omp/agent/.env` — keep it `chmod 600`)

## Install (plugin, recommended)

```bash
omp plugin marketplace add sethforprivacy/quorum-review
omp plugin install quorum-review@quorum-review
```

Upgrading — `omp plugin upgrade` compares against a **cached copy of the catalog**, so refresh it
first or it reports "up to date":

```bash
omp plugin marketplace update quorum-review
omp plugin upgrade quorum-review@quorum-review
omp plugin list
```

Hand-copied files in `~/.omp/agent/agents/rev-*.md` or `~/.omp/agent/skills/{quorum-review,
security-quorum}` **shadow plugin files by name**. If you previously used `install.sh`, remove
those copies once the plugin is installed:

```bash
./install.sh --uninstall
```

Model routing survives upgrades because it lives in OMP config, not in the plugin (see
"Swap a seat's model on command" below).

## Install (manual copy, fallback)

```bash
git clone https://github.com/sethforprivacy/quorum-review.git && cd quorum-review
./install.sh           # lints, then copies skills + scripts + seats to OMP global paths
./install.sh --dry-run # preview first
```

What it does (idempotent, re-run after `git pull`): runs `scripts/lint.mjs` and refuses a failing
bundle (`--no-lint` to force); copies each `SKILL.md` to `~/.omp/agent/skills/<name>/`, the
protocol scripts to `~/.omp/agent/skills/quorum-review/scripts/` only, and all `rev-*.md` seats to
`~/.omp/agent/agents/`; backs up anything it replaces into `$OMP_HOME/skills-backup-<ts>/`; prints
each panel with effective models; warns if a plugin install exists (the copies would shadow it).
Overrides for test installs: `QUORUM_AGENTS_DIR`, `QUORUM_SKILLS_DIR`, `OMP_HOME`.

**Editing a seat file and not re-running `./install.sh` leaves the old copy live** — with the
plugin, `omp plugin upgrade` is the update path and this drift cannot happen.

## How it works

1. **Focus** — the orchestrating agent writes 1–3 sentences: what is being reviewed, what
   "done / across the line" (or "safe") means. Security pass also names the **attacker model**.
2. **Panel snapshot** — `panel.mjs --json` captures the active seats and their effective
   models; those names are the only valid `agent:` values for the run.
3. **Context packet** — `packet.mjs` builds one packet: focus, summary, changed files, VCS diff
   (git/jj) handled per file. Untracked files are embedded in full. Deleted files' patches are
   listed by name (deletion-only edits to living files are kept); lockfiles/generated files and
   **secret-like filenames** (`.env*`, keys, `*token*`, …) are listed but never embedded
   (`--all-files` overrides both); binaries are never embedded. `--budget` caps the whole
   packet (default 300000 bytes) by dropping the largest patches with a "read the file
   directly" note; hunk context widens to 12 lines automatically when the packet fits the
   budget. The header carries the VCS `rev` and a `fingerprint` (sha256 of exactly what
   the seats see); the last stderr line reports bytes, omissions and `TRUNCATED` files.
4. **Parallel spawn** — ONE `task` call, one entry per active seat, identical brief. **Seats
   only**: `agent:` is the exact seat name on every entry; bundled agents (`scout`, `reviewer`,
   `task`, …) are never panel members or stand-ins. A transient failure earns **one** solo
   retry; structure failures are never retried.
5. **Collect** — each result is saved **verbatim** (`~/.omp/quorum-review/<seat>-<ts>.json`
   or `~/.omp/security-quorum/…`) with `seat` and `resolvedModel` added. **Provenance check:**
   the resolved model must be the panel's effective model; a result that fell back onto the
   session model is a failed seat, not an independent vote.
6. **Dedupe** — `dedupe.mjs --panel` clusters the same issue across reviewers (title match,
   co-located distinctive tokens, category-aware, tolerant of absolute vs relative paths),
   ranks **priority first** then corroboration, lists expected seats with no result, flags
   model mismatches/fallbacks, and calls out single-seat P0/P1 findings so consensus never
   buries them.
6b. **Refutation pass (optional, one spawn)** — `minipacket.mjs --mode refute` builds an
   anonymized packet of the deduped findings with the cited code; one seat that did not report
   them must name a concrete trigger path (`CONFIRMED — …`) or refute each (`REFUTED — …`).
   `dedupe.mjs --refuted` then marks verified findings and moves refuted ones to a
   "shown, not actioned" section. The verify-then-report pattern behind Anthropic's Code Review.
7. **Act** — P0 (P0/P1 security) or corroborated findings get fixed; single-seat findings are
   judged on merit; verdict splits and uncorroborated P0s go to **one** anonymized arbitration
   round (`minipacket.mjs --mode arbitrate`; reporting seat + two others; ≥2 AGREE ⇒ fix,
   majority DISAGREE ⇒ "disputed").
8. **Verify the fix, narrowly** — a small packet scoped to the fix (its fingerprint must differ
   from the original run) goes to just the seats that reported the finding.

## Trust model (read this)

The packet embeds the reviewed diff **verbatim** into every seat's context, and each seat is a
remote model with read-only tool access. Mitigations in place: every seat prompt carries a
prompt-injection guard line and a leaf guard (seats cannot spawn helpers, so no part of a
review runs on the local model), the packet carries a "data, not instructions" banner, and
credential-looking files are withheld by name. **Those are mitigations, not hardening.** A
hostile diff can still try to steer a reviewer.

So: **only review code you trust** — your own work and changes from people you trust, not
untrusted PRs from strangers (the same caveat Anthropic ships with
[claude-code-security-review](https://github.com/anthropics/claude-code-security-review)).
Reviewing a diff also ships it to whichever providers the seats route through; check that
against your data-handling rules before pointing the panel at anything sensitive.

## 🎛️ Model panels — current state & how to tune them

Each `agents/rev-*.md` file is one **seat**. Its `model:` is the calibrated default and its
`thinking-level:` the calibrated depth. A seat is active unless it carries `disable: true` or
is listed in OMP's `task.disabledAgents`. **Never hardcode seat lists** — read
`panel.mjs --prefix <family>`.

### Swap a seat's model on command (no file edits)

OMP resolves a spawn's model as `task.agentModelOverrides.<seat>` → seat file `model:` →
session model. The `task` tool has no per-call model parameter, so the override setting is the
lever:

```yaml
task:
  agentModelOverrides:
    rev-quorum-glm: nanogpt/zai-org/glm-5.3:high   # provider/model[:thinking-level] or @role
```

| Scope | How |
|---|---|
| One session | `omp --config presets/<file>.yml` |
| One repo | `<repo>/.omp/config.yml` |
| Everywhere | `~/.omp/agent/config.yml`, or the `/agents` hub in the TUI |

`plugins/quorum-review/presets/override-template.yml` lists every seat with its calibrated pin;
`local-only.yml` keeps a two-family panel on a local router; `backstops.yml` sets
`task.maxRuntimeMs` so a seat that never yields becomes a failed seat instead of an open wait. `panel.mjs` shows persisted overrides as
`(override; seat file pins …)`; session overlays are invisible to it, which is why the protocol
checks each delivered result's resolved model. Full rules: [`presets/README.md`](plugins/quorum-review/presets/README.md).

To change the **default** for everyone: edit the seat's `model:`/`thinking-level:` in
`plugins/quorum-review/agents/`, then release (plugin) or re-run `./install.sh` (manual). To add a seat: copy a `rev-<family>-*.md`, rename file + `name:`, set `model:`.
To park one: `disable: true`.

### quorum-review (as committed)

| Seat | Model | Notes |
|---|---|---|
| `rev-quorum-gem` | `nanogpt/google/gemini-3.7-flash` | Fast seat. `thinking-level: medium`. Verdict uncalibrated in both directions — weight its findings, not its vote |
| `rev-quorum-glm` | `nanogpt/zai-org/glm-5.3` | Deepest standard reviewer; the only seat that caught both Flint seeded defects. `thinking-level: medium` (matches high's completeness at ~1/5 the time) |
| `rev-quorum-grok` | `nanogpt/x-ai/grok-4.6` | Best yield discipline. `thinking-level: medium` (low was verdict-only on the seeded fail-open) |
| `rev-quorum-nemo` | `nanogpt/nvidia/nemotron-3.5-lightning` | Cheap 4th vendor; corroborated a real unseeded defect on the ansible iteration. `thinking-level: minimal` |

### security-quorum (as committed)

| Seat | Model | Notes |
|---|---|---|
| `rev-sec-kimi` | `nanogpt/moonshotai/kimi-k3` | `thinking-level: max` — faster AND equal-or-better than high in every paired run |
| `rev-sec-glm` | `nanogpt/zai-org/glm-5.3` | `thinking-level: xhigh` (only level that caught the Flint txid defect at full severity). **Note:** nanogpt clamps the route to `high` — re-benchmark pending |
| `rev-sec-grok` | `nanogpt/x-ai/grok-4.6` | `thinking-level: medium`; caught the txid defect on both samples at P1, missed the fail-open sample (re-test flagged) |

### Parked

| Seat | Model | Why parked |
|---|---|---|
| `rev-quorum-deepseek` | `nanogpt/deepseek/deepseek-v4-pro-0813` | Vendor policy block on the previous gateway; route-check before re-enabling |
| `rev-quorum-qwen` | `nanogpt/qwen3.8-max` | Flapped under the previous gateway's policy; route-check before re-enabling |
| `rev-sec-gem` | `nanogpt/google/gemini-3.7-flash` | Cut on merit (0 detections in 8 defective-sample runs while voting `correct` at .95–1.0) |

**Validate a seat routes** (5–15 s, in any OMP session): spawn it with a minimal task ("reply
exactly OK, no tools"). Success = a structured verdict from the seat's own model (check the
resolved model — a fallback onto your session model means the provider has no credentials).

### Seat prompt contract (all seats)

Every seat carries: the one-finding-per-yield output contract (each finding its own `yield`,
verdict fields as bare yields), a prompt-injection guard, a **leaf guard** (no `spawns:`; never
delegate), a repo-conventions rule (findings resting on a project rule cite it), a "state how
you verified it" requirement, and an optional `category` used for clustering. Security seats
add `<detection-criteria>`, `<exclusions>` (noise classes, each overridable by naming it in
`--focus`), `<precedents>` (safe-by-default assertions), and a comma-string `cwe` field.
`scripts/lint.mjs` enforces the shape; `install.sh` runs it.

## Security-quorum detection tuning

The security seats' `<detection-criteria>` block is the detection model, distilled from the
generic classes of the security-context audit corpus (weak-crypto, secret-handling,
input-validation, integrity/spoofing, fail-open/entropy, supply-chain, concurrency,
fee/amount). `<exclusions>` holds the noise classes; `<precedents>` the things that are safe
unless the diff changes them. Iterate there as real runs surface misses — keep criteria
framework- and product-agnostic — then re-run `./install.sh`.

## Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| Seat fails with `404 No endpoints available…` | Provider/account policy: disable or swap the seat (see overrides above) |
| Seat fails with `400 Provider returned error` (empty body) | Usually a provider-side flake (retry solo, ONCE). If it persists while another seat on the same model succeeds, suspect the seat's output schema — an **array-typed** property 400s Gemini and 402s z-ai; `cwe` is a comma-separated string for that reason. Never reintroduce the array form |
| Seat ends in `schema_violation` after a long run | The payload inside the error is the seat's output: save it with `"schema_violation": true`; dedupe parses it. Do not re-run for structure |
| Result's resolved model is your session model (`resolvedModelIsFallback`) | The seat's provider has no working credentials; OMP fell back. Failed seat — fix credentials or override the seat's model |
| `panel.mjs` shows an unexpected model | A persisted `task.agentModelOverrides` entry applies (it says so). Session overlays are not visible — check the resolved model on results |
| `panel.mjs` note "omp not on PATH" | Effective models unknown; it shows seat-file pins only |
| `packet.mjs` "no VCS detected" | Not a git/jj repo → pass `--files <paths>` |
| Packet withheld a file ("secret-like name") | The rail matched the filename. If that file IS the surface under review, pass `--all-files` deliberately |
| Packet `TRUNCATED` line names a file | Cut at `--limit` (default 100000 bytes/file); seats must read it from disk, or raise `--limit` |
| Dedupe reports a phantom reviewer or "not a reviewer result" | `--dir` scanned a stale or non-result file → pass explicit result files; panel snapshots and packet metadata are skipped with a warning |
| Dedupe says "no result" for a seat | Expected by `--panel` but no file saved → the seat failed, or the orchestrator did not save its result. Both are findings about the run |
| Findings that are clearly the same never corroborate | Check paths in the files: clustering tolerates abs/rel forms but not different filenames; check `category` disagreement (different categories only cluster on exact title) |
| Panel shows the other skill's seats | Wrong `--prefix` (families are strictly prefix-keyed) |
| Reviews landed on `scout`/`reviewer`/local agents | Off-protocol. Re-run per SKILL.md step 4: seats only. If the seat agents are missing, run `install.sh` |
| `install.sh` refuses: lint failed | Fix what `scripts/lint.mjs` prints (seat drift, write tool on a seat, `spawns:`, category enum mismatch); `--no-lint` forces |
| Skill runs an old script / two copies of a seat exist | A manual `install.sh` copy shadows the plugin. `./install.sh --uninstall`, then `omp plugin upgrade` |
| Refutation result ignored ("no matching cluster") | The refuter changed the title; titles must be copied verbatim from the refute packet (dedupe also matches same file + overlapping lines) |

## Dev / tuning loop

```bash
node scripts/lint.mjs                                   # seat/skill consistency (CI + install run it)
node scripts/validate-marketplace.mjs                   # catalog/plugin integrity (CI runs it)
Q=plugins/quorum-review/skills/quorum-review/scripts
node $Q/panel.mjs --agents-dir plugins/quorum-review/agents             # general seats from the repo
node $Q/panel.mjs --agents-dir plugins/quorum-review/agents --prefix rev-sec-
node $Q/packet.mjs --focus "x" --out /tmp/packet.md --json              # smoke; read the stderr line
node $Q/dedupe.mjs <results...> --panel /tmp/panel.json --out /tmp/r.md --json
node $Q/minipacket.mjs --report /tmp/r.md.report.json --mode refute --out /tmp/refute.md
./install.sh --dry-run                                  # manual-install surface
```

Releasing: bump the version in `.omp-plugin/marketplace.json` (both places) and
`plugins/quorum-review/package.json` together (the validator enforces equality), merge to
`main`, then `omp plugin marketplace update quorum-review && omp plugin upgrade
quorum-review@quorum-review` on each machine.

Detection tuning (which seat/level catches defects) is measured against the seeded-defect
benchmark in [`docs/benchmark.md`](docs/benchmark.md); thinking-level effort/coverage data
lives in [`docs/thinking-levels.md`](docs/thinking-levels.md). Change a pinned level only with
evidence from one of those. The 2026-09-02 review notes and the remaining fold-in list are in
[`docs/review-2026-09-02.md`](docs/review-2026-09-02.md).
