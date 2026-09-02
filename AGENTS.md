# Agent context — OMP skills bundle (quorum-review + security-quorum)

To the agent reading this: this repo is the distributable for OMP skills. It is a
**review-pass tool**, not app code. Read this before operating it.

## What it is

Two panel-review skills, one bundle:

- **quorum-review** — general "last pass" gate. When the user says **"panel review" /
  "quorum" / "review pass" / "last pass"**, run `plugins/quorum-review/skills/quorum-review/SKILL.md`: focus →
  panel snapshot → packet → spawn every ACTIVE `rev-quorum-*` seat in ONE parallel batch →
  save results verbatim → dedupe by consensus → present → fix corroborated findings. Goal: an
  honest final quality gate using models independent of the user's local work model.
- **security-quorum** — focused security pass. When the user says **"security review" /
  "security pass" / "sec review" / "threat check"**, run `plugins/quorum-review/skills/security-quorum/SKILL.md`:
  the same protocol over the **`rev-sec-*`** panel, scoped to ONE small surface, with
  security-tuned detection criteria in the seat prompts. Separate results dir
  `~/.omp/security-quorum/`.

## Layout

- `.omp-plugin/marketplace.json` — the OMP marketplace catalog; this repo is the marketplace and
  `plugins/quorum-review/` the single plugin (`omp plugin install quorum-review@quorum-review`).
- `plugins/quorum-review/skills/<name>/SKILL.md` — one skill per dir. Frontmatter
  `panel_prefix:` names the seat family that skill's panel reads (`rev-quorum-` / `rev-sec-`).
- `plugins/quorum-review/agents/rev-*.md` — ALL seat agents, both families, one dir; `model:`
  pins the default model, `thinking-level:` the calibrated depth, `disable: true` parks a seat.
- `plugins/quorum-review/skills/quorum-review/scripts/` — the SHARED protocol scripts (`panel`,
  `packet`, `dedupe`, `minipacket`), single source of truth. security-quorum's SKILL.md points
  here; both SKILL.md files resolve the dir at run start (plugin cache path first, manual path
  second).
- `plugins/quorum-review/presets/` — OMP config overlays (model swaps, runtime backstops); not
  installed, passed to `omp --config` or copied into config.yml.
- `scripts/` (repo root) — repo tooling only: `lint.mjs`, `validate-marketplace.mjs`.
- `docs/` — `benchmark.md`, `thinking-levels.md`, `review-2026-09-02.md`. `bench/` — seeded patches.
- `.github/workflows/ci.yml` — lint + validate + script smoke, SHA-pinned actions, read-only perms.

## Installation (target machine)

Plugin (preferred): `omp plugin marketplace add sethforprivacy/quorum-review && omp plugin install
quorum-review@quorum-review`; upgrade with `omp plugin marketplace update quorum-review && omp
plugin upgrade quorum-review@quorum-review`. Manual fallback: `./install.sh` (lints first, copies
to `~/.omp/agent/{skills,agents}`, `--uninstall` removes the copies). **Never both**: manual copies
shadow plugin files by name. Version bumps touch `.omp-plugin/marketplace.json` (twice) and
`plugins/quorum-review/package.json`; the validator enforces equality.

## Key invariants — do not break

1. **Seat list is DYNAMIC.** Never hardcode panel composition in SKILL.md or docs. Run
   `panel.mjs [--prefix <family>]`; it shows active seats with their EFFECTIVE model (seat pin
   unless OMP `task.agentModelOverrides.<seat>` applies) and honors `disable: true` and OMP
   `task.disabledAgents`. Families are keyed by filename prefix.
2. **All active seats are spawned in ONE `task` call**, each with the SAME brief (the packet
   path), so consensus means something. Seats are the `rev-*` agents only — `agent:` set on
   every entry, never `scout`/`reviewer`/`task`; a failed seat is reported, not replaced.
   Never two spawn calls in one message. Build the packet once per round.
