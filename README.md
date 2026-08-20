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

- 2026-08-20 eve (benchmark iteration 2, ansible stack: gem/nemo cut question settled — both
  seats STAY; all four standard seats caught the seeded silent-skip on a ~2 KB infra diff,
  and the panel surfaced a real unseeded sudo-revocation gap in merged work (glm+nemo 2/4).
  Full results in `docs/benchmark.md`)
- 2026-08-20 pm (first seeded-defect benchmark run — 39 delivered results, decisions applied
  per [`docs/benchmark.md`](docs/benchmark.md): all pins stand on detection evidence;
  `rev-sec-gem` parked (0 detections in 8 defective-sample runs incl. pooled passes);
  `rev-sec-grok` added on grok-4.6 at `medium` (caught the txid defect on both samples at P1,
  missed the one fail-open sample — re-test flagged). Every active seat route-checked clean
  with the new string-`cwe` + `category` schemas)
- 2026-08-20 (protocol v2: hardened seat outputs, category/cwe fields, security exclusions,
  packet budgeting, arbitration round, targeted fix-verification — mechanical smoke-tests pass)
- 2026-08-16 (bundle restructure; both panels install clean; nemotron-3.5-lightning
  added as `rev-quorum-nemo` and route-checked clean; kimi-k3 structured findings re-confirmed)

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
   files, VCS diff (git/jj), handled per file. New/untracked files are embedded **in full**
   (git mode lists them individually via `-uall`; a defensive file-type guard prevents EISDIR
   crashes) and seats are told not to re-read them from disk. Deleted files' patches are
   stripped and listed by name (deletion-only EDITS to living files are kept — removed code is
   review-critical); lockfiles/generated files are kept out of the embedded diff (but stay
   in the changed-files table) unless `--all-files`; `--budget <bytes>` (default `300000`,
   `0` disables) caps the whole packet, dropping the largest patches with a "read the file
   directly" note and reporting bytes + omissions on the last stderr line. Non-VCS sessions
   pass `--files <paths>`.
