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

- Last verified: 2026-08-16 (bundle restructure; both panels install clean; nemotron-3.5-lightning
  added as `rev-quorum-f` and route-checked clean; kimi-k3 structured findings re-confirmed)

## Layout

```
repo root/
  scripts/                  ← SHARED protocol scripts (single source of truth)
    panel.mjs               ← lists ACTIVE seats for a family (dynamic; --prefix)
    packet.mjs              ← assembles focus + session summary + diff/untracked contents
    dedupe.mjs              ← merges reviewer results, clusters findings, consensus report
  skills/
    quorum-review/
      SKILL.md              ← general panel-review protocol (panel_prefix: rev-quorum-)
      agents/rev-quorum-*.md ← one panel seat per file; `model:` pins the model
    security-quorum/
      SKILL.md              ← focused security-review protocol (panel_prefix: rev-sec-)
      agents/rev-sec-*.md   ← security panel seats; detection criteria live in these prompts
  install.sh                ← idempotent multi-skill installer (+ backup, --dry-run)
  README.md, AGENTS.md
```

Seat families are keyed by filename prefix (`rev-quorum-*`, `rev-sec-*`). `panel.mjs`
defaults to `rev-quorum-`; the security skill passes `--prefix rev-sec-`. A seat never
appears in the other family's panel.

## Requirements (target machine)

- OMP with the task-agent + skills features
- `bash`, `node` ≥ 18 (for the three .mjs scripts)
- An OpenRouter credential reachable by the target OMP install (see ⚠️ below)

## Install

```bash
git clone <your private repo URL> omp-skills
cd omp-skills
./install.sh           # copies every skill under skills/ to OMP global paths
./install.sh --dry-run # preview first, if you like
```

What it does (idempotent, re-run after `git pull` at any time):

- For each `skills/<name>/`: `SKILL.md` + shared scripts (plus any skill-local scripts) →
  `~/.omp/agent/skills/<name>/`
- All `agents/rev-*.md` (every family) → `~/.omp/agent/agents/`
- Backs up any file it replaces (timestamped into `$OMP_HOME/skills-backup-<ts>/`, only if
  it differs)
- Verifies installation by listing each skill's active panel via `panel.mjs --prefix`

Overrides for nonstandard/test installs: `QUORUM_AGENTS_DIR`, `OMP_HOME`.

Uninstall: remove `~/.omp/agent/skills/{quorum-review,security-quorum}` and the
`rev-*` seat files; backups live in `$OMP_HOME/skills-backup-*`.

## How it works

1. **Focus** — the orchestrating agent writes 1–3 sentences: what is being reviewed, what
   "done / across the line" (or "safe") means. Security pass also names the **attacker model**.
2. **Context packet** — `packet.mjs` builds a single packet: focus, session summary, changed
   files, VCS diff (git/jj). New/untracked files are embedded (git mode lists them
   individually via `-uall`; a defensive file-type guard prevents EISDIR crashes). Non-VCS
   sessions pass `--files <paths>`.