3. **Seats are read-only leaves.** No write tools, no `spawns:`. A seat that delegates runs part
   of its review on the local model and breaks the independence the panel exists for.
   `lint.mjs` enforces it.
4. **Deterministic logic lives in scripts** — orchestration lives in SKILL.md. Keep the CLI
   stable: `packet.mjs` (`--focus --summary --files --limit --budget --context --all-files --out
   --json`), `dedupe.mjs` (`--panel --expected --refuted --cwd --dir --out --json`), `panel.mjs`
   (`--prefix --agents-dir --json --no-omp`), `minipacket.mjs` (`--report --mode --select
   --security --cwd --context --out`), `lint.mjs` (`--quiet`).
5. **Degraded panels are correct behavior, not errors.** Report which seats ran; `dedupe
   --panel` lists expected seats with no result and uses `n/<active>` denominators. Never hide
   a failed seat, never silently run a bigger/smaller panel than configured.
6. **Never fabricate or transcribe reviewer output.** Save the delivered `result.data` verbatim
   plus `seat`/`resolvedModel`. A `schema_violation` payload is still the seat's output (save it,
   mark it). Verdict-only seats are recorded as-is, never re-run for structure.
7. **Provenance is checked, not assumed.** The resolved model of every result must be the
   panel's effective model. A fallback onto the session model (`resolvedModelIsFallback`) or a
   different model is a failed seat. `dedupe --panel` flags both.
8. **One retry max per seat per run**, solo, for transient failures only (400 empty body, 402,
   429, timeout, runtime exit). Never a third attempt, never a substitute agent.
9. **Arbitration is bounded**: at most ONE round, only for a verdict split or an uncorroborated
   P0 (P0/P1 security), anonymized ("Reviewer 1..N"), ≥2 AGREE ⇒ corroborated.
10. **Fix verification is reporter-only by default**, on a small packet whose `fingerprint`
    differs from the original run's.
11. **Packet rails stay visible.** Delete-only patches, lockfiles/generated files, secret-like
    filenames, binaries, over-budget drops and `TRUNCATED` files are always listed (packet body
    + last stderr line + `--json`), never silently gone. Secret-like names and lockfiles come
    back only with `--all-files`.
12. **`category` values must stay in sync** across a family's seats (schema description and
    `<output>` body) — `dedupe.mjs` clusters on the strings and `lint.mjs` checks equality.
    Quorum: logic, concurrency, api-contract, data-handling, error-handling, test-gap, perf,
    other. Security: weak-crypto, secret-handling, input-validation, integrity-spoofing,
    fail-open, supply-chain, concurrency, fee-amount, other.
13. **Ranking is priority first**, then corroboration. Consensus promotes a finding, never
    demotes a specific single-seat P0/P1 (the report calls those out).
14. **Follow-up rounds are built by `minipacket.mjs`, anonymized, and bounded**: one refutation
    pass at most (the refuter is never a panel vote; REFUTED findings stay visible in their own
    section), one arbitration round at most. Never hand-write these packets.
15. **Hunk context is auto-widened, never at the cost of a patch**: 12 lines when the packet fits
    the budget, else 3. `--context <n>` pins it.

## OMP mechanics you must know

- `task` has **no per-spawn `model` parameter**. Resolution: `task.agentModelOverrides.<agent>`
  → agent file `model:` → session model. Swap a seat's model via that setting (session:
  `omp --config presets/<file>.yml`; repo: `<repo>/.omp/config.yml`; global: config.yml or
  `/agents` hub). Selectors take `:level` suffixes and `@role` aliases. See `presets/README.md`.
- `omp config get` reads persisted config only, so `panel.mjs` cannot see a `--config`
  overlay — the delivered result's resolved model is the truth.
- A model whose provider lacks credentials **falls back to the parent session model**
  silently apart from `resolvedModelIsFallback`. That is why invariant 7 exists.
