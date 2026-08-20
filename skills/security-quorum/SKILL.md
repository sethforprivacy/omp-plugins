---
name: security-quorum
description: Security-centric panel review. Run a small, focused change or surface past a panel of independent security reviewers (one per remote model, spawned in parallel), then dedupe and rank by consensus. Load whenever the user asks for a "security review", "security pass", "sec review", "security-quorum", "threat check", or wants a focused attack-surface audit of a specific change. Lighter and tighter than quorum-review: designed for one file, one function, one dependency, or one small diff — not whole-session gatekeeping.
panel_prefix: rev-sec-
---

# Security-quorum (focused security review)

Run a **small, focused** change or attack surface past a **panel** of independent security
reviewers (each pinned to a different remote model), spawned in parallel, then dedupe the
findings by consensus and bring the report back **into this session**.

This is the security pass: it exists so a single reviewer — or the author's own bias — never
decides alone whether a change is safe. Scope stays **small and focused on purpose**; if the
scope grows past one surface, split it and run separate passes.

## Active panel — discover dynamically, never hardcode

The panel is defined by `rev-sec-*.md` agent files in `~/.omp/agent/agents/` (the
`rev-sec-` family, separate from the general `rev-quorum-*` panel). Each file is one seat;
its `model:` frontmatter is the model that seat runs. **Never hardcode the seat list or
models in this skill.** Always read the live panel:

```
node ~/.omp/agent/skills/security-quorum/scripts/panel.mjs --prefix rev-sec-
```

Changing the panel = editing those files only:

- **Swap a model:** edit one seat's `model:` line.
- **Add a seat:** copy an existing `rev-sec-*.md`, rename the file + `name:`, set its `model:`.
- **Retire a seat:** delete the file, or set `disable: true` to keep it for re-enabling.
- **Enable a parked seat:** remove `disable: true`, route-check it (§4), then confirm the
  panel with `panel.mjs --prefix rev-sec-`.

Current seat note: `rev-sec-glm` is pinned to `z-ai/glm-5.3` and active since 2026-08-19
(glm-5.3 is published on OpenRouter; the previous "parked until published" note is stale).
`thinking-level: xhigh` (calibrated on the Flint benchmark 2026-08-19).

Seat prompt state as of 2026-08-20 (pending live route-check):

- **`cwe` is back on all three security seats**, as a comma-separated **string**
  (`"CWE-20, CWE-345"`). The old *untyped-array* form is what broke Gemini (400, empty body)
  and z-ai (402 at spawn); the string form is safe on all three providers. `rev-sec-kimi` was
  converted array→string for uniformity.
- Every seat carries an **`<exclusions>` noise-suppression block**: no DoS / rate-limit /
  resource-exhaustion findings without a concrete security consequence; no generic input
  validation without a proven source→sink impact; no open redirects off auth flows; no
  theoretical timing channels; no dependency vulns the diff didn't introduce; no
  attacker-path-free hardening preferences. **The focus overrides an exclusion when it names
  that class explicitly** — say so in `--focus` if you want (e.g.) DoS in scope. An excluded
  class also comes back when it composes with an in-scope class into a concrete exploit path.
- Every seat carries the hardened one-finding-per-yield output contract and a
  prompt-injection guard line in its intro.
- Findings may carry an optional `category`: `weak-crypto`, `secret-handling`,
  `input-validation`, `integrity-spoofing`, `fail-open`, `supply-chain`, `concurrency`,
  `fee-amount`, `other`. `dedupe.mjs` clusters on it.

## When to run

- User asks for a "security review" / "security pass" / "sec review" / "security-quorum" /
  "threat check", or says "is X safe?" about a concrete change.
- Scope: ONE focused surface — a single file, function, dependency, handler, config path,
  or a small diff. If the user names a whole feature or repo, narrow to the risky slice
  (new entry points, new data flows, auth/token/crypto/parsing code) before running.
