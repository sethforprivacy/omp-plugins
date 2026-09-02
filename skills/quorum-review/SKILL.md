---
name: quorum-review
description: Multi-model panel (quorum) review. Run the current work past a panel of independent reviewer agents — one per model, spawned in parallel — then dedupe, rank by consensus, and bring the report back into the session as the final quality gate. Load whenever the user mentions "panel review", "quorum", "review pass", "last pass", "have the panel look at it", or asks for work to be checked by several independent models before finalizing. Designed as the last pass on work produced with local models (independent, stronger models catch what the local model misses).
panel_prefix: rev-quorum-
---

# Quorum (panel) review

Run the user's current work past a **panel** of independent reviewer agents (each pinned to a
different remote model), spawned **in parallel**, then dedupe the findings across reviewers,
rank by consensus, and present the report back **into this session**. It exists so one clumpy
reviewer — or your local model — never decides alone whether work is ready to ship.

The scripts hold the deterministic logic; you orchestrate. Scripts live in
`~/.omp/agent/skills/quorum-review/scripts/` — always call them by absolute path.

## The panel is dynamic — read it, never hardcode it

Seats are the `rev-quorum-*.md` agent files in `~/.omp/agent/agents/`. Each file is one seat;
its `model:` is the calibrated default. OMP's `task.agentModelOverrides.<seat>` setting can
swap a seat's model without touching files (see "Swapping seat models" below). `panel.mjs`
prints the **effective** model per active seat:

```
node ~/.omp/agent/skills/quorum-review/scripts/panel.mjs
```

Add a seat: copy a `rev-quorum-*.md`, rename file + `name:`, set `model:`. Park one:
`disable: true` (or OMP `task.disabledAgents`). Never edit this skill to change the panel.

## When to run

- User says "panel review", "quorum", "review pass", "last pass", "get this across the line",
  "have the panel look at X", or similar.
- Default scope: this session's uncommitted changes (git/jj) or the change set made this
  session. If the scope is genuinely ambiguous, ask once; otherwise run.
- Docs-only or whitespace-only diffs rarely need four remote reviewers: say so and confirm
  before spending the panel on them.

## Protocol — do these steps in order, once each

### 1. Focus (write it down first)
One to three sentences: what is being reviewed, what "done / across the line" means, and any
constraints the panel must respect.

### 2. Snapshot the panel
```
node ~/.omp/agent/skills/quorum-review/scripts/panel.mjs --json > /tmp/quorum-panel.json
node ~/.omp/agent/skills/quorum-review/scripts/panel.mjs
```
The printed names are the ONLY valid `agent:` values for this run, and the JSON is what
`dedupe.mjs --panel` uses later for denominators and the provenance check. If it lists fewer
than 2 seats, stop and tell the user the panel cannot quorum.

### 3. Build the context packet — exactly once per round
```
node ~/.omp/agent/skills/quorum-review/scripts/packet.mjs \
  --focus "<focus>" \
  --summary "<3-8 factual bullets: files, changes, decisions, context not visible in the diff>" \
  --out /tmp/quorum-packet.md
```
- Auto-detects git/jj and diffs the working tree (`git diff HEAD` / `jj diff --git`);
  untracked files are embedded in full. Non-VCS cwd: `--files <abs,abs,...>`.
- Read the last stderr line and carry it into your report: total bytes, `rev`, the
  `fingerprint` (sha256 of exactly what the seats will see), and every omission — delete-only
  patches, lockfiles/generated files, **secret-like files (withheld by name)**, over-budget
  drops, and `TRUNCATED` files (cut at `--limit`, default 100000 bytes/file — seats must read
  those from disk; raise `--limit` if the cut lands in the code under review).
- `--budget <bytes>` caps the whole packet (default 300000; `0` disables). `--all-files` keeps
  lockfiles AND allows secret-like names to be embedded — only when the focus needs them.
