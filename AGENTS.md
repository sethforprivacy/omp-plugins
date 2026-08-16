# Agent context — OMP skills bundle (quorum-review + security-quorum)

To the agent reading this: this repo is the distributable for OMP skills. It is a
**review-pass tool**, not app code. Read this before operating it.

## What it is

Two panel-review skills, one bundle:

- **quorum-review** — general "last pass" gate. When the user says **"panel review" /
  "quorum" / "review pass" / "last pass"**, run its protocol from `skills/quorum-review/
  SKILL.md`: capture focus + context packet, spawn every **ACTIVE** `rev-quorum-*` seat in
  parallel (one agent per model), dedupe findings by consensus, present the report, fix
  corroborated findings. Goal: an honest final quality gate using models independent of the
  user's local work model.
- **security-quorum** — focused security pass. When the user says **"security review" /
  "security pass" / "sec review" / "threat check"**, run `skills/security-quorum/SKILL.md`:
  the same protocol over the **`rev-sec-*`** panel, scoped to ONE small surface (file,
  function, dependency, small diff) with security-tuned detection criteria in the seat
  prompts. Shared packet/dedupe scripts; separate results dir `~/.omp/security-quorum/`.

## Layout

- `skills/<name>/SKILL.md` — one skill per dir. Frontmatter `panel_prefix:` names the seat
  family that skill's panel reads (`rev-quorum-` / `rev-sec-`).
- `skills/<name>/agents/rev-*.md` — seat agents; `model:` pins the remote model, `disable:
  true` parks a seat. `skills/<name>/scripts/` may hold skill-local script overrides.
- `scripts/` at repo root — the SHARED protocol scripts (packet/dedupe/panel), single source
  of truth; the installer copies them into every skill's installed `scripts/` dir.

## Installation (target machine)

```bash
git clone <repo> omp-skills && cd omp-skills && ./install.sh
```

`install.sh` is idempotent and backs up replaced files. It installs to:
- `~/.omp/agent/skills/<skill>/` (SKILL.md + scripts/) for every skill under `skills/`
- `~/.omp/agent/agents/rev-*.md` (all seat files, all families)

Legacy OpenCode-config copies (`~/.config/opencode/skills/<skill>/`) are no longer install
targets; `install.sh` warns if they exist. Remove them (`rm -rf`) on any machine where they
appeared, so the OMP-native copies are the only ones.

## Key invariants — do not break

1. **Seat list is DYNAMIC.** Never hardcode panel composition in SKILL.md or docs. Run
   `node <skill>/scripts/panel.mjs [--prefix <family>]` to see active seats (files lacking
   `disable: true`). Panel families are keyed by seat filename prefix (`rev-quorum-`,
   `rev-sec-`) — a seat never shows up in the other family's panel.
2. **All active seats are spawned in ONE parallel task batch**, each with the SAME brief
   (the review packet), so consensus means something. Seats are the `rev-*-*` agents only —
   never substitute bundled/local agents (`scout`, `reviewer`, `task`) for them; a failed
   seat is reported, not replaced locally.
3. **Deterministic logic lives in scripts** — orchestration lives in SKILL.md. Scripts are
   the source of truth; keep their CLI stable (`--out`, `--json`, `--files`, `--dir`,
   `--limit`; `panel.mjs` extras: `--prefix`, `--agents-dir`).
4. **Degraded panels are correct behavior, not errors.** Seats fail all the time on model
   route/policy churn. Report which seats ran (denominators are `n/<active>`); never hide a
   failed seat, never silently run a bigger/smaller panel than configured.
5. **Never fabricate reviewer output.** Unparseable/verdict-only seats are recorded as-is.

## Model panel intel (as committed)

- quorum-review active: `rev-quorum-b` = gemini-3.7-flash (route-checked clean 2026-08-13),
  `rev-quorum-c` = glm-5.2, `rev-quorum-d` = grok-4.6 (all reliable structured findings),
  `rev-quorum-f` = nvidia nemotron-3.5-lightning (route-checked clean 2026-08-16; cheap,
  all live endpoints ≥256K ctx fit packets).
