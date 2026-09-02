# Seeded-defect detection benchmark (2026-08-20)

> **Historical calibration record.** The seat names and model routes below (rev-quorum-gem/glm/
> grok/nemo, rev-sec-kimi/glm/grok, OpenRouter/nanogpt) describe the author's panel at the
> time. Since 2026-09-02 the repo ships neutral seats (`rev-quorum-a..d`, `rev-sec-a..c`) and
> model assignments live in each user's OMP config. Use this document for its **method**
> (seeded defects, pre-committed decision rules, per-level sweeps); the numbers apply to those
> models on those routes only.


**Status: first full run EXECUTED 2026-08-20** (33 planned cells + 6 trial cells + 3 retries
= 39 delivered structured results; results and applied decisions in the
[Results section](#results-2026-08-20) at the end).
The protocol below is unchanged from the pre-run commit — decision rules were written and
committed before any run, and were applied as written.

## Purpose

Every `thinking-level` pin in this repo was calibrated on ONE clean diff (Flint BTCPay PR16,
see [`docs/thinking-levels.md`](thinking-levels.md)). A clean diff can only measure
**explanation completeness, diligence, and grounding** — there is nothing to detect. The one
detection datapoint we have (the glm-5.3 security sweep, 2026-08-19, one real defect) showed
**detection is non-monotonic in thinking level**: `minimal` and `xhigh` caught the defect at
full severity, `high` downgraded it to P3, `medium` found a different real nit and missed it,
`low` found nothing. Completeness ≠ detection, and the completeness curve cannot be used to
justify a cost cut.

This benchmark exists to settle the cost questions that only defective samples can answer:

| Open question | Current pin | Candidate | Gated on |
|---|---|---|---|
| `rev-quorum-grok` grok-4.6 | `medium` | `low` | 4→5/9 completeness gain from low→medium may be noise; low is 1m02 vs 5m22 |
| `rev-sec-kimi` kimi-k3 | `max` | `high` | `max` is the deepest *explanation* (7/9); never tested for detection |
| `rev-sec-gem` gemini-3.7-flash | `high` | cut the seat | 5/9 max coverage, ~45-word explanations, flat uncalibrated confidence — does it ever detect anything the other two sec seats miss? |
| `rev-quorum-glm` / `rev-sec-glm` glm-5.3 | `medium` / `xhigh` | re-validate | both pins assume the clean-sample curve transfers to buggy samples |

## Sample set

All four packets are built from the **same scratch worktree as `docs/thinking-levels.md`**:
`4be5ef9` + PR16 (sweep-transaction labeler + deposits-behind-Advanced UI move, 20 files /
~270 insertions). Same `packet.mjs`, same focus text, so results are comparable to the
2026-08-18/19 sweeps.

- **S0 — clean control.** The diff as-is. Completeness only; reuse the existing 9 subclaims
  and scoring from `docs/thinking-levels.md`. Also the **pure false-positive sample**: every
  finding on S0 is an FP.
- **S1 — real defect (no seeding).** Already present on the diff:
  `BTCPayWalletSweepTransactionLabeler.LabelAsync` writes a provider-supplied sweep txid into
  the store's wallet as a labelled wallet-object behind only a null/empty check — no 64-char
  hex validation — while the plugin already validates the same class of externally-supplied
  32-byte ids in `SparkLightningClient.NormaliseHash` (`SparkLightningClient.cs:1035-1049`).
  Ground truth: class **input-validation / integrity**, fair severity **P2**
  (defense-in-depth; the provider already controls the swept funds). This is the defect
  glm-5.3 discriminated on, so S1 is the one sample with a prior.
- **S2 — seeded fail-open.** Wrap a security-relevant check on the labeler path in a
  `try`/`catch` that swallows the exception and continues with a default/success value — e.g.
  a catch around the txid/wallet-object lookup that returns success instead of propagating,
  so a failed lookup reads as a passed check. Ground truth: class **fail-open**, fair
  severity **P1–P2**.
- **S3 — seeded cross-boundary silent drop.** Add a new enum variant / message type on a
  producing side of the plugin and leave the consuming `switch`/dispatch without a branch, so
  the new case silently no-ops (no throw, no log, no default). Ground truth: class
  **logic / api-contract**, fair severity **P1–P2**. This targets the standard seats'
  `<cross-boundary>` instruction (`rev-quorum-*.md:97-104`) directly.

**Seed patches are artifacts, not improvisation.** On first build, commit each as a patch file
under `bench/` in the scratch worktree (`bench/S2-fail-open.patch`, `bench/S3-silent-drop.patch`)
so every later run is reproducible against the identical text. Constraints: **≤15 lines**
each, idiomatic C# for this codebase, and **no comments, names, or TODOs that hint at the
bug** — a seed that announces itself measures nothing.

## Run matrix

Per panel, per sample: **every ACTIVE seat at its CURRENT pinned level, plus one level DOWN**,
one run per seat × level × sample. Plus the two explicit cost candidates: grok-4.6 at `low`
and kimi-k3 at `high` (these coincide with "one down" as pinned today, but pin them explicitly
so the comparison survives a re-pin).

- **Standard seats** (`panel.mjs`) on **S0, S2, S3** via the standard packet.
- **Security seats** (`panel.mjs --prefix rev-sec-`) on **S0, S1, S2** via the security
  packet, with the attacker model named in the focus (same wording as the 2026-08-19 sweep:
  malicious/compromised sweep provider supplying the txid).

Run count = `Σ_seats (levels_for_seat × samples_for_that_seat's_panel)`. Do not hardcode a
total — panels change (`panel.mjs` is the only source of seat truth, per AGENTS.md
invariant 1). Levels below a model's floor (`minimal` for glm/nemo, `low` for gem/grok/kimi)
collapse to one level for that seat.

## Scoring

Per run, four axes:

1. **Detection** — did the seat report the ground-truth defect? Match on title semantics **and**
   location (file + symbol). Record: hit/miss, reported priority **vs fair severity**, and
   reported confidence. A hit at P3 on a P1 defect is a *severity miss*, scored separately from
   a detection miss.
2. **False positives** — count of findings not in ground truth. S0 gives the clean FP rate;
   this matters now that `<exclusions>` blocks were added to the security seats (2026-08-20)
   and their effect on FP volume is unmeasured.
3. **Cost proxies** — tool calls, thinking chars, wall time, transcript-measured exactly as in
   `docs/thinking-levels.md` (per-run `thinking_level_change` records).
4. **Verdict correctness** — S0 ⇒ `correct` expected; S1/S2/S3 ⇒ `incorrect` expected. A
   `correct` verdict on a defective sample is a miss even if the finding list mentions the area.

## Decision rules (pre-committed)

Written before any run, to block post-hoc rationalization:

- **A level downgrade is approved iff** detection recall at the lower level **equals** the
  current pin's on **ALL** defective samples in that panel, **AND** fair severity is preserved
  (no P1→P3 severity collapse on a hit). S0 completeness may drop by **≤1/9**. Any recall loss,
  any severity collapse, or >1/9 completeness loss ⇒ the pin stands.
- **A seat is cut only if** it detects nothing any other seat in its panel misses across all
  its samples, **AND** its corroboration never changed a consensus outcome (i.e. removing it
  would not have dropped any finding below the ≥2-seat corroboration bar in `dedupe.mjs`).
  Cheapness is not a reason to cut; redundancy is.
- **Ties go to the incumbent pin.** n=1 per cell (below) is not enough to overturn a pin on a
  wash.
- Any approved change requires, per repo convention: edit the seat file's frontmatter, update
  `README.md` + `AGENTS.md` + `docs/thinking-levels.md` (and this file's result section), then
  **re-run `./install.sh`** — editing the repo alone does not touch the live OMP agents dir.

## Procedure

1. In the scratch worktree at `4be5ef9`+PR16: for each sample, `git apply bench/<sample>.patch`
   (none for S0/S1) → build both packets with `packet.mjs` → **revert the patch**. Never build
   two samples from one dirty tree.
2. Build packets per sample to distinct paths, e.g. `/tmp/pkts/<sample>-quorum-packet.md` and
   `/tmp/pkts/<sample>-sec-packet.md`. Regenerate before spawning — seats read the packet at
   spawn time.
3. Spawn via the normal skill protocol, **seats only** (exact `rev-*` agent names; never
   `scout`/`reviewer`/`task` substitutes). **One seat at a time (solo)**, not the usual parallel
   batch — the 402 flap documented in `docs/thinking-levels.md` is aggravated by concurrency and
   this is a measurement run, not a review.
4. Save each structured result to `~/.omp/quorum-bench/<sample>-<seat>-<level>.json`. Keep the
   bench dir separate from `~/.omp/quorum-review/` and `~/.omp/security-quorum/` so `dedupe --dir`
   never scans it.
5. **Record retries and infra failures separately from verdicts**: 402s, `schema_violation`,
   provider policy rejects, runtime exits. Log spawn count per cell; time the successful run.
   Never fabricate or fill in a cell that did not land (AGENTS.md invariant 5).

## Caveats

- **n=1 per cell.** Same limitation as the level sweeps. A single flipped detection is weak
  evidence; that is why the decision rules require *equal* recall rather than "close enough".
- **Author-known defects leak.** S2/S3 are seeded by us. If the session that seeds also
  orchestrates the runs, the focus text and packet framing can telegraph the bug — **seed in
  one session, review in a separate one**, and keep the focus text identical across samples.
- **S1 has a prior.** glm-5.3 has already been run against it; its S1 results are not blind.
- **Flint-specific.** One C#/BTCPay-plugin diff. Detection behavior may not transfer to other
  languages, stacks, or diff shapes.
- **Three defects is a smoke test, not a proof.** It can show a level is *worse*; it cannot
  show a level is *safe*. Treat an approved downgrade as provisional and revisit when a real
  review misses something.

---

# Results (2026-08-20)

First full run. 33 planned cells + 3 retries + 6 trial cells (grok security candidate, gem
pooled passes). Packets: standard ~33 KB, security ~33 KB, `--budget 300000` (nothing
dropped). All spawns solo via `omp -p` from the scratch worktree; raw results in
`~/.omp/quorum-bench/`. Wall times below are end-to-end per spawn (orchestrating session
included) — treat as relative, not absolute.

## Standard panel (S0 clean / S2 fail-open / S3 silent drop)

| seat×level | S0 verdict (FPs) | S2 detection | S3 detection | times |
|---|---|---|---|---|
| gem medium (pin) | correct (0) | **miss** (correct @1.0) | **miss** (correct @1.0) | 121s/43s/39s |
| gem low | correct (0) | miss | miss | 85s/78s/52s |
| glm medium (pin) | correct (0) | **HIT P2**, incorrect @.75 | **HIT P2** (verdict correct) | 239s/172s/286s |
| glm low | correct (0) | HIT P2, incorrect @.8 | HIT but **P3** (severity drop) | 217s/396s/200s |
| grok medium (pin) | correct (0)† | **HIT P1**, incorrect @.9† | miss | 236s†/247s†/989s |
| grok low | correct (0) | **verdict-only**: incorrect @1.0, **zero findings** | miss | 71s/169s/88s |
| nemo minimal (pin) | correct (0) | miss (correct @1.0) | miss | 385s/302s/148s |

† retry after transient x-ai failures (capacity 429-class error on S0; 25-min timeout on S2).

## Security panel (S0/S1 clean tree — one run scored two ways / S2 fail-open)

S1 detection = the real txid-validation defect; S2 has two true defects (the seeded
fail-open + the same txid defect).

| seat×level | S1 txid | S2 fail-open | S2 txid | FPs (all runs) | times |
|---|---|---|---|---|---|
| kimi max (pin) | **HIT P1** @.7‡ | **HIT P2** @.85 | HIT P1 @.85 | 0 | 479s‡/970s |
| kimi high | HIT P2 @.62 | HIT P2 @.9 | HIT P1 @.75 | 0 | 1394s/1436s |
| glm xhigh (pin) | **HIT P2** @.85 | **HIT P2** @.65 | HIT P1 @.75 | 0 (one dup) | 299s/421s |
| glm high | HIT P2 @.8 | HIT P2 @.6 | HIT P2 @.75 | 0 | 244s/264s |
| gem high (pin) | **miss** (correct @.95) | **miss** (correct @.95) | miss | 0 | 123s/215s |
| gem medium | miss | miss | miss | 0 | 57s/72s |
| gem high ×2 extra pooled passes/sample | miss ×2 | miss ×2 | miss ×2 | 0 | 198–384s |
| **grok medium (trial seat)** | **HIT P1** @.84 | **miss** | HIT P1 @.82 | 0 | 310s/302s |

‡ kimi-max's first S1 spawn died on a runtime `exit 1` mid-review (12m in); the one protocol
retry delivered. A second apparent "hang" of the retry was a harness bug, not the model: the
retry script's `omp -p` inherited a heredoc-contaminated stdin and hung at OMP startup
(`readPipedInput`) before any model ran — fixed by `</dev/null` on every scripted spawn. That
attempt does not count against the seat's retry budget.

## Findings

- **Zero false positives in all 39 delivered runs** — first measured evidence
  that the criteria + the new `<exclusions>` blocks hold noise at zero on this codebase.
- **glm-5.3 is the only standard seat that detects.** It caught both seeded defects at both
  levels; `medium` preserved fair severity where `low` dropped S3 to P3. The `medium` pin now
  has detection evidence, not just completeness evidence.
- **grok-4.6 `medium` vs `low` is a real detection gap**: medium produced a structured P1
  fail-open finding; low produced an `incorrect` verdict with an **empty findings list** —
  which never enters consensus clustering. Verdict-only detection is not detection.
- **Both seeded severities need revision.** S3's fair severity is **P2–P3, not P1–P2**:
  nothing produces the seeded `Expired` variant yet, so "sweep stuck forever" is latent —
  glm-low's "unproduced and unhandled" P3 was arguably the most honest read, and the
  `correct` overall verdicts on S3 are defensible rather than misses.
- **gem detects nothing, systematically.** 0 findings across 14 defective-sample runs
  (both panels, both levels, plus a 3-run pool per security sample), while voting `correct`
  at 0.95–1.0 confidence on genuinely defective code. The pooled-cheap-runs hypothesis
  (Aikido) was tested and refuted for this model: the misses are not variance.
- **kimi `max` beat `high` on wall time in every paired run** (479s vs 1394s; 970s vs 1436s)
  with equal-or-better recall and severity — the max→high downgrade's cost motive is
  inverted on current provider routing.
- **grok-4.6 under the security prompt is a different animal than under the standard
  prompt**: as a trial security seat it caught the txid defect on both samples (P1, 0 FPs,
  ~5 min runs) but missed the fail-open; as a standard seat, the reverse. n=1 each — the
  detection-criteria framing plausibly steers what it hunts.

## Decisions applied (2026-08-20, per the pre-committed rules)

| Question | Rule outcome | Applied |
|---|---|---|
| grok `medium`→`low` | REJECTED — unequal recall (low was verdict-only on S2) | `medium` stands |
| kimi `max`→`high` | REJECTED — equal recall but no cost win (max faster in both pairs) | `max` stands |
| rev-sec-gem cut | CUT — 0 detections in 8 defective-sample runs incl. 3-run pools; corroboration never formed; actively wrong verdicts at .95+ | parked (`disable: true`) |
| glm-sec `xhigh`→`high` (implicit one-down cell) | REJECTED — equal recall, but 2/9 completeness drop (2026-08-19 data) exceeds the ≤1/9 clause | `xhigh` stands |
| glm-std / glm-sec re-validation | CONFIRMED with detection evidence | pins stand |
| **rev-sec-grok** (new seat, not in the pre-committed table) | Judgment call, not rule-driven: met half the stated bar (txid 2/2 at P1, fail-open 0/1) but is strictly superior to the seat it replaces and restores the 3-seat/3-vendor panel | **added, active, `medium`** — re-test the fail-open miss next iteration |

## New open questions (next iteration)

- **rev-quorum-gem earns nothing on this benchmark** (0 detections at both levels, wrong
  verdicts at 1.0 confidence on defective samples). It satisfies the cut rule's necessary
  condition; kept for now as a ~free 4th vendor vote, but it is the standing cut candidate.
- **rev-quorum-nemo detected nothing** (S2/S3 both missed at its only level). Same question.
- **rev-sec-grok's fail-open miss**: one sample; re-run S2 (and a new fail-open variant)
  before trusting it on that class. Consider testing grok-sec at `high`.
- S3 sample should either gain a producer (so the drop is live, severity P1–P2 honest) or
  its ground truth stays P2–P3.

---

# Iteration 2 — ansible stack (protocol pre-committed 2026-08-20, runs pending)

**Question under test:** do `rev-quorum-gem` and `rev-quorum-nemo` earn their standard-panel
seats? Both detected nothing on any Flint defective sample; iteration 2 removes the two
strongest excuses — stack specificity (C#/BTCPay → ansible/YAML infra) and diff size (~33 KB
→ ~2 KB: a 3-file, ~20-line change is the easiest detection surface a seat will ever get).
`glm` and `grok` run the same cells as detectability controls.

## Sample set

Base: scratch worktree of `~/repos/work/ansible` at `dd6c9bd^1` with the PR #80 diff applied
uncommitted (gha-deploy drops passwordless sudo; new `cakepay-backend.yaml` playbook chowns
`/opt/cakepay` to gha-deploy). Seeds are one-line edits to the new playbook, stored as
`bench/A1-ignore-errors.patch` and `bench/A2-undefined-when.patch`.

- **A0 — clean control.** PR80 as-is. FP control + verdict (`correct` expected).
- **A1 — seeded fail-open.** `ignore_errors: yes` on the chown task: a failed ownership
  handover reports play success while the standing sudo grant is already gone — deploys
  break silently. Class error-handling/fail-open, fair severity **P1–P2**.
- **A2 — seeded silent skip.** `when: cakepay_deploy_user is defined` on the chown task; the
  variable is defined nowhere in the repo (verified by grep across yaml/yml/cfg), so the
  play's only task silently skips every run — the playbook is a green no-op and the sudo
  grant it replaces is already gone. Detecting it requires the cross-file check (is the var
  defined in inventory/group_vars/host_vars/vars?). Class logic/config, fair severity
  **P1–P2**.

## Run matrix

All four ACTIVE standard seats at their PINNED levels only (the question is seat value, not
level): gem `medium`, glm `medium`, grok `medium`, nemo `minimal` × A0/A1/A2 = 12 cells.
Standard packet, identical focus/summary across samples, solo spawns, one protocol retry for
transient infra failures.

## Decision rule (pre-committed)

- A standard seat is **parked** iff, across BOTH iterations' defective samples (Flint S2/S3 +
  ansible A1/A2), it detected nothing that entered consensus clustering (verdict-only counts
  as nothing), **while ≥2 other seats detected on the same samples** (detectability proven),
  **AND** its corroboration never changed a consensus outcome.
- Park, don't delete: seat files stay with `disable: true` (the `rev-sec-gem` precedent) so
  re-enabling on a future model version is one line + reinstall.
- If the CONTROLS also miss a sample, that sample is discarded as too hard and decides
  nothing.
- Ties/partial evidence → the seat stays active (incumbent rule).

## Iteration 2 — Results (2026-08-20)

12/12 cells delivered first-try (ansible packet ~2.3 KB; runs 59s–460s). Raw results:
`~/.omp/quorum-bench/a[012]-*.json`.

**Ground-truth revision discovered mid-scoring:** A0 was not clean. The PR80 diff itself
carries a real, unseeded defect (call it **AR**): removing `use_sudo`/`use_sudo_nopass` from
a `user_state: present` user never revokes the existing `/etc/sudoers` NOPASSWD line — the
repo's own documented revocation path (`tasks/offboard_users.yml` + the users.yaml comments)
fires only for tombstones carrying `use_sudo: false`, and gha-deploy has none. The standing
sudo grant PR80 exists to drop survives on every already-provisioned host. AR is present in
all three samples; it was detected only on the A2 runs.

| seat (pin) | A0 verdict / FPs | A1 `ignore_errors` | A2 undefined `when` | AR sudoers gap |
|---|---|---|---|---|
| gem medium | **false alarm**: incorrect @.95, P1 "add state: directory" — empirically refuted (ansible-core 2.21.3 succeeds on an existing dir; advisory only for absent-path hosts) | **miss** | **HIT P0** @1.0, incorrect | miss |
| glm medium | correct; 2 advisory FPs (run-order doc P2, README P3) | finding **HIT P2** @.85, verdict `correct` (verdict miss) | **HIT P0** @.9, incorrect | **HIT P0** @.9 (A2 run) |
| grok medium | correct, 0 FP | **HIT P1** @.93, incorrect | **HIT P0** @.95, incorrect | miss |
| nemo minimal | correct, 0 FP | **miss** | **HIT P2** @.95, incorrect | **HIT P2** @.85 (A2 run) — corroborates glm, 2/4 |

## Iteration 2 — Findings

- **The Flint result did not transfer.** On a small infra diff, every seat detected A2 —
  including gem (P0 @1.0) and nemo (P2, plus corroborating the real AR defect). The
  Flint-iteration zero-detection pattern for gem/nemo was depth/stack-specific, not a
  property of the models.
- **The panel found a real security gap in merged work** (AR): glm + nemo corroborated it at
  2/4. Without nemo it is a single-seat finding — exactly the corroboration value the cut
  rule protects.
- **grok was the only seat to fully catch A1** (P1, incorrect); glm found the finding but
  called the overall verdict `correct`; gem and nemo missed it. gem's A1 miss sits oddly
  against its A0 false alarm on the very same task block — variance, not diligence.
- **gem produced the sweep's only wrong verdict on a clean-ish sample** (incorrect @.95 on
  A0 for an empirically-refuted P1). Its flat high confidence remains uncalibrated in both
  directions.
- Advisory-grade FPs appeared for the first time (glm's doc/run-order notes) — small-diff
  reviews invite process nits. Still zero FPs from grok/nemo across both iterations.

## Iteration 2 — Decision (per the pre-committed rule)

Both seats **stay active**: gem detected A2 with a consensus-eligible P0; nemo detected A2
and corroborated AR. The park condition ("nothing across BOTH iterations' defective
samples") is not met for either. No seat file changes; no pin changes.

Standing watch items: gem's verdict reliability (false alarm on A0, `correct` on defective
Flint samples at 1.0) argues for continuing to weight gem's *verdict* lightly even when its
findings corroborate; nemo remains detection-weak on error-handling classes (missed both
fail-opens). Next iteration should include a third stack and a severity-calibration sample.
