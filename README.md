# quorum-review — multi-model panel review skill for OMP

Run the current work past a **panel of independent reviewer agents** — one per model,
spawned **in parallel** — then **dedupe the findings by consensus** and bring the report
back into the session. Built as the final quality gate ("last pass") for work produced
with local models.

- Trigger phrases: **"panel review"**, **"quorum"**, **"review pass"**, **"last pass"**
- Last verified: 2026-08-13 (glm-5.2 + grok-4.6, 2-seat degraded panel, end-to-end)

## Layout

```
quorum-review/
  SKILL.md                 ← the skill (orchestration protocol; auto-loads by description)
  scripts/
    panel.mjs              ← lists ACTIVE seats (dynamic; reads agent files)
    packet.mjs             ← assembles focus + session summary + diff/untracked contents
    dedupe.mjs             ← merges reviewer results, clusters findings, consensus report
  agents/
    rev-quorum-*.md        ← one panel seat per file; `model:` pins the model
  install.sh               ← idempotent installer (+ backup, --dry-run)
  README.md, AGENTS.md
```

## Requirements (target machine)

- OMP with the task-agent + skills features
- `bash`, `node` ≥ 18 (for the three .mjs scripts)
- An OpenRouter credential reachable by the target OMP install (see ⚠️ below)

## Install

```bash
git clone <your private repo URL> quorum-review
cd quorum-review
./install.sh          # copies to the standard OMP global paths
./install.sh --dry-run # preview first, if you like
```

What it does (idempotent, re-run after `git pull` at any time):

- `SKILL.md` + `scripts/` → `~/.omp/agent/skills/quorum-review/`
- `agents/rev-quorum-*.md` → `~/.omp/agent/agents/`
- Backs up any file it replaces (timestamped, only if it differs)
- Verifies installation by listing the active panel via `panel.mjs`

Overrides for nonstandard/test installs: `QUORUM_SKILL_DIR`, `QUORUM_AGENTS_DIR`, `OMP_HOME`.

Uninstall: remove those two directories (backups are the `.quorum-backup-*` dirs beside them).

## How it works (what "panel review" does)

1. **Focus** — the orchestrating agent writes 1–3 sentences: what is being reviewed, what
   "done / across the line" means.
2. **Context packet** — `packet.mjs` builds a single packet: focus, session summary, changed
   files, VCS diff (git/jj). New/untracked files are embedded (git mode lists them
   individually via `-uall`; a defensive file-type guard prevents EISDIR crashes). Non-VCS
   sessions pass `--files <paths>`.
3. **Parallel spawn** — ONE task batch, one entry per ACTIVE seat (`panel.mjs` output),
   identical brief. Seats run concurrently. **Seats only**: `agent:` must be the exact seat
   name; bundled/local agents (`scout`, `reviewer`, `task`) are NOT panel members and are
   never used as substitutes — a failed seat is reported, not replaced.
4. **Collect** — each structured result saved to `~/.omp/quorum-review/<seat>-<ts>.json`.
   Seats that fail (route/auth policy, timeout, verdict-only) are recorded, not fabricated.
5. **Dedupe** — `dedupe.mjs` clusters the same issue reported by different reviewers
   (normalized-title match, co-located distinctive-token match), ranks by priority +
   corroboration, aggregates the panel verdict, prints the report.
6. **Act** — P0 or corroborated (≥2 seats) findings get fixed; single-seat findings get
   judged on merit; verdict splits are surfaced.

## 🎛️ Model panel — current state & how to tune it

Each `agents/rev-quorum-*.md` file is one **seat**. The seat's `model:` frontmatter is the
model it runs. The panel seen by the skill is whatever `panel.mjs` discovers: files matching
`rev-quorum-*.md` that do NOT have `disable: true`.

**Never hardcode the seat list in SKILL.md** — always read `panel.mjs`.

### Active (as committed)

| Seat | Model | Notes |
|---|---|---|
| `rev-quorum-c` | `openrouter/z-ai/glm-5.2` | Reliable structured findings |
| `rev-quorum-d` | `openrouter/x-ai/grok-4.6` | Reliable structured findings; best yield discipline observed |

### Parked (disabled until their route/policy situation changes)

| Seat | Model | Why parked |
|---|---|---|
| `rev-quorum-a` | `openrouter/deepseek/deepseek-v4-pro-0813` | 404 route block ("guardrail restrictions and data policy") on this account |
| `rev-quorum-e` | `openrouter/qwen/qwen3.8-max` | Flaps: routed cleanly after a policy tweak, then blocked again |
| `rev-quorum-b` | `openrouter/google/gemini-3.5-flash` | Dropped while tuning (fast seat); kept parked for reuse |

**Other candidate (not committed):** `nvidia/nemotron-3.5-lightning` — exists with live
OpenRouter endpoints (DeepInfra `bf16` 28K ctx, CoreWeave `bf16` 256K ctx, Venice `fp4` 1M).
404-blocked under the same account policy. If you add it, prefer **`:coreweave/bf16`** over
`:deepinfra/bf16` — DeepInfra's 28K context will not fit review packets.

**Enable / change a model:**

1. Edit `/install-dir/agents/rev-quorum-x.md` (or your local clone, then `git pull` elsewhere)
2. Set `model:` to the desired ID (e.g. `openrouter/qwen/qwen3.8-max`)
3. Add or delete the `disable: true` line
4. Add/remove seats freely (`rev-quorum-f.md`, …) — nothing else changes
5. Re-run `./install.sh` to deploy

**Validate a seat actually routes** (5–15 s, in any OMP session): spawn the seat with a
minimal task ("reply exactly OK, no tools"). Success = structured verdict returned. A
`404 … guardrail restrictions and data policy` = blocked at the OpenRouter account level —
fix on openrouter.ai/settings/privacy, not in this repo.

### ⚠️ Known account/policy behavior (documented from live testing)

- The same 404 blocks specific **vendors** (deepseek, NVIDIA; qwen flapped per policy
  changes) while leaving others (z-ai, x-ai, Google, Anthropic, Alibaba) routable.
- It is account/gateway policy, not a repo bug. The skill degrades gracefully: failed seats
  are reported, denominators become `n/<active>`, and the report still prints.
- Observed yield quirks: kimi-k3 and seed-1.6-flash returned verdicts without populating
  `findings` (documented in SKILL.md §collect).

## Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| Seat fails with `404 No endpoints available...` | Account policy: disable or swap the seat (above) |
| `packet.mjs` "no VCS detected" | Not a git/jj repo → pass `--files <paths>` |
| Dedupe reports a phantom reviewer | `--dir` scanned stale files → pass explicit result files, or use `--dir` only on a pristine dir (its own `*.report.json` is excluded) |
| Seat returned verdict but `findings: []` | Verdict-only seat; its explanation still shows in the panel report |
| Panel report has no seat files / seat results, or reviews landed on local `scout`/`reviewer` | The orchestrator skipped the protocol and improvised with bundled agents. Re-run per SKILL.md §3: seats only. If it keeps happening, the seat agents are missing → run `install.sh` and check `~/.omp/agent/agents/` |
| Packet stale mid-review | Regenerate the packet before spawning; reviewers read the packet at spawn time |

## Dev / tuning loop

```bash
# after editing any skill file
node scripts/panel.mjs                 # sanity: seats visible
node scripts/packet.mjs --focus "x" --files <paths> --out /tmp/packet.md   # smoke
node scripts/dedupe.mjs <results...>   # smoke with synthetic/collected results
./install.sh --dry-run                 # confirm install surface
git add -A && git commit && git push   # ship tuning to other installs
```