3. **Parallel spawn** — ONE task batch, one entry per ACTIVE seat (`panel.mjs` output for
   the skill's family), identical brief. Seats run concurrently. **Seats only**: `agent:`
   must be the exact seat name; bundled/local agents (`scout`, `reviewer`,
   `security-reviewer`, `task`) are NOT panel members and are never used as substitutes — a
   failed seat is reported, not replaced.
4. **Collect** — each structured result saved to `~/.omp/quorum-review/<seat>-<ts>.json`
   (general) or `~/.omp/security-quorum/<seat>-<ts>.json` (security). Seats that fail
   (route/auth policy, timeout, verdict-only) are recorded, not fabricated.
5. **Dedupe** — `dedupe.mjs` clusters the same issue reported by different reviewers
   (normalized-title match, co-located distinctive-token match), ranks by priority +
   corroboration, aggregates the panel verdict, prints the report.
6. **Act** — P0 (or P1 security) or corroborated (≥2 seats) findings get fixed; single-seat
   findings get judged on merit; verdict splits are surfaced.

## 🎛️ Model panels — current state & how to tune them

Each `agents/rev-*.md` file is one **seat**. The seat's `model:` frontmatter is the model
it runs. A seat is active unless it carries `disable: true`.

**Never hardcode seat lists in SKILL.md** — always read `panel.mjs --prefix <family>`.

### quorum-review (as committed)

| Seat | Model | Notes |
|---|---|---|
| `rev-quorum-b` | `openrouter/google/gemini-3.7-flash` | Fast seat; route-checked clean 2026-08-13 |
| `rev-quorum-c` | `openrouter/z-ai/glm-5.2` | Reliable structured findings |
| `rev-quorum-d` | `openrouter/x-ai/grok-4.6` | Reliable structured findings; best yield discipline observed |
| `rev-quorum-f` | `openrouter/nvidia/nemotron-3.5-lightning` | Added 2026-08-16, route-checked clean same day. Cheap (~$0.08/M prompt); all live endpoints ≥256K ctx (Venice 1M) fit review packets |

### security-quorum (as committed)

| Seat | Model | Notes |
|---|---|---|
| `rev-sec-kimi` | `openrouter/moonshotai/kimi-k3` | Route-checked clean 2026-08-14; structured findings re-confirmed 2026-08-16 (one-finding-per-yield contract) |
| `rev-sec-gem` | `openrouter/google/gemini-3.7-flash` | Route-checked clean 2026-08-16. Was 400ing persistently: the Gemini provider rejects `type: array` output-schema properties, so this seat ships WITHOUT the `cwe` field (no CWE ids in its findings). kimi alone keeps `cwe` |

### Parked (disabled until their route/policy situation changes)

| Seat | Model | Why parked |
|---|---|---|
| `rev-sec-glm` | `openrouter/z-ai/glm-5.3` | **Not yet on OpenRouter** (listed models stop at `glm-5.2`); enable only after route check |
| `rev-quorum-a` | `openrouter/deepseek/deepseek-v4-pro-0813` | 404 route block ("guardrail restrictions and data policy") on this account |
| `rev-quorum-e` | `openrouter/qwen/qwen3.8-max` | Flaps: routed cleanly after a policy tweak, then blocked again |

**Enable / change a model:**

1. Edit `skills/<skill>/agents/rev-*.md` (your local clone; `git pull` elsewhere)
2. Set `model:` to the desired ID (e.g. `openrouter/qwen/qwen3.8-max`)
3. Add or delete the `disable: true` line
4. Add/remove seats freely (right family prefix, e.g. `rev-sec-f.md`) — nothing else changes
5. Re-run `./install.sh` to deploy (editing the repo file alone does NOT touch the live
   OMP agents dir)

**Validate a seat actually routes** (5–15 s, in any OMP session): spawn the seat with a
minimal task ("reply exactly OK, no tools"). Success = structured verdict returned. A
`404 … guardrail restrictions and data policy` = blocked at the OpenRouter account level —
fix on openrouter.ai/settings/privacy, not in this repo.

### ⚠️ Known account/policy behavior (documented from live testing)

- The same 404 blocks specific **vendors** (deepseek; qwen flapped per policy changes) while
  leaving others (z-ai, x-ai, Google, Anthropic, Alibaba, Moonshot, NVIDIA) routable. NVIDIA
  was blocked 2026-08-14 but routes cleanly as of 2026-08-16 — vendor policy churn goes both ways.
- It is account/gateway policy, not a repo bug. The skill degrades gracefully: failed seats
  are reported, denominators become `n/<active>`, and the report still prints.
- Observed yield quirks: seed-1.6-flash returned verdicts without populating `findings`
  (documented in both SKILL.md files); kimi-k3 did the same until its seat-prompt hardening
  on 2026-08-14 — current kimi output is full structured findings.

## Security-quorum detection tuning

The security seats' `<detection-criteria>` section is the detection model. V1 was distilled
from the generic (non-wallet-specific) classes of the security-context audit findings corpus
(`~/repos/work/security-context/audit` + its `known.json` ground truth): weak-crypto,
secret-handling, input-validation, integrity/spoofing, fail-open/entropy, supply-chain,
concurrency, fee/amount manipulation. Iterate there as real runs surface misses — keep the
criteria generic (framework- and product-agnostic), then re-run `./install.sh`.

## Troubleshooting

| Symptom | Cause → Fix |
|---|---|
| Seat fails with `404 No endpoints available...` | Account policy: disable or swap the seat (above) |
| Seat fails with `400 Provider returned error` (empty body) | Usually a provider-side route flake (transient, aggravated by concurrency — retry solo). But if it persists solo while another seat on the SAME model succeeds, suspect the seat's output schema: an array-typed property (e.g. `cwe`) 400s the Gemini provider — remove the field from that seat (see rev-sec-gem, fixed 2026-08-16) |
| `packet.mjs` "no VCS detected" | Not a git/jj repo → pass `--files <paths>` |
| Dedupe reports a phantom reviewer | `--dir` scanned stale files → pass explicit result files, or use `--dir` only on a pristine dir (its own `*.report.json` is excluded) |
| Seat returned verdict but `findings: []` | Verdict-only seat; its explanation still shows in the panel report |
| Panel shows the other skill's seats | Wrong `--prefix` (or seat file named `rev-quorum-*` inside the security family): seat families are strictly prefix-keyed |
| Panel report has no seat files / seat results, or reviews landed on local `scout`/`reviewer` | The orchestrator skipped the protocol and improvised with bundled agents. Re-run per SKILL.md §3: seats only. If it keeps happening, the seat agents are missing → run `install.sh` and check `~/.omp/agent/agents/` |
| Packet stale mid-review | Regenerate the packet before spawning; reviewers read the packet at spawn time |

## Dev / tuning loop

```bash
# after editing any file
node scripts/panel.mjs                         # sanity: general seats visible
node scripts/panel.mjs --prefix rev-sec-       # sanity: security seats visible
node scripts/packet.mjs --focus "x" --files <paths> --out /tmp/packet.md   # smoke
node scripts/dedupe.mjs <results...>           # smoke with synthetic/collected results
./install.sh --dry-run                         # confirm install surface
git add -A && git commit && git push           # ship tuning to other installs
```
