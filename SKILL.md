---
name: quorum-review
description: Multi-model panel (quorum) review. Run the current work past a panel of independent reviewer agents — one per model, spawned in parallel — then dedupe, rank by consensus, and bring the report back into the session as the final quality gate. Load whenever the user mentions "panel review", "quorum", "review pass", "last pass", "have the panel look at it", or asks for work to be checked by several independent models before finalizing. Designed as the last pass on work produced with local models (independent, stronger models catch what the local model misses).
---

# Quorum (panel) review

Run the user's current work past a **panel** of independent reviewer agents (each pinned to a
different model), spawned **in parallel**, then dedupe the findings across reviewers, rank by
consensus, and present the report back **into this session**.

This is the "last pass" gate: it exists so one clumpy reviewer (or your local model) never
decides alone whether work is ready to ship.

## Active panel — discover dynamically, never hardcode

The panel is defined by `rev-quorum-*.md` agent files in `~/.omp/agent/agents/`. Each file is
one seat; its `model:` frontmatter is the model that seat runs. **Never hardcode the seat list
or models in this skill.** Always read the live panel:

```
node ~/.omp/agent/skills/quorum-review/scripts/panel.mjs
```

Changing the panel = editing those files only:

- **Swap a model:** edit one seat's `model:` line (e.g. to add ZDR/TEE routes when they exist).
- **Add a seat:** copy an existing `rev-quorum-*.md`, rename the file + `name:`, set its `model:`.
- **Retire a seat:** delete the file, or set `disable: true` to keep it for re-enabling.
- **Re-add a model later:** un-disable its seat / drop a new file back in.

## When to run

- User says "panel review", "quorum", "review pass", "last pass", "get this across the line",
  "have the panel look at X", or similar.
- Default scope: this session's uncommitted changes (git/jj) or the change set the agent made
  this session. If the scope is genuinely ambiguous, ask once; otherwise just run it.

## Protocol

Follow these steps in order. The scripts hold the deterministic logic; you orchestrate.

### 1. Focus (write it down first)
One to three sentences: what work is being reviewed, what "done / across the line" means, and
any constraints the panel must respect. Pull from the user's stated goal and current task.

### 2. Build the context packet
```
node ~/.omp/agent/skills/quorum-review/scripts/packet.mjs \
  --focus "<focus>" \
  --summary "<3-8 factual bullets of what was done this session: files, changes, decisions>" \
  --out /tmp/quorum-packet.md
```
- Default: auto-detects git or jj and diffs the working tree (`git diff HEAD` / `jj diff --git`).
- Non-VCS cwd: pass `--files <abs path,abs path,...>` instead (packet embeds file contents).
- Keep the packet honest: any context that matters but isn't in the diff (recent decisions,
  API contracts, why a shortcut was taken) belongs in `--summary`.

### 3. Read the panel and spawn ALL seats in ONE parallel batch
```
node ~/.omp/agent/skills/quorum-review/scripts/panel.mjs
```

**The panel is the seat agents — nothing else.** Each `rev-quorum-*` seat is pinned to a
remote model (`model:` in its file) so its verdict is independent of your local model. That
independence IS the point of quorum. Bundled agents (`scout`, `reviewer`, `security-reviewer`,
`task`, `sonic`) run on your local stack and are NOT panel members; a "panel" of them is not a
panel at all.

Then one `task` call with one entry per seat — same batch, so they run concurrently:

```
task: Review the changes described in the packet at /tmp/quorum-packet.md.
      Read the packet, then the files it lists, per your own reviewer instructions.
      Return your structured findings and verdict. Evaluate independently —
      report only what you can prove; do not assume agreement with other reviewers.
agent: <seat name from panel.mjs>
name:  <seat name>
```

- `agent:` MUST be the exact seat name printed by `panel.mjs` (e.g. `rev-quorum-c`). Copy it
  verbatim; do not paraphrase or re-derive it.
- NEVER set `agent:` to `scout`, `reviewer`, `task`, `security-reviewer`, or any other
  non-seat agent for a panel review. If you catch yourself about to, stop — you are off
  protocol. Read the seat list from `panel.mjs` and use those names.
- Do NOT include disabled/no-longer-active seats. Do NOT spawn the same seat twice.
- If a seat fails to spawn (route/auth block, timeout), record the failure per §4 and continue
  with the working seats. Do NOT replace a failed seat with a local/bundled agent — that
  silently shrinks the panel's independence and fakes a quorum that did not happen.

### 4. Collect results
Save each delivered result to `~/.omp/quorum-review/<seat>-<timestamp>.json` (raw JSON as
delivered). If a seat failed to return JSON (route error, auth/policy block, timeout, text-only
reply), record it as a failure and save nothing for it.

Verify the delivered results before saving: the result must be from the `agent` you spawned —
the seat name. If any delivered review came from a bundled/local agent (e.g. `scout`,
`reviewer`, `task`), it is NOT a panel seat: discard it from the panel set, re-run that seat
via the protocol, and note the violation in the report. A panel report must contain zero
non-seat reviewers.

Some models (observed: kimi-k3, seed-1.6-flash) return a verdict + explanation but an **empty `findings` array** — or balloon the reply instead of yielding structured findings. Treat those as verdict-only seats: still save the
result (their verdict/explanation show in the panel report), but their issues won't enter
consensus clustering. Don't silently rerun them for structure — note it and move on.

### 5. Dedupe + rank by consensus
```
node ~/.omp/agent/skills/quorum-review/scripts/dedupe.mjs \
  ~/.omp/quorum-review/<seat>-<ts>.json ... [--out ~/.omp/quorum-review/report.md]
```
Clusters the same issue reported by different reviewers; shows each finding with
`→ n/<total> (seats)` corroboration, priority, confidence; aggregates the panel verdict.

### 6. Present and act — in this session, immediately
Show the deduped report, then:

| Finding | Response |
|---|---|
| P0 or corroborated (≥2 seats) | Fix it now; verify; re-run the panel on the fix if warranted |
| Single-seat finding | Judge on merit; fix if defensible, else note and move on |
| Panel verdict split | Surface the disagreement to the user explicitly; don't bury the minority |

Finish by stating what the panel changed, what you chose to ignore (and why), and the current
verdict. These are notes for your own review loop, not a report to be filed away.

## Handling failures (degraded panel)

- **Some seats fail:** note "seat unavailable (model X blocked/failed)" and continue with the
  working remainder. Never silently run a smaller panel than the user asked for — say so.
  And never pad the panel with local/bundled agents (`scout`, `reviewer`, etc.) — the count
  that matters is seats that actually delivered.
- **<2 seats succeed:** tell the user the panel can't quorum (no consensus signal), show what
  did come back, and suggest checking the model routes (they churn — see panel section).
- **All seats fail:** stop and report the failing model IDs back to the user; the likely causes
  are account/gateway routing or provider-side policy, not the code being reviewed.

## Tooling notes

- Scripts live in `~/.omp/agent/skills/quorum-review/scripts/` — use absolute paths
  (cwd varies by project).
- `packet.mjs --help`-style flags: `--focus`, `--summary`, `--files`, `--limit <bytes>`,
  `--out`, `--json`.
- `dedupe.mjs`: pass the specific result files from this run. `--dir <path>` scans all `*.json` there
  (its own `*.report.json` artifacts are auto-excluded) — use it only on a directory holding exactly
  this run's seat files. `--json` writes a machine-readable merged report next to `--out`.
