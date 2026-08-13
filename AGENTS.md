# Agent context — quorum-review skill bundle

To the agent reading this: this repo is the distributable for an OMP skill. It is a
**review-pass tool**, not app code. Read this before operating it.

## What it is

When the user says **"panel review" / "quorum" / "review pass" / "last pass"**, run the
quorum-review protocol from `SKILL.md`: capture current focus + context packet, spawn every
**ACTIVE** reviewer seat in parallel (one agent per model), dedupe findings by consensus,
present the report, fix corroborated findings. Goal: an honest final quality gate using
models independent of the user's local work model.

## Installation (target machine)

```bash
git clone <repo> quorum-review && cd quorum-review && ./install.sh
```

`install.sh` is idempotent and backs up replaced files. It installs to:
- `~/.omp/agent/skills/quorum-review/` (SKILL.md + scripts/) — the OMP-native skills root
- `~/.omp/agent/agents/rev-quorum-*.md` (panel seats)

A legacy OpenCode-config copy (`~/.config/opencode/skills/quorum-review/`) is no longer an
install target; `install.sh` warns if one exists. Remove it (`rm -rf`) on any machine where it
appeared, so the OMP-native copy is the only one.

## Key invariants — do not break

1. **Seat list is DYNAMIC.** Never hardcode panel composition in SKILL.md or docs.
   Run `node scripts/panel.mjs` to see active seats (files lacking `disable: true`).
2. **All active seats are spawned in ONE parallel task batch**, each with the SAME brief
   (the review packet), so consensus means something. Seats are the `rev-quorum-*` agents
   only — never substitute bundled/local agents (`scout`, `reviewer`, `task`) for them;
   a failed seat is reported, not replaced locally.
3. **Deterministic logic lives in scripts** — orchestration lives in SKILL.md. Scripts are
   the source of truth; keep their CLI stable (`--out`, `--json`, `--files`, `--dir`,
   `--limit`).
4. **Degraded panels are correct behavior, not errors.** Seats fail all the time on model
   route/policy churn. Report which seats ran (denominators are `n/<active>`); never hide a
   failed seat, never silently run a bigger/smaller panel than configured.
5. **Never fabricate reviewer output.** Unparseable/verdict-only seats are recorded as-is.

## Model panel intel (as committed)

- Active: `rev-quorum-c` = glm-5.2, `rev-quorum-d` = grok-4.6 (both reliable structured findings).
- Parked (disabled seats, do not enable without a route check): deepseek-v4-pro-0813 (blocked),
  qwen3.8-max (flapping), gemini-3.5-flash (dropped during tuning).
- `nvidia/nemotron-3.5-lightning` is a vetted candidate: if enabled, use `:coreweave/bf16`
  (256K ctx), NOT `:deepinfra/bf16` (28K ctx — too small for packets).

## Enabling a parked/new model

1. In the seat file: set `model:` and remove `disable: true` (or add a new `rev-quorum-x.md`).
2. **Route-check first**: spawn the seat with a trivial "reply OK" task. `404 … guardrail
   restrictions and data policy` ⇒ account policy, leave disabled. 5–15 s per seat.
3. Re-run `./install.sh` on the target OMP install.

This account has a known per-vendor policy: some vendors 404 while others route. That is
account-level (openrouter.ai/settings/privacy), not a repo defect — the review flow survives it.

## Gotchas from live runs

- git status collapses untracked DIRS to `?? dir/` → packet.mjs uses `-uall` + `statSync`
  file guard; never reintroduce naked `readFileSync` over untracked paths.
- `dedupe --dir` scans every `.json` (its own `*.report.json` excluded) — pass explicit
  result files for a clean run.
- Some models (kimi-k3, seed-1.6-flash observed) return verdict + explanation but empty
  `findings`. Treat as verdict-only; don't rerun seats to "force" structure.