- Per-spawn `effort` (`lo|med|hi`) exists only when `task.enableEffort` is on (default off);
  thinking depth otherwise comes from the seat's `thinking-level:` or a `:level` suffix on the
  override. nanogpt clamps glm-5.3 `xhigh` to `high`.
- Every `tasks[]` entry needs `agent:`; an entry without it runs on the generic agent on the
  session model. Pass the packet as an absolute path, never inline or as a `local://` URI.
- `schemaMode` defaults to permissive: a retry-exhausted invalid result is delivered with a
  warning — treat it like a `schema_violation` payload (invariant 6).

## Panel state (2026-09-02)

All seats route through **`nanogpt`** (since 2026-08-25; zero provider errors in retained logs).

- quorum-review active: `rev-quorum-gem` gemini-3.7-flash `medium`; `rev-quorum-glm` glm-5.3
  `medium`; `rev-quorum-grok` grok-4.6 `medium`; `rev-quorum-nemo` nemotron-3.5-lightning
  `minimal`. Parked: deepseek-v4-pro-0813, qwen3.8-max (route-check before enabling).
- security-quorum active: `rev-sec-kimi` kimi-k3 `max`; `rev-sec-glm` glm-5.3 `xhigh`
  (clamped to `high` on nanogpt — re-benchmark pending); `rev-sec-grok` grok-4.6 `medium`.
  Parked on merit: `rev-sec-gem` (0 detections in 8 defective-sample runs; do not re-enable
  without new detection evidence).
- Pins rest on `docs/thinking-levels.md` + `docs/benchmark.md`. Do not change a pin without new
  benchmark data. Standing watch items: gem's verdict is unreliable in both directions (weight
  findings, not vote); nemo missed both fail-open samples; `rev-sec-grok`'s fail-open miss
  needs a re-test.

## Gotchas from live runs

- **`cwe` schema shape — the ARRAY form is the trap.** An output-schema property declared
  `type: array` without `items` 400s Gemini (empty body) and 402s z-ai ("can only afford …" —
  a schema problem wearing a billing error's clothes). `cwe` is a comma-separated **string** on
  every security seat. Never reintroduce the array form; if a seat 400s/402s solo while another
  seat on the same model succeeds, check this first.
- **`schema_violation` after a complete review** (glm: `confidence` as an array; verdict enum)
  has cost 14–24 minutes per occurrence. The payload is still the seat's output; save it.
  Some glm security spawns never yielded at all (36–39 min of prose): a seat that never yields
  is the failure, a slow one is not. `task.maxRuntimeMs` is the backstop if you want one.
- **Corroboration failed to form for mechanical reasons** in early runs: seats cite the same
  file as `/abs/x.cs`, `x.cs`, `src/x.cs`; dedupe now matches path suffixes. Hand-transcribed
  results (`severity: "P1"`, `area`) lose `priority`/`file_path`; dedupe parses them with a
  warning but the fix is invariant 6.
- git status collapses untracked DIRS to `?? dir/` → packet.mjs uses `-uall` + a file guard;
  never reintroduce naked `readFileSync` over untracked paths. Untracked files are embedded in
  full and seats are told not to re-read them — keep those two facts together.
- "Deleted" means the FILE was deleted (`deleted file mode` marker) — never infer deletion from
  hunk shape; a deletion-only edit to a living file must stay in the packet.
- The mean-confidence line is "(unweighted self-reported; not comparable across models)" for a
  reason: gem sits near 1.0 at every depth while glm's confidence drops as it digs. Never rank
  by it.
- `dedupe --dir` scans every `.json` (its own `*.report.json` and non-result files excluded
  with a warning) — pass explicit result files for a clean run. Keep the two results dirs
  separate.
- Seat files in the repo and the installed copies drift if `install.sh` is not re-run
  (observed: descriptions differed). Reinstall after every seat/prompt change.
