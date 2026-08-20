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
   `--limit`; `packet.mjs` extras added 2026-08-20: `--budget`, `--all-files`; `panel.mjs`
   extras: `--prefix`, `--agents-dir`).
4. **Degraded panels are correct behavior, not errors.** Seats fail all the time on model
   route/policy churn. Report which seats ran (denominators are `n/<active>`); never hide a
   failed seat, never silently run a bigger/smaller panel than configured.
5. **Never fabricate reviewer output.** Unparseable/verdict-only seats are recorded as-is.
6. **One retry max per seat per run** (added 2026-08-20). A transient failure (400 empty body,
   402, timeout) earns exactly one solo re-spawn — outside the batch, since concurrency
   aggravates the flake. A second failure is a failed seat. Never a third attempt, never a
   substitute agent. Bounds the observed 402-flap waste (~9 wasted spawns in the 2026-08-19
   glm sweep).
7. **Arbitration is bounded** (added 2026-08-20). At most ONE round per review, triggered only
   by a verdict split or an uncorroborated P0 (P0/P1 for security). Contested findings only;
   the mini-packet is **anonymized** (seat/model names → "Reviewer 1..N") so arbitrators judge
   the code, not the model's reputation. ≥2 AGREE ⇒ corroborated; majority DISAGREE ⇒
   "disputed — rejected in arbitration", still shown in the summary. Never a second round,
   never for P2/P3 single-seat findings.
8. **Fix verification is reporter-only by default** (added 2026-08-20). A small packet scoped
   to the fix (`--focus "verify fix of: …"`, original finding in `--summary`, lowered
   `--budget`) goes to just the seats that reported it. Full-panel re-runs only for
   large/risky fixes or on user request.
9. **Packet budget default is 300000 bytes** (`--budget`, `0` disables). Over budget, the
   largest patches are dropped with a "read the file directly" note — dropped, never silently
   truncated, and always still listed in the changed-files table.
10. **`category` values must stay in sync** between the seat schemas and what `dedupe.mjs`
    expects. Quorum seats: logic, concurrency, api-contract, data-handling, error-handling,
    test-gap, perf, other. Security seats: weak-crypto, secret-handling, input-validation,
    integrity-spoofing, fail-open, supply-chain, concurrency, fee-amount, other. Adding a
    value to a seat without teaching dedupe about it silently degrades clustering (unknown
    categories stop strengthening clusters and fall back to exact-title matching).

## Model panel intel (as committed)

- quorum-review active: `rev-quorum-gem` = gemini-3.7-flash (route-checked clean 2026-08-13),
  `rev-quorum-glm` = glm-5.3 (swapped from glm-5.2 2026-08-19 after glm-5.3 hit OpenRouter;
  route-checked clean same day), `rev-quorum-grok` = grok-4.6 (all reliable structured
  findings), `rev-quorum-nemo` = nvidia nemotron-3.5-lightning (route-checked clean
  2026-08-16; cheap, all live endpoints ≥256K ctx fit packets).
- security-quorum active: `rev-sec-kimi` = kimi-k3 (route-checked clean 2026-08-14;
  structured-findings behavior re-confirmed 2026-08-16 — was historically verdict-only),
  `rev-sec-gem` = gemini-3.7-flash (route-checked clean 2026-08-16), `rev-sec-glm` = glm-5.3
  (route-checked clean 2026-08-19). All three carry `cwe` again as of 2026-08-20 in the
  comma-separated **string** form (see the cwe gotcha below) — **not yet route-checked in that
  form**.
- All seats (both families) carry, as of 2026-08-20 and pending live route-check: the hardened
  one-finding-per-yield output contract (propagated from `rev-sec-kimi`), a prompt-injection
  guard line in the intro, and an optional `category` finding field. Security seats additionally
  carry an `<exclusions>` noise-suppression block (no DoS/rate-limit/resource-exhaustion
  without a concrete security consequence, no generic input validation without a proven
  source→sink impact, no non-auth open redirects, no theoretical timing channels, no
  non-introduced dependency vulns, no attacker-path-free hardening preferences) — each class
  overridable when the run's `--focus` names it.

## Thinking levels (pinned 2026-08-18)

Each active seat pins `thinking-level:` in its frontmatter. Calibrated 2026-08-18 by running
every model at every supported level against one controlled diff (Flint PR16 — sweep
labeler + deposit-UI move); full methodology and per-level data in
`docs/thinking-levels.md`. Summary:

- `rev-quorum-gem` gemini-3.7-flash → `medium` (upstream default; high adds tools, not coverage)
- `rev-quorum-glm` glm-5.3 → `medium` (downgraded from the glm-5.2-era high 2026-08-19:
  at 5.3, medium matches high's 9/9 completeness at ~1/5 the wall time; high's only unique
  output was one P3 test-enumeration nit)
- `rev-quorum-grok` grok-4.6 → `medium` (downgraded from default high: high/xhigh add 2.5–13×
  time for ≤1/9 completeness on a clean sample; xhigh's code-review boost was NOT observed —
  re-test with a buggy sample before re-raising)
- `rev-quorum-nemo` nemotron-3.5-lightning → `minimal` (its best coverage at ~1/6 of high's time;
  "minimal" still reasons — not off)
- `rev-sec-gem` gemini-3.7-flash → `high` (upgraded from default medium; low was 2/9 coverage
  in 10 s — too shallow for a security seat)
