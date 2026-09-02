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

The scripts hold the deterministic logic; you orchestrate. They live in `scripts/` next to this
SKILL.md. Resolve that directory ONCE at the start of a run and use it for every command below:

```
Q=$(ls -d ~/.omp/plugins/cache/plugins/*quorum-review*/skills/quorum-review/scripts \
         ~/.omp/agent/skills/quorum-review/scripts 2>/dev/null | head -1); echo "$Q"
```

(plugin install first, manual `install.sh` copy second; if both exist, the manual copy shadows the
plugin and should be removed with `install.sh --uninstall`). Below, `$Q` is that path.

## The panel is dynamic — read it, never hardcode it

Seats are the `rev-quorum-*.md` agent files shipped with the bundle. Each is a neutral slot
(`model: "@<seat>"`); the model it runs comes from the user's OMP config
(`task.agentModelOverrides.<seat>`, see "Assigning seat models" below). `panel.mjs` prints the
effective model per active seat and reports unassigned seats as UNCONFIGURED — never spawn those:

```
node $Q/panel.mjs
```

Add a seat: copy a `rev-quorum-*.md`, rename file + `name:`, set `model: "@<new-name>"`, assign
it in config. Park one: OMP `task.disabledAgents`. Never edit this skill to change the panel.

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
node $Q/panel.mjs --json > /tmp/quorum-panel.json
node $Q/panel.mjs
```
The printed names are the ONLY valid `agent:` values for this run, and the JSON is what
`dedupe.mjs --panel` uses later for denominators and the provenance check. If it lists fewer
than 2 seats, stop and tell the user the panel cannot quorum.

### 3. Build the context packet — exactly once per round
```
node $Q/packet.mjs \
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
- Hunk context is widened automatically (12 lines) when the packet fits the budget, else git's
  default 3; the stderr line says which (`context N`). `--context <n>` pins it.
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

### 5. Collect — from OMP's own transcripts, never from memory
OMP writes one transcript per spawned seat under `~/.omp/agent/sessions/<cwd>/<session>/`. It
records the agent, the model the seat ACTUALLY ran on, whether that was a fallback, the thinking
level, and every yield. Collect from there:

```
node $Q/collect.mjs --out ~/.omp/quorum-review/<run-ts>/
```
(`--prefix rev-quorum-` is the default; add `--session-dir <dir>` if more than one session
spawned seats recently, `--all` to keep retries as separate files.)

It writes one `<seat>-<timestamp>.json` per seat — the seat's result `data` **verbatim** plus
`seat`, `resolvedModel`, `resolvedModelIsFallback`, `thinkingLevel`, `status` — and prints a
table. Never paraphrase, re-type, or hand-write a result file; if `collect.mjs` cannot find a
seat's transcript, that seat did not spawn in this session.

Read the table before dedupe:
- `fallback` **YES**: OMP ran the seat on YOUR session model because its assigned model had no
  working route or credentials. Not an independent vote — the seat is failed; keep the file,
  say why. Fix the assignment (`presets/README.md`) before the next run.
- `resolved model` must be the seat's model from `/tmp/quorum-panel.json`; dedupe cross-checks
  and flags a mismatch.
- `status` `no-yield`: prose, no structured output — failed seat (never re-run for structure).
  `verdict-only`: verdict but zero findings — recorded, does not enter clustering.
  `partial`: findings without a verdict (a `schema_violation` case) — still the seat's output;
  dedupe parses it.
- A result from a non-seat agent never appears here (collect filters on the seat prefix); if the
  batch spawned one anyway, note the violation in the report.

### 6. Dedupe + rank by consensus
```
node $Q/dedupe.mjs --dir ~/.omp/quorum-review/<run-ts>/ \
  --panel /tmp/quorum-panel.json --out ~/.omp/quorum-review/report-<ts>.md --json
```
(`--dir` on the per-run directory `collect.mjs` just wrote; `--json` writes the report.json that
`minipacket.mjs` reads.)
`--panel` makes every expected seat count: seats with no result appear as "no result" and
denominators are `n/<active seats>`; it also flags any result whose resolved model differs
from the panel. Findings are ranked **priority first**, then corroboration, then confidence:
consensus promotes a finding but never buries a specific single-seat P0/P1 (the report calls
those out). Clustering is category-aware and tolerant of absolute vs relative paths. The
mean-confidence line is self-reported and not comparable across models — never rank by it.

### 6b. Refutation pass (verify-then-report) — optional, one spawn
Run it when the user asks for a strict pass, when the report has more than ~5 findings, or when
any single-seat P0/P1 exists and you would rather verify all findings at once than arbitrate one:

```
node $Q/minipacket.mjs --report ~/.omp/quorum-review/report-<ts>.md.report.json \
  --mode refute --select all --out /tmp/quorum-refute.md        # or --select top (P0/P1 only)
```

