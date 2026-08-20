# Seeded-defect detection benchmark (2026-08-20)

**Status: protocol defined, runs NOT executed.** Nothing below is a result. No numbers in
this document are measurements.

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