- Do not rebuild the packet between spawn and dedupe; seats read it at spawn time.

### 4. Spawn ALL seats in ONE `task` call
One `task` call, one `tasks[]` entry per seat from step 2, identical task text:

```
task: Review the changes described in the packet at /tmp/quorum-packet.md.
      Read the packet, then the files it lists, per your own reviewer instructions.
      Return your structured findings and verdict. Evaluate independently —
      report only what you can prove; do not assume agreement with other reviewers.
agent: <seat name, verbatim from panel.mjs>
name:  <seat name>
```

Hard rules — each of these has been violated in a real run:
- `agent:` MUST be set on every entry, to the exact seat name. An entry without `agent:` runs
  on the generic `task` agent on YOUR model; `scout`, `reviewer`, `security-reviewer`, `task`,
  `sonic` and every other bundled/local agent are NOT panel members. A "panel" of them is not
  a panel.
- ONE `task` call per round. Never emit two spawn calls in one message (that doubles the panel
  and the cost); never spawn the same seat twice; never include parked seats.
- Pass the packet as the absolute path above, never inline and never as a `local://` URI.
- A failed seat is reported, not replaced. **Bounded retry:** a *transient* failure (400 with
  empty body, 402, 429, timeout, runtime exit) earns exactly ONE solo re-spawn of that seat,
  outside the batch. A second failure is a failed seat. Structure problems (verdict-only,
  schema violation, prose instead of yields) are never retried.

### 5. Collect — save every delivered result verbatim
Save each delivered result to `~/.omp/quorum-review/<seat>-<timestamp>.json` as the **raw
`result.data` object exactly as delivered**, with three fields added at the top level:
`"seat"`, `"resolvedModel"` (the model the harness reports the spawn ran on) and, when shown,
`"resolvedModelIsFallback"`. Never paraphrase, re-type, summarize, or re-key the findings —
a hand-transcribed file loses `priority`/`file_path` and degrades clustering.

Provenance check, per seat, before you save:
- The result must come from the seat you spawned (name matches). Anything from a non-seat
  agent is discarded from the panel set and noted as a violation.
- The resolved model must be the seat's effective model from `/tmp/quorum-panel.json`. A
  result marked as a **fallback** onto your session's model, or on a different model, is NOT an
  independent vote: record the seat as failed (keep the file, name the reason).
- A seat that finished with `schema_violation` still did the work — the payload inside the
  error is its output. Save that payload, add `"schema_violation": true`, and treat the seat
  as delivered (dedupe parses permissively). A seat that returned prose and no yields at all,
  or an empty `findings` with a verdict, is **verdict-only**: save it, note it, do not re-run
  it for structure.

### 6. Dedupe + rank by consensus
```
node ~/.omp/agent/skills/quorum-review/scripts/dedupe.mjs \
  ~/.omp/quorum-review/<seat>-<ts>.json ... \
  --panel /tmp/quorum-panel.json --out ~/.omp/quorum-review/report-<ts>.md
```
`--panel` makes every expected seat count: seats with no result appear as "no result" and
denominators are `n/<active seats>`; it also flags any result whose resolved model differs
from the panel. Findings are ranked **priority first**, then corroboration, then confidence:
consensus promotes a finding but never buries a specific single-seat P0/P1 (the report calls
those out). Clustering is category-aware and tolerant of absolute vs relative paths. The
mean-confidence line is self-reported and not comparable across models — never rank by it.

### 7. Present and act — in this session, immediately
Show the report (including the packet stderr line and any provenance warnings), then:

| Finding | Response |
|---|---|
| P0 or corroborated (≥2 seats) | Fix now; verify; then run the **targeted verify pass** |
| Single-seat P0 | Not yours to adjudicate alone — **arbitration round** first |
| Single-seat P1–P3 | Judge on merit (read the cited code yourself); fix if defensible, else note why not |
| Panel verdict split | Surface it, then run the **arbitration round** |