- Not for whole-repo sweeps: those are `quorum-review` territory or the standalone weekly
  audit prompts.

## Protocol

Follow these steps in order. The scripts hold the deterministic logic; you orchestrate
(the scripts are the shared ones from the quorum-review bundle — same CLI).

### 1. Focus + scope (write it down first)
One to three sentences: WHAT surface is under review, WHO the attacker model is
(untrusted user, remote peer, network service, config/import file, dependency), what "safe /
across the line" means. Pull from the user's stated ask. Scope must be narrow — say so
explicitly if the diff is bigger than one surface.

### 2. Build the context packet
```
node ~/.omp/agent/skills/security-quorum/scripts/packet.mjs \
  --focus "<focus incl. attacker model>" \
  --summary "<3-8 factual bullets: what the change is, trust boundaries, prior findings>" \
  --out /tmp/sec-quorum-packet.md
```
- Auto-detects git/jj and diffs the working tree. Non-VCS cwd: pass `--files <abs paths>`.
- Smaller is better: `--limit` (default 100000) can be lowered to keep the packet tight.
- Put trust-boundary notes in `--summary` — the attacker model is the most important context
  the seats get.
- Packet shaping (added 2026-08-20, pending live validation):
  - `--budget <bytes>` caps the **whole packet** (default `300000`, `0` disables), where
    `--limit` caps a single file section (applied first). A security pass is meant to be
    small — lower both. Over budget, the largest patches are dropped and replaced with a
    "read the file directly" note; the files stay in the changed-files table, and focus,
    summary and omission notes are never dropped.
  - Lockfiles and generated files are excluded from the embedded diff by default (still
    listed). `--all-files` puts them back — do that when the *supply chain* is the surface
    under review, since a lockfile change is exactly the finding you want then.
  - Deleted files' patches are stripped and listed by name (a deletion-only EDIT to a living
    file is kept — a removed check is exactly what a security pass must see).
  - Untracked files arrive **embedded in full**; the packet tells seats not to re-read them.
  - The final stderr line reports total packet bytes and omission counts — check it, and note
    any dropped patch in the report.

### 3. Read the panel and spawn ALL seats in ONE parallel batch
```
node ~/.omp/agent/skills/security-quorum/scripts/panel.mjs --prefix rev-sec-
```

**The panel is the `rev-sec-*` seat agents — nothing else.** Bundled agents (`scout`,
`reviewer`, `security-reviewer`, `task`, `sonic`) run on your local stack and are NOT panel
members; a "panel" of them is not independent. A failed seat is reported, not replaced.

Then one `task` call with one entry per seat — same batch, so they run concurrently:

```
task: Review the security scope described in the packet at /tmp/sec-quorum-packet.md.
      Read the packet, then the files it lists, per your own security reviewer
      instructions. Report only findings you can prove with a source->sink path.
      Evaluate independently — do not assume agreement with other reviewers.
agent: <seat name from panel.mjs>
name:  <seat name>
```

- `agent:` MUST be the exact seat name printed by `panel.mjs --prefix rev-sec-`
  (e.g. `rev-sec-kimi`). Copy it verbatim.
- Do NOT include disabled/no-longer-active seats. Do NOT spawn the same seat twice.
- If a seat fails to spawn (route/auth block, timeout), record the failure per §5 and
  continue with the working seats. Never substitute a bundled/local agent.

**Bounded retry policy** (added 2026-08-20, pending live validation). A seat that fails with a
*transient* error — 400 with an empty body, 402, timeout — is retried **once, solo** (its own
spawn, outside the batch; concurrency aggravates these flakes). A second failure records the
seat as failed for this run. Never more than one retry per seat per run, and never substitute
another agent. This bounds the observed 402-flap waste (the glm-5.3 security sweep needed 6
spawns for one result — see `docs/thinking-levels.md`).