Spawn ONE seat — the deepest active seat that reported the fewest of the selected findings (a
seat cannot refute its own claims; with only one such seat, use it) — with the task text:

```
task: Re-check every finding in /tmp/quorum-refute.md against the code it cites, per the
      packet's instructions: one findings yield per finding, same title, body starting
      CONFIRMED — <concrete trigger path> or REFUTED — <why, file:line>. Then the verdict yields.
agent: <seat name>
name:  <seat name>-refute
```

Collect it like any seat (`collect.mjs --out ~/.omp/quorum-review/<run-ts>-refute/`), then
re-run step 6 with `--refuted <that file>`: REFUTED clusters move to a "Refuted in verification" section
(shown, not actioned); CONFIRMED ones are marked ✔ verified. The refuter is not a panel vote.
One pass only; never refute the refutation.

### 7. Present and act — in this session, immediately
Show the report (including the packet stderr line and any provenance warnings), then:

| Finding | Response |
|---|---|
| P0 or corroborated (≥2 seats), or ✔ verified | Fix now; verify; then run the **targeted verify pass** |
| Single-seat P0 | Not yours to adjudicate alone — **arbitration round** first (or the refutation pass above) |
| Refuted in verification | Do not fix; keep it in the summary with the refuter's reason |
| Single-seat P1–P3 | Judge on merit (read the cited code yourself); fix if defensible, else note why not |
| Panel verdict split | Surface it, then run the **arbitration round** |

**Targeted verify pass.** After a fix, do not re-run the whole panel by default:
1. Build a SMALL packet scoped to the fix: `--focus "verify fix of: <finding title>"`,
   `--summary` carrying the original finding text and exactly what changed, lower `--budget`.
   Its `fingerprint` must differ from the original run's — you are verifying new state.
2. Spawn only the seats that reported the finding (if one failed this run, substitute the
   active seat with the highest assigned thinking level).
3. Full-panel re-runs only for large/risky fixes or on request.

Finish by stating what the panel changed, what you chose to ignore and why, which seats
delivered, and the current verdict.

## Arbitration round (contested findings)

At most ONCE per review, only when the verdict splits (both `correct` and `incorrect`
present) or a **P0** is uncorroborated. Never for single-seat P1–P3.

1. **Mini-packet** — build it, do not hand-write it:
   ```
   node $Q/minipacket.mjs --report ~/.omp/quorum-review/report-<ts>.md.report.json \
     --mode arbitrate --out /tmp/quorum-arbitration.md   # --select contested is the default
   ```
   It carries the contested finding(s) verbatim, the cited code ±20 lines read from disk, and
   each seat's verdict + explanation with seat and model names replaced by "Reviewer 1..N"
   (anonymized so arbitrators judge the code, not the model's reputation).
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

## Assigning seat models

Routing is fixed at spawn: the `task` tool has no per-call model parameter, and the shipped seat
files name no model. The user's OMP config sets `task.agentModelOverrides.<seat>` to a
`provider/model[:thinking-level]` selector — per session via `omp --config <overlay.yml>`, per
repo in `<repo>/.omp/config.yml`, or globally in `~/.omp/agent/config.yml` / the `/agents` hub.
Template and rules: the bundle's `presets/README.md`. If `panel.mjs` shows UNCONFIGURED seats,
tell the user which keys to set instead of spawning; step 5's provenance check proves which
model actually reviewed.

## Tooling reference

- `panel.mjs [--json] [--prefix rev-quorum-] [--agents-dir <path>] [--no-omp]` — active seats
  with effective models; finds seat files in the user agents dir and every installed plugin's
  `agents/` dir; honors `disable: true` and OMP `task.disabledAgents`.
- `packet.mjs --focus <t> [--summary <t>] [--files a,b] [--limit <bytes>] [--budget <bytes>]
  [--context <n|auto>] [--all-files] [--out <path>] [--json]` — packet header carries `rev` and `fingerprint`;
  last stderr line reports bytes, omissions and truncations.
- `collect.mjs [--prefix rev-quorum-] --out <dir> [--session-dir <dir>] [--since <min>] [--all]
  [--json]` — seat results + provenance straight from OMP's subagent transcripts.
- `dedupe.mjs <results...> [--dir <path>] [--panel <panel.json>] [--expected a,b] [--cwd <repo>]
  [--refuted <result.json>] [--out <path>] [--json]` — `--dir` scans every `*.json` (its own
  `*.report.json` and non-result files excluded), so use it only on a directory holding exactly
  this run's files. `--json` writes `<out>.report.json`, the input for `minipacket.mjs`.
- `minipacket.mjs --report <report.json> --mode refute|arbitrate [--select all|top|contested|1,3]
  [--security] [--cwd <repo>] [--context 20] --out <path>` — anonymized follow-up packets.
