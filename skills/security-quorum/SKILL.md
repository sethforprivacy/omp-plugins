---
name: security-quorum
description: Security-centric panel review. Run a small, focused change or surface past a panel of independent security reviewers (one per remote model, spawned in parallel), then dedupe and rank by consensus. Load whenever the user asks for a "security review", "security pass", "sec review", "security-quorum", "threat check", or wants a focused attack-surface audit of a specific change. Lighter and tighter than quorum-review: designed for one file, one function, one dependency, or one small diff — not whole-session gatekeeping.
panel_prefix: rev-sec-
---

# Security-quorum (focused security review)

Run a **small, focused** change or attack surface past a **panel** of independent security
reviewers (each pinned to a different remote model), spawned in parallel, then dedupe by
consensus and bring the report back **into this session**. It exists so a single reviewer —
or the author's own bias — never decides alone whether a change is safe. Scope stays small
on purpose; if it grows past one surface, split it into separate passes.

The scripts are the shared bundle scripts, installed at
`~/.omp/agent/skills/security-quorum/scripts/` — always call them by absolute path.

## The panel is dynamic — read it, never hardcode it

Seats are the `rev-sec-*.md` agent files in `~/.omp/agent/agents/` (a separate family from
`rev-quorum-*`). Each file's `model:` is the calibrated default; OMP's
`task.agentModelOverrides.<seat>` can swap it without touching files (see "Swapping seat
models"). `panel.mjs` prints the **effective** model per active seat:

```
node ~/.omp/agent/skills/security-quorum/scripts/panel.mjs --prefix rev-sec-
```

Detection tuning lives in the seat prompts, not here: `<detection-criteria>` (what to hunt),
`<exclusions>` (noise classes suppressed unless the focus names them) and `<precedents>`
(what is safe by default). A run's `--focus` overrides an exclusion when it names the class —
tighten the focus before loosening a seat.

## When to run

- User asks for a "security review" / "security pass" / "sec review" / "threat check", or
  "is X safe?" about a concrete change.
- Scope: ONE surface — a file, function, dependency, handler, config path, or small diff. If
  the user names a whole feature or repo, narrow to the risky slice (new entry points, new
  data flows, auth/token/crypto/parsing code) before running. Whole-repo sweeps are
  `quorum-review` territory or the standalone audit prompts.

## Protocol — do these steps in order, once each

### 1. Focus + scope + attacker model
One to three sentences: WHAT surface is under review, WHO the attacker is (untrusted user,
remote peer, network service, config/import file, dependency), and what "safe" means. The
attacker model is the most important context the seats get. If the diff is bigger than one
surface, say so and narrow.

### 2. Snapshot the panel
```
node ~/.omp/agent/skills/security-quorum/scripts/panel.mjs --prefix rev-sec- --json > /tmp/sec-quorum-panel.json
node ~/.omp/agent/skills/security-quorum/scripts/panel.mjs --prefix rev-sec-
```
The printed names are the ONLY valid `agent:` values for this run; the JSON feeds
`dedupe.mjs --panel`. Fewer than 2 seats ⇒ stop, the panel cannot quorum.

### 3. Build the context packet — exactly once per round
```
node ~/.omp/agent/skills/security-quorum/scripts/packet.mjs \
  --focus "<focus incl. attacker model>" \
  --summary "<3-8 factual bullets: the change, trust boundaries, prior findings>" \
  --out /tmp/sec-quorum-packet.md
```
- Smaller is better: lower `--limit` (per file) and `--budget` (whole packet) for a tight pass.
- Read the last stderr line and carry it into the report: bytes, `rev`, `fingerprint`, and
  every omission. Note especially **secret-like files withheld by name** (`.env*`, keys,
  `*token*`, …) — withheld from the packet so the credential never ships to the providers;
  if the surface under review IS such a file, pass `--all-files` deliberately — and
  `TRUNCATED` files (seats must read those from disk; raise `--limit` if the cut lands in the
  code under review).
- `--all-files` also keeps lockfiles in the diff — do that when the *supply chain* is the
  surface, since a lockfile change is exactly the finding you want then.
- Deletion-only edits to living files stay in the packet (a removed check is what a security
  pass must see); only whole-file deletions are listed by name.

### 4. Spawn ALL seats in ONE `task` call
One `task` call, one `tasks[]` entry per seat from step 2, identical task text:

```
task: Review the security scope described in the packet at /tmp/sec-quorum-packet.md.
      Read the packet, then the files it lists, per your own security reviewer
      instructions. Report only findings you can prove with a source->sink path.
      Evaluate independently — do not assume agreement with other reviewers.
agent: <seat name, verbatim from panel.mjs>
name:  <seat name>
```

Hard rules — each has been violated in a real run:
- `agent:` MUST be set on every entry, to the exact seat name. Bundled/local agents (`scout`,
  `reviewer`, `security-reviewer`, `task`, `sonic`) are NOT panel members.
- ONE `task` call per round; never two spawn calls in one message, never the same seat twice,
  never a parked seat. Packet by absolute path, never inline, never a `local://` URI.
- A failed seat is reported, not replaced. **Bounded retry:** a *transient* failure (400 empty
  body, 402, 429, timeout, runtime exit) earns exactly ONE solo re-spawn outside the batch; a
  second failure is a failed seat. Structure problems are never retried.

### 5. Collect — save every delivered result verbatim
Save each result to `~/.omp/security-quorum/<seat>-<timestamp>.json` as the **raw
`result.data` object exactly as delivered**, plus top-level `"seat"`, `"resolvedModel"` and,
when shown, `"resolvedModelIsFallback"`. Never paraphrase or re-key findings. Keep this
directory separate from `~/.omp/quorum-review/` so the two pass types never mix.

Provenance check, per seat, before saving:
- Result came from the seat you spawned; anything from a non-seat agent is discarded and noted.
- Resolved model equals the seat's effective model in `/tmp/sec-quorum-panel.json`. A
  **fallback** onto your session's model, or a different model, is not an independent vote:
  record the seat as failed (keep the file, name the reason).
- `schema_violation` after a full review: the payload inside the error is the seat's output —
  save it with `"schema_violation": true` and treat the seat as delivered. Prose with no
  yields, or a verdict with empty `findings`, is **verdict-only**: save, note, do not re-run.

### 6. Dedupe + rank by consensus
```
node ~/.omp/agent/skills/security-quorum/scripts/dedupe.mjs \
  ~/.omp/security-quorum/<seat>-<ts>.json ... \
  --panel /tmp/sec-quorum-panel.json --out ~/.omp/security-quorum/report-<ts>.md
```
Expected seats with no result show as "no result" and denominators are `n/<active seats>`;
model mismatches are flagged. Ranking is priority first, then corroboration, then confidence
— a specific single-seat P0/P1 is called out, never buried. `cwe` is rendered per finding.
Self-reported confidence is not comparable across models; never rank security findings by it.

### 7. Present and act — in this session, immediately
Show the report (with the packet stderr line and any provenance warnings), then:

| Finding | Response |
|---|---|
| P0/P1 or corroborated (≥2 seats) | Fix now; verify; then the **targeted verify pass** |
| Single-seat P0/P1 | Not yours to adjudicate alone — **arbitration round** first |
| Single-seat P2/P3 | Judge on merit (read the cited path yourself); fix if defensible, else note why not |
| Panel verdict split | Surface it, then the **arbitration round** |

**Targeted verify pass.** After a fix: small packet scoped to it (`--focus "verify fix of:
<title>"`, original finding + attacker model + exactly what changed in `--summary`, lower
`--budget`; its `fingerprint` must differ from the original run), spawned only to the seats
that reported it (substitute the deepest active seat — `rev-sec-kimi`/`rev-sec-glm` — if a
reporter failed). Full-panel re-runs only for large/risky fixes or on request.

Finish with what the panel changed, what you judged and ignored (and why), which seats
delivered, and the remaining risk. Bring severity honestly: never inflate a borderline item,
never bury a corroborated P1.

## Arbitration round (contested findings)

At most ONCE per review, only when the verdict splits or a **P0 or P1** is uncorroborated.
Never for single-seat P2/P3.

1. **Mini-packet** (`/tmp/sec-quorum-arbitration.md`): the contested finding(s) verbatim; the
   cited code ±20 lines read from disk; each seat's verdict + explanation with seat and model
   names replaced by "Reviewer 1..N".
2. **Spawn set:** the reporting seat plus two non-reporting active seats (all active if only
   3). ONE `task` call. Seats only.
3. **Task text:**
   ```
   task: Evaluate ONLY the contested finding(s) in /tmp/sec-quorum-arbitration.md, against that
         mini-packet and the code it cites. Return overall_correctness: "incorrect" if you
         now judge the finding a real defect (AGREE), or "correct" if you do not (DISAGREE),
         with a 1-3 sentence explanation. Findings yields are optional and only for
         corrections to the contested finding itself.
   agent: <seat name>
   name:  <seat name>
   ```
4. ≥2 AGREE ⇒ corroborated, fix. Majority DISAGREE ⇒ "disputed — rejected in arbitration",
   still shown with reasoning. Never a second round; a rejected security finding that vanishes
   from the report is exactly the failure this section prevents.

## Degraded panels are normal — report them, never hide them

- **Some seats fail:** name them and the reason; continue. Never pad with local agents.
- **<2 seats deliver:** no consensus signal — show what came back and say so.
- **All seats fail:** stop; report the failing model IDs (routing/policy, not the code).
- Deep security seats legitimately run 10–50 minutes. A seat that never yields is the failure,
  not a slow one; OMP's `task.maxRuntimeMs` is the backstop if you want one.

## Swapping seat models on command

Routing is fixed at spawn (no per-call model parameter on `task`). Set OMP's
`task.agentModelOverrides.<seat>` to a `provider/model[:thinking-level]` selector — per
session via `omp --config <overlay.yml>`, per repo in `<repo>/.omp/config.yml`, or globally in
`~/.omp/agent/config.yml` / the `/agents` hub. Overlays and rules: the bundle's
`presets/README.md`. Step 5's provenance check proves which model actually reviewed.

## Tooling reference

Same scripts and flags as quorum-review (`panel.mjs --prefix rev-sec-`, `packet.mjs`,
`dedupe.mjs --panel`); see that skill's tooling reference. Detection tuning happens in the
`rev-sec-*.md` seat prompts — iterate there, re-run `install.sh`, never in this file.