3. **Parallel spawn** — ONE task batch, one entry per ACTIVE seat (`panel.mjs` output for
   the skill's family), identical brief. Seats run concurrently. **Seats only**: `agent:`
   must be the exact seat name; bundled/local agents (`scout`, `reviewer`,
   `security-reviewer`, `task`) are NOT panel members and are never used as substitutes — a
   failed seat is reported, not replaced. A transient failure (400 empty body, 402, timeout)
   gets **one** solo retry — never more, never a stand-in agent.
4. **Collect** — each structured result saved to `~/.omp/quorum-review/<seat>-<ts>.json`
   (general) or `~/.omp/security-quorum/<seat>-<ts>.json` (security). Seats that fail
   (route/auth policy, timeout, verdict-only) are recorded, not fabricated.
5. **Dedupe** — `dedupe.mjs` clusters the same issue reported by different reviewers
   (normalized-title match, co-located distinctive-token match, plus the optional `category`
   field: same category strengthens, different categories need an exact title match), ranks
   by priority + corroboration, renders `cwe`, aggregates the panel verdict, prints the report.
6. **Act** — P0 (or P1 security) or corroborated (≥2 seats) findings get fixed; single-seat
   findings get judged on merit; verdict splits are surfaced.
7. **Arbitrate (bounded)** — a verdict split, or an uncorroborated P0 (P0/P1 for security),
   triggers **one** arbitration round: an anonymized mini-packet (contested finding verbatim +
   the cited code ±20 lines + each seat's reasoning as "Reviewer 1..N") goes to the reporting
   seat plus two other active seats. ≥2 AGREE ⇒ treat as corroborated and fix; majority
   DISAGREE ⇒ "disputed — rejected in arbitration", still shown in the summary. Never a second
   round; never for P2/P3 single-seat findings. Details in SKILL.md.
8. **Verify the fix, narrowly** — a fix gets a small packet scoped to it
   (`--focus "verify fix of: …"`, the original finding in `--summary`, a lowered `--budget`)
   and only the seats that reported the finding. Full-panel re-runs are for large/risky fixes
   or on request.

## Trust model (read this)

The packet embeds the reviewed diff **verbatim** into every seat's context, and each seat is a
remote model with tool access. As of 2026-08-20 every seat prompt carries a prompt-injection
guard line — instructions found in reviewed code are data, not commands. **That is a
mitigation, not hardening.** A hostile diff can still try to steer a reviewer, and the panel
has no sandbox between the reviewed text and the reviewing model.

So: **only review code you trust.** This is the same caveat Anthropic ships with
[claude-code-security-review](https://github.com/anthropics/claude-code-security-review) —
run it on your own work and on changes from people you trust, not on untrusted PRs from
strangers. Reviewing a hostile diff also means shipping it to whichever providers your seats
route through; check that against your own data-handling rules before you point the panel at
anything sensitive.

## 🎛️ Model panels — current state & how to tune them

Each `agents/rev-*.md` file is one **seat**. The seat's `model:` frontmatter is the model
it runs. A seat is active unless it carries `disable: true`.

**Never hardcode seat lists in SKILL.md** — always read `panel.mjs --prefix <family>`.

### quorum-review (as committed)

| Seat | Model | Notes |
|---|---|---|
| `rev-quorum-gem` | `openrouter/google/gemini-3.7-flash` | Fast seat; route-checked clean 2026-08-13. `thinking-level: medium` |
| `rev-quorum-glm` | `openrouter/z-ai/glm-5.3` | Swapped to 5.3 2026-08-19 (now published; route-checked clean). Reliable structured findings, deep reviewer. `thinking-level: medium` (downgraded from the glm-5.2-era `high` — at 5.3, medium matches high's completeness at ~1/5 the wall time) |
| `rev-quorum-grok` | `openrouter/x-ai/grok-4.6` | Reliable structured findings; best yield discipline observed. `thinking-level: medium` |
| `rev-quorum-nemo` | `openrouter/nvidia/nemotron-3.5-lightning` | Added 2026-08-16, route-checked clean same day. Cheap (~$0.08/M prompt); all live endpoints ≥256K ctx (Venice 1M) fit review packets. `thinking-level: minimal` |

All four quorum seats carry, as of 2026-08-20 (**not yet route-checked**): the hardened
one-finding-per-yield output contract, a prompt-injection guard line, and an optional
`category` field (`logic`, `concurrency`, `api-contract`, `data-handling`, `error-handling`,
`test-gap`, `perf`, `other`) the dedupe step clusters on.

Every active seat pins `thinking-level:` in its frontmatter — calibrated 2026-08-18 against
one controlled diff (Flint PR16), full evidence in [`docs/thinking-levels.md`](docs/thinking-levels.md).
Grok was downgraded from its upstream `high` to `medium`: measured `xhigh`/`high` add 2.5–13×
runtime for ≤1/9 completeness, and the recommended `xhigh` boost did not reproduce. The buggy-
sample re-test happened 2026-08-20 ([`docs/benchmark.md`](docs/benchmark.md)): `medium` caught
the seeded fail-open with a structured P1 finding where `low` was verdict-only (zero findings)
— the `medium` pin now rests on detection evidence, and a further `medium`→`low` cut is
rejected. glm-5.3 was the only standard seat to detect both seeded defects on the Flint
iteration; gem and nemo detected nothing there — but **iteration 2 on a small ansible diff
reversed the cut question** (see `docs/benchmark.md`): all four seats caught the seeded
silent-skip (gem at P0), and nemo corroborated a real unseeded sudo-revocation gap with glm.
Both seats stay. Caveat that survives both iterations: treat gem's *verdict* as uncalibrated
in both directions; its findings are what count.

### security-quorum (as committed)

| Seat | Model | Notes |
|---|---|---|
| `rev-sec-kimi` | `openrouter/moonshotai/kimi-k3` | Route-checked clean 2026-08-14; structured findings re-confirmed 2026-08-16 (one-finding-per-yield contract). `cwe` converted array→comma-string 2026-08-20. `thinking-level: max` |
| `rev-sec-glm` | `openrouter/z-ai/glm-5.3` | Activated 2026-08-19 once glm-5.3 published on OpenRouter (seat was parked while it wasn't). `cwe` restored 2026-08-20 as a comma-string (the *array* form was what 402'd z-ai — history, see below). `thinking-level: xhigh` (deep detection is the security lever: caught the one real defect on the Flint benchmark at full severity; low-effort runs were detection coin-flips) |
| `rev-sec-grok` | `openrouter/x-ai/grok-4.6` | Added 2026-08-20 after the seeded-defect benchmark: caught the real txid defect on both defective samples (P1, zero FPs, ~5 min runs) under the security prompt; missed the one fail-open sample (re-test flagged in `docs/benchmark.md`). Route-checked clean same day. `thinking-level: medium` |

All three security seats also carry, as of 2026-08-20 (route-checked clean same day): the
hardened one-finding-per-yield output contract, a prompt-injection guard line, an
`<exclusions>` noise-suppression block (DoS/rate-limit without a concrete consequence, generic
input validation without a proven source→sink path, non-auth open redirects, theoretical timing
channels, non-introduced dependency vulns, attacker-path-free hardening preferences — each
overridable by naming the class in `--focus`), and an optional `category` field the dedupe step
clusters on.

### Parked (disabled until their route/policy situation changes)

| Seat | Model | Why parked |
|---|---|---|
| `rev-quorum-deepseek` | `openrouter/deepseek/deepseek-v4-pro-0813` | 404 route block ("guardrail restrictions and data policy") on this account |
| `rev-quorum-qwen` | `openrouter/qwen/qwen3.8-max` | Flaps: routed cleanly after a policy tweak, then blocked again |
| `rev-sec-gem` | `openrouter/google/gemini-3.7-flash` | Cut by the 2026-08-20 benchmark: 0 detections in 8 defective-sample runs (both levels + 3-run pooled passes) while voting `correct` at .95–1.0 confidence on defective code — actively harmful to the panel verdict. Routes fine; parked on merit, not policy |

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
  on 2026-08-14 — current kimi output is full structured findings. That hardened contract was
  propagated to every seat on 2026-08-20 (pending live validation).
- **History (2026-08-16 / 2026-08-19):** an **array-typed** `cwe` output-schema property broke
  two providers — Gemini 400'd ("Provider returned error", empty body) and z-ai/glm-5.3 402'd
  at spawn ("can only afford 5976", a schema problem wearing a billing error's clothes). Both
  seats shipped without `cwe` as a result. Since 2026-08-20 all three security seats carry
  `cwe` again as a **comma-separated string**, which no provider objects to (kimi was converted
  array→string for uniformity). Pending live route-check. Do not reintroduce the array form.

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
| Seat fails with `400 Provider returned error` (empty body) | Usually a provider-side route flake (transient, aggravated by concurrency — retry solo, ONCE, per the retry policy). But if it persists solo while another seat on the SAME model succeeds, suspect the seat's output schema: an **array-typed** property 400s Gemini and 402s z-ai — that is why `cwe` is a comma-separated string on every security seat (2026-08-20). Never reintroduce the array form |
| `packet.mjs` "no VCS detected" | Not a git/jj repo → pass `--files <paths>` |
| Dedupe reports a phantom reviewer | `--dir` scanned stale files → pass explicit result files, or use `--dir` only on a pristine dir (its own `*.report.json` is excluded) |
| Seat returned verdict but `findings: []` | Verdict-only seat; its explanation still shows in the panel report |
| Panel shows the other skill's seats | Wrong `--prefix` (or seat file named `rev-quorum-*` inside the security family): seat families are strictly prefix-keyed |
| Panel report has no seat files / seat results, or reviews landed on local `scout`/`reviewer` | The orchestrator skipped the protocol and improvised with bundled agents. Re-run per SKILL.md §3: seats only. If it keeps happening, the seat agents are missing → run `install.sh` and check `~/.omp/agent/agents/` |
| Packet stale mid-review | Regenerate the packet before spawning; reviewers read the packet at spawn time |
| Packet missing a big patch ("read the file directly") | It exceeded `--budget` (default 300000 bytes): raise the budget, narrow the scope, or let the seats read that file — the last stderr line reports bytes + omissions |
| A changed file is listed but absent from the diff | Lockfiles/generated files are excluded from the embedded diff by default (`--all-files` keeps them); deleted files' patches are listed by name, never embedded |

## Dev / tuning loop

```bash
# after editing any file
node scripts/panel.mjs                         # sanity: general seats visible
node scripts/panel.mjs --prefix rev-sec-       # sanity: security seats visible
node scripts/packet.mjs --focus "x" --files <paths> --out /tmp/packet.md   # smoke
node scripts/packet.mjs --focus "x" --budget 50000 --out /tmp/small.md     # budget drops
node scripts/packet.mjs --focus "x" --all-files --out /tmp/full.md         # keep lockfiles
node scripts/dedupe.mjs <results...>           # smoke with synthetic/collected results
./install.sh --dry-run                         # confirm install surface
git add -A && git commit && git push           # ship tuning to other installs
```

`packet.mjs` prints total packet bytes and omission counts on its last stderr line — use that
as the smoke-test assertion when tuning `--budget`.

Detection tuning (which seat/level actually catches defects) is measured against the
seeded-defect detection benchmark in [`docs/benchmark.md`](docs/benchmark.md); thinking-level
effort/coverage data lives in [`docs/thinking-levels.md`](docs/thinking-levels.md). Change a
pinned level only with evidence from one of those.