- `rev-sec-glm` glm-5.3 → `xhigh` (new seat, pinned 2026-08-19 — deep detection is the lever
  for a security seat: on the Flint benchmark only xhigh caught the one real defect at full
  severity with the strongest evidence; low-effort runs at ~8 tools were a detection coin-flip)
- `rev-sec-kimi` kimi-k3 → `max` (upstream default; deepest security explanations)

Effort measures (tool calls, thinking-token volume, wall time) rise monotonically with level
on every model; completeness does not always follow. See `docs/thinking-levels.md` for the
per-level evidence table before changing any pinned level.

Open level questions, **pending the seeded-defect detection benchmark in
`docs/benchmark.md`** (the thinking-level sweeps used a clean sample, so they measured
explanation completeness, not detection recall): `rev-quorum-grok` medium→**low** (its coverage
barely moved 4→5→4→5 across low→xhigh while tool calls went 20→92) and `rev-sec-kimi`
max→**high** (6/9 at high vs 7/9 at max, at half the wall time). Neither is applied — the seats
still pin `medium` and `max`. Do not change them without detection data.

## More panel intel

- quorum-review parked (disabled seats, do not enable without a route check):
  deepseek-v4-pro-0813 (blocked), qwen3.8-max (flapping).
- `z-ai/glm-5.3` is published on OpenRouter (2026-08-19; 1M ctx, 131k max output, ~45% pricier
  output than glm-5.2). The older "not yet published" parking note for `rev-sec-glm` is stale —
  the seat is now active on glm-5.3.
- `nvidia/nemotron-3.5-lightning` committed as `rev-quorum-nemo` (2026-08-16) using the canonical
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
`rev-sec-*.md` prompts, with the counterpart `<exclusions>` block (added 2026-08-20) holding
the noise classes to suppress — a run's `--focus` overrides an exclusion when it names that
class, so tighten `--focus` before loosening the block. Criteria were distilled from the
generic classes of the security-context audit findings corpus (`~/repos/work/security-context/`): weak-crypto,
secret-handling, input-validation, integrity/spoofing, fail-open/entropy, supply-chain,
concurrency, fee/amount manipulation — wallet-specific chains and Cake-Wallet specifics were
deliberately excluded. Tune there as real runs surface misses, keeping criteria generic
(framework- and product-agnostic); re-run `./install.sh` after editing.

## Gotchas from live runs

- **`cwe` schema shape — the ARRAY form is the trap.** Historical warning, keep it: an
  output-schema property declared `type: array` without `items` (the harness's
  frontmatter→schema converter drops an `items:` key if you try to add one) breaks two
  providers. The OpenRouter Gemini provider 400s ("Provider returned error", empty body) —
  `rev-sec-gem` 400ed persistently on its `cwe` array (2026-08-16). `z-ai/glm-5.3` breaks on
  the same field but surfaces it as a provider **402** at request time ("requires more credits,
  or fewer max_tokens ... can only afford 5976") — looks like a billing error, is actually the
  schema (2026-08-19). Moonshot tolerated the array. **Current state (2026-08-20):** `cwe` is a
  **comma-separated string** (e.g. `"CWE-20, CWE-345"`) on all three security seats — safe on
  every provider, kimi converted array→string for uniformity; **pending live route-check**.
  Never reintroduce the array form; if a security seat starts 400ing or 402ing solo while
  another seat on the same model succeeds, check this field first.
- git status collapses untracked DIRS to `?? dir/` → packet.mjs uses `-uall` + `statSync`
  file guard; never reintroduce naked `readFileSync` over untracked paths. Untracked files are
  embedded **in full** and the packet tells seats not to re-read them from disk — keep those
  two facts together, or seats waste a tool call per file re-reading what they already have.
- Packet omissions are by design and must stay visible: lockfiles/generated files are dropped
  from the embedded diff (not from the changed-files table) unless `--all-files`; deleted
  files' patches are listed by name; over-budget patches are replaced with a "read the file
  directly" note. The last stderr line reports total bytes + omission counts — surface it in
  the report rather than letting a silent omission look like a clean diff. "Deleted" means the
  FILE was deleted (`deleted file mode` marker) — never infer deletion from hunk shape; a
  deletion-only edit to a living file (e.g. a removed validation check) must stay in the packet.
- `dedupe.mjs`'s mean-confidence line is annotated "(unweighted self-reported; not comparable
  across models)" for a reason: gem sits near 1.0 at every depth while glm's confidence *drops*
  as it digs (.90→.55). Never rank findings by that number.
- `dedupe --dir` scans every `.json` (its own `*.report.json` excluded) — pass explicit
  result files for a clean run. Keep the two results dirs (`~/.omp/quorum-review/` vs
  `~/.omp/security-quorum/`) separate.
- Some models (seed-1.6-flash observed; kimi-k3 historically) return verdict + explanation but empty `findings`. Treat as verdict-only; don't rerun seats to "force" structure. kimi-k3's empty-findings behavior was fixed 2026-08-14 by the hardened `rev-sec-kimi` output contract — do not treat current kimi output as verdict-only. That contract now sits in every seat (2026-08-20, pending live validation), so a verdict-only seat should be rarer; it is still recorded as-is, never retried for structure.
- The two skills share one install surface: editing a seat file and NOT re-running
  `./install.sh` means the live OMP agents dir still has the old copy. Reinstall after
  every seat/prompt change.