### 4. Route-check before enabling a seat (parked/new models)
1. Edit the seat file: set `model:`, remove `disable: true`.
2. Spawn the seat with a trivial "reply OK" task (5–15 s). A `404 … guardrail restrictions
   and data policy` error means account policy blocks the vendor — leave it disabled.
3. Only then leave it enabled and re-run `panel.mjs --prefix rev-sec-` to confirm.

### 5. Collect results
Save each delivered result to `~/.omp/security-quorum/<seat>-<timestamp>.json` (raw JSON as
delivered). Seats that fail to return JSON (route error, auth/policy block, timeout,
text-only reply) are recorded as failures — save nothing for them.

Verify provenance: the result must be from the `agent` you spawned — the seat name. Any
delivered review from a bundled/local agent is NOT a panel seat: discard it from the panel
set, re-run that seat via the protocol, and note the violation in the report.

Some models return a verdict + explanation but an **empty `findings`**
array. Treat those as verdict-only seats: still save the result (verdict/explanation show
in the report), but their issues don't enter consensus clustering. Don't silently rerun them
for structure — note it and move on.

Note: kimi-k3 was historically verdict-only, but a prompt hardening (2026-08-14 — a
one-finding-per-yield contract in the `rev-sec-kimi` seat `<output>` section) fixed it; it
now yields full structured findings reliably. The old "kimi returns empty findings" intel is
stale — do not re-disable or bypass the seat on that basis. That same contract was propagated
to every seat on 2026-08-20 (pending live validation).

### 6. Dedupe + rank by consensus
```
node ~/.omp/agent/skills/security-quorum/scripts/dedupe.mjs \
  ~/.omp/security-quorum/<seat>-<ts>.json ... [--out ~/.omp/security-quorum/report.md]
```
Clusters the same issue reported by different reviewers; shows `→ n/<total> (seats)`
corroboration, P-priority, confidence; aggregates the panel verdict.

Clustering is category-aware as of 2026-08-20: same `category` strengthens a cluster,
different categories only cluster on an exact title match. `cwe` is rendered per finding. The
mean-confidence line is annotated "(unweighted self-reported; not comparable across models)" —
treat it that way (glm's confidence dropped as depth rose; gem's is flat near 1.0) and never
rank security findings by confidence alone.

### 7. Present and act — in this session, immediately
Show the deduped report, then:

| Finding | Response |
|---|---|
| P0/P1 or corroborated (≥2 seats) | Fix it now, verify, then run the **targeted verify pass** below |
| Single-seat P0/P1 | Not yours to adjudicate alone — send it to the **arbitration round** first |
| Single-seat finding (P2/P3) | Judge on merit (read the cited path yourself); fix if defensible, else note and move on |
| Panel verdict split | Surface it, then run the **arbitration round** (next section) |

**Targeted verify pass** (added 2026-08-20, pending live validation). After fixing a finding,
do NOT re-run the whole panel by default. Instead:

1. Rebuild a SMALL packet scoped to the fix: `--focus "verify fix of: <finding title>"`,
   `--summary` carrying the original finding text and exactly what was changed (keep the
   attacker model in it), and a lowered `--budget`.
2. Spawn **only the seats that reported the finding** (if a reporting seat failed this run,
   substitute the deepest active seat — `rev-sec-kimi` at `max` / `rev-sec-glm` at `xhigh`
   per `docs/thinking-levels.md`).
3. Full-panel re-runs are for large or risky fixes, or when the user asks.

Finish by stating what the panel changed, what you judged and ignored (and why), and the
remaining risk. Bring severity honestly: do not inflate borderline items, and do not bury a
corroborated P1.

## Arbitration round (contested findings)

Added 2026-08-20 (pending live validation). Runs **at most ONCE per review**, and only when
triggered:

- the panel verdict splits (both `correct` and `incorrect` present), **or**
- a **P0 or P1** finding is uncorroborated (1 seat).

Never arbitrate P2/P3 single-seat findings — judge those on merit as before. (The glm-5.3
benchmark's real txid defect was a single-seat P2 that different levels rated P2/P3 or missed
entirely; that is a judgement call, not an arbitration case.)