**Targeted verify pass.** After a fix, do not re-run the whole panel by default:
1. Build a SMALL packet scoped to the fix: `--focus "verify fix of: <finding title>"`,
   `--summary` carrying the original finding text and exactly what changed, lower `--budget`.
   Its `fingerprint` must differ from the original run's — you are verifying new state.
2. Spawn only the seats that reported the finding (if one failed this run, substitute the
   deepest active seat — `docs/thinking-levels.md` has the depth order).
3. Full-panel re-runs only for large/risky fixes or on request.

Finish by stating what the panel changed, what you chose to ignore and why, which seats
delivered, and the current verdict.

## Arbitration round (contested findings)

At most ONCE per review, only when the verdict splits (both `correct` and `incorrect`
present) or a **P0** is uncorroborated. Never for single-seat P1–P3.

1. **Mini-packet** (`/tmp/quorum-arbitration.md`): the contested finding(s) verbatim; the
   cited code ±20 lines read from disk; each seat's verdict + explanation with seat and model
   names replaced by "Reviewer 1..N" (anonymized so arbitrators judge the code, not the
   model's reputation).
2. **Spawn set:** the reporting seat plus two non-reporting active seats (all active seats if
   only 3 are active). ONE `task` call. Seats only.
3. **Task text:**
   ```
   task: Evaluate ONLY the contested finding(s) in /tmp/quorum-arbitration.md, against that
         mini-packet and the code it cites. Return overall_correctness: "incorrect" if you
         now judge the finding a real defect (AGREE), or "correct" if you do not (DISAGREE),
         with a 1-3 sentence explanation. Findings yields are optional and only for
         corrections to the contested finding itself.
   agent: <seat name>
   name:  <seat name>
   ```
4. ≥2 AGREE ⇒ corroborated, fix it. Majority DISAGREE ⇒ "disputed — rejected in
   arbitration", still shown with reasoning in the summary. Never a second round.

## Degraded panels are normal — report them, never hide them

- **Some seats fail:** say which ("seat unavailable: <seat>, <reason>") and continue; the
  denominators already show it. Never pad with local agents.
- **<2 seats deliver:** the panel cannot quorum — show what came back, say so, and point at
  the model routes (they churn).
- **All seats fail:** stop and report the failing model IDs; the cause is routing/policy, not
  the code.
- Seats that take very long (some deep seats run 20–50 min) are not failures by themselves;
  a seat that never yields is. Consider OMP's `task.maxRuntimeMs` as a backstop.

## Swapping seat models on command

Routing is fixed at spawn: the `task` tool has no per-call model parameter. To run a seat on
another model without editing files, set OMP's `task.agentModelOverrides.<seat>` to a
`provider/model[:thinking-level]` selector — for one session via `omp --config <overlay.yml>`,
per repo in `<repo>/.omp/config.yml`, or globally in `~/.omp/agent/config.yml` / the `/agents`
hub. Ready-made overlays and the full rules are in the bundle's `presets/README.md`. Whatever
the route, step 5's provenance check is what proves which model actually reviewed.

## Tooling reference

- `panel.mjs [--json] [--prefix rev-quorum-] [--agents-dir <path>] [--no-omp]` — active seats
  with effective models; honors `disable: true` and OMP `task.disabledAgents`.
- `packet.mjs --focus <t> [--summary <t>] [--files a,b] [--limit <bytes>] [--budget <bytes>]
  [--all-files] [--out <path>] [--json]` — packet header carries `rev` and `fingerprint`;
  last stderr line reports bytes, omissions and truncations.
- `dedupe.mjs <results...> [--dir <path>] [--panel <panel.json>] [--expected a,b] [--cwd <repo>]
  [--out <path>] [--json]` — `--dir` scans every `*.json` (its own `*.report.json` excluded),
  so use it only on a directory holding exactly this run's files.