- security-quorum active: `rev-sec-kimi` = kimi-k3 (route-checked clean 2026-08-14; structured-findings behavior re-confirmed 2026-08-16 — was historically verdict-only), `rev-sec-gem` = gemini-3.7-flash (route-checked clean 2026-08-16 after removing the untyped-array `cwe` output-schema field — the Gemini provider 400s on array-typed schema properties, so the gem seat reports no CWE ids; kimi keeps `cwe` because Moonshot tolerates it).
- security-quorum parked: `rev-sec-glm` = `z-ai/glm-5.3` — **not yet published on OpenRouter**
  (API lists only through `glm-5.2`; open weights expected within weeks). Enable ONLY after
  a route check.
- quorum-review parked (disabled seats, do not enable without a route check):
  deepseek-v4-pro-0813 (blocked), qwen3.8-max (flapping).
- `nvidia/nemotron-3.5-lightning` committed as `rev-quorum-f` (2026-08-16) using the canonical
  `openrouter/nvidia/nemotron-3.5-lightning` ID. Do NOT use `:coreweave/bf16` / `:deepinfra/bf16`
  variant IDs — those left the OpenRouter catalog; the base ID now routes DeepInfra/CoreWeave
  (both 256K ctx) and Venice (1M ctx), all fine for packets.

## Enabling a parked/new model

1. In the seat file: set `model:` and remove `disable: true` (or add a new `rev-*.md` with
   the right family prefix).
2. **Route-check first**: spawn the seat with a trivial "reply OK" task. `404 … guardrail
   restrictions and data policy` ⇒ account policy, leave disabled. 5–15 s per seat.
3. Re-run `./install.sh` on the target OMP install, then confirm the seat shows in
   `panel.mjs --prefix <family>`.

This account has a known per-vendor policy: some vendors 404 while others route. That is
account-level (openrouter.ai/settings/privacy), not a repo defect — the review flow survives it.

## Detection tuning (security-quorum)

The security seats' detection criteria live in the `<detection-criteria>` section of the
`rev-sec-*.md` prompts. They were distilled from the generic classes of the
security-context audit findings corpus (`~/repos/work/security-context/`): weak-crypto,
secret-handling, input-validation, integrity/spoofing, fail-open/entropy, supply-chain,
concurrency, fee/amount manipulation — wallet-specific chains and Cake-Wallet specifics were
deliberately excluded. Tune there as real runs surface misses, keeping criteria generic
(framework- and product-agnostic); re-run `./install.sh` after editing.

## Gotchas from live runs

- The OpenRouter Gemini provider 400s ("Provider returned error", empty body) on output-schema
  properties that are `type: array` without `items` — the harness's frontmatter→schema converter
  drops an `items:` key if you try to add one. The `rev-sec-gem` seat 400ed persistently on its
  `cwe` array; fixes: remove such fields from that seat's schema (gem now ships without `cwe`).
  Moonshot accepts the same untyped array — `rev-sec-kimi` still carries `cwe`.
- git status collapses untracked DIRS to `?? dir/` → packet.mjs uses `-uall` + `statSync`
  file guard; never reintroduce naked `readFileSync` over untracked paths.
- `dedupe --dir` scans every `.json` (its own `*.report.json` excluded) — pass explicit
  result files for a clean run. Keep the two results dirs (`~/.omp/quorum-review/` vs
  `~/.omp/security-quorum/`) separate.
- Some models (seed-1.6-flash observed; kimi-k3 historically) return verdict + explanation but empty `findings`. Treat as verdict-only; don't rerun seats to "force" structure. kimi-k3's empty-findings behavior was fixed 2026-08-14 by the hardened `rev-sec-kimi` output contract — do not treat current kimi output as verdict-only.
- The two skills share one install surface: editing a seat file and NOT re-running
  `./install.sh` means the live OMP agents dir still has the old copy. Reinstall after
  every seat/prompt change.