**1. Build a mini-packet** (a small markdown file, e.g. `/tmp/sec-quorum-arbitration.md`):

- the contested finding(s) **verbatim** — title, body, location;
- the cited code slice, ±20 lines, read from disk (not from memory);
- each seat's verdict + explanation with seat and model names **replaced by
  "Reviewer 1..N"**. Anonymize — naming the models anchors the arbitrators on model
  reputation instead of the attack path. Chatham House rules.

**2. Spawn set:** the reporting seat plus two non-reporting active seats (with only 3 seats
active, that is all of them). ONE parallel batch. **Seats only** — the same rule as §3.

**3. Task text** — instruct each seat:

```
task: Evaluate ONLY the contested finding(s) in /tmp/sec-quorum-arbitration.md, against that
      mini-packet and the code it cites. Return overall_correctness: "incorrect" if you
      now judge the finding a real defect (AGREE), or "correct" if you do not (DISAGREE),
      with a 1-3 sentence explanation. Findings yields are optional and only for
      corrections to the contested finding itself.
agent: <seat name from panel.mjs --prefix rev-sec->
name:  <seat name>
```

**4. Outcome mapping:**

| Arbitration result | Action |
|---|---|
| ≥2 seats AGREE | Treat the finding as corroborated — fix it |
| Majority DISAGREE | Mark it "disputed — rejected in arbitration"; still show it, with the reasoning, in the final summary |

Never a second round. Record the arbitration outcome in the final summary either way — a
rejected security finding that vanishes from the report is exactly the failure this section
exists to prevent.

*Why:* single-seat P0/P1s and verdict splits were previously adjudicated by the local
orchestrator alone — the exact failure mode quorum exists to avoid. Public multi-model
implementations (Star Chamber's debate mode, multi-model-debate) show that one anonymized
round is enough to change verdicts.

## Handling failures (degraded panel)

- **Some seats fail:** note "seat unavailable (model X blocked/failed)" and continue with the
  working remainder. Say so — never silently run a smaller panel.
- **<2 seats succeed:** no consensus signal — tell the user the panel can't quorum, show what
  did come back, and suggest checking the model routes (they churn; see §4).
- **All seats fail:** stop and report the failing model IDs. Likely causes are
  account/gateway routing or provider-side policy, not the code being reviewed.

## Tooling notes

- Scripts live in `~/.omp/agent/skills/security-quorum/scripts/` (shared with the
  `quorum-review` skill — same files, installed by the bundle installer) — use absolute
  paths (cwd varies by project).
- `packet.mjs` flags: `--focus`, `--summary`, `--files`, `--limit <bytes>`,
  `--budget <bytes>` (global packet cap, default `300000`, `0` disables), `--all-files`
  (keep lockfiles/generated files in the embedded diff — excluded by default), `--out`,
  `--json`. Diffs are per file; deleted files' patches are stripped and listed by name;
  untracked files are embedded in full (seats are told not to re-read them); over-budget
  packets drop the largest patches with a "read the file directly" note; the final stderr
  line reports total packet bytes and omission counts.
- `dedupe.mjs`: pass the specific result files from this run. `--dir <path>` scans all
  `*.json` there (its own `*.report.json` artifacts are auto-excluded) — use it only on a
  directory holding exactly this run's seat files. Keep `~/.omp/security-quorum/` separate
  from `~/.omp/quorum-review/` so the two pass types never mix. Clustering is category-aware
  and `cwe` is rendered per finding (§6).
- Detection tuning lives in the `rev-sec-*.md` seat prompts: `<detection-criteria>` for what
  to look for, `<exclusions>` for the noise classes to suppress. Distilled from the
  security-context audit findings corpus; iterate there, not in this skill file. If the panel
  keeps reporting a class you care about as out of scope, name it in `--focus` (which
  overrides the exclusion) before loosening the block.
