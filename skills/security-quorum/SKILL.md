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

Current seat note: `rev-sec-glm` is pinned to `z-ai/glm-5.3` and **parked** (`disable: true`)
until that model is published on OpenRouter. Only a clean route check (not just a model being
listed) should unlock it.

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
stale — do not re-disable or bypass the seat on that basis.

### 6. Dedupe + rank by consensus
```
node ~/.omp/agent/skills/security-quorum/scripts/dedupe.mjs \
  ~/.omp/security-quorum/<seat>-<ts>.json ... [--out ~/.omp/security-quorum/report.md]
```
Clusters the same issue reported by different reviewers; shows `→ n/<total> (seats)`
corroboration, P-priority, confidence; aggregates the panel verdict.

### 7. Present and act — in this session, immediately
Show the deduped report, then:

| Finding | Response |
|---|---|
| P0/P1 or corroborated (≥2 seats) | Fix it now, verify, re-run the panel on the fix if warranted |
| Single-seat finding | Judge on merit (read the cited path yourself); fix if defensible, else note and move on |
| Panel verdict split | Surface the disagreement to the user explicitly; don't bury the minority |

Finish by stating what the panel changed, what you judged and ignored (and why), and the
remaining risk. Bring severity honestly: do not inflate borderline items, and do not bury a
corroborated P1.

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
- `packet.mjs` flags: `--focus`, `--summary`, `--files`, `--limit <bytes>`, `--out`, `--json`.
- `dedupe.mjs`: pass the specific result files from this run. `--dir <path>` scans all
  `*.json` there (its own `*.report.json` artifacts are auto-excluded) — use it only on a
  directory holding exactly this run's seat files. Keep `~/.omp/security-quorum/` separate
  from `~/.omp/quorum-review/` so the two pass types never mix.
- Detection tuning lives in the `rev-sec-*.md` seat prompts (the `<detection-criteria>`
  section). Distilled from the security-context audit findings corpus; iterate there, not in
  this skill file.
