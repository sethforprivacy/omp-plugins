# Thinking-level calibration (2026-08-18)

Measured the right `thinking-level` for every active Quorum seat, standard and security, by
running each model at every level it supports against ONE controlled target: the Flint
BTCPay plugin PR16 diff (sweep-transaction labeler + deposits-behind-Advanced UI move,
20 files / ~270 insertions). Every seat reviewed the identical packet
(`/tmp/pkts/quorum-packet.md` standard, `/tmp/pkts/sec-packet.md` security, both built from
the same staged diff in a scratch worktree). 22 runs total, one per model×level.

## How outputs were compared

The diff has **no real defects** — established by the author's own read of every changed
file plus the panel consensus: all 22 runs returned `overall_correctness: correct`, zero
findings, and the deepest runs verified individually against the pinned
`btcpayserver` submodule commit. So detection power was not discriminable on this sample
(nothing to detect). What WAS measured per level:

- **Completeness** — coverage of the 9 subclaims a complete review of this diff must
  address (Bitcoin-address gating; best-effort/idempotent labeling; both call sites fresh
  send + crash reconciliation; Sent/Confirmed+non-null-txid condition; DI registration;
  constructor propagation to all test sites; nav cutover incl. removed constant; preserved
  permissions; wallet-object/idempotency semantics).
- **Diligence** — tool calls and thinking-token volume per run (transcript-measured).
- **Grounding** — whether the deeper explanations verified claims vs asserted them
  (checked transcripts; e.g. glm's core-API claims were fetched from
  raw.githubusercontent at the exact pinned commit).
- **Wall time** and per-run failure/reliability.

## Standard (quorum-review)

| model | level | tools | thinking chars | verdict | conf | cov | time |
|---|---|---|---|---|---|---|---|
| gemini-3.7-flash | low | 4 | (hidden) | correct | .98 | 2/9 | 11 s |
| gemini-3.7-flash | medium | 12 | (hidden) | correct | .95 | 4/9 | 42 s |
| gemini-3.7-flash | high | 33 | (hidden) | correct | .98 | 3/9 | 2m26 |
| glm-5.2 | minimal | 66 | 71k | correct | .90 | 8/9 | 11m14 |
| glm-5.2 | low | 31 | 36k | correct | .90 | 6/9 | 7m18 |
| glm-5.2 | medium | 44 | 42k | correct | .90 | 7/9 | 3m25 |
| glm-5.2 | high | 37 | 77k | correct | .85 | 8/9 | 9m10 |
| glm-5.2 | xhigh | 49 | 60k | correct | .90 | 8/9 | 9m49 |
| grok-4.6 | low | 20 | 1.7k | correct | .86 | 4/9 | 1m02 |
| grok-4.6 | medium | 77 | 11k | correct | .86 | 5/9 | 5m22 |
| grok-4.6 | high | 90 | 24k | correct | .88 | 4/9 | 11m44 |
| grok-4.6 | xhigh | 92 | 23k | correct | .88 | 5/9 | 13m30 |
| nemotron-3.5-lightning | minimal | 33 | 17k | correct | 1.0 | 7/9 | 1m10 |
| nemotron-3.5-lightning | low | 27 | 17k | correct | 1.0 | 3/9 | 1m13 |
| nemotron-3.5-lightning | medium | 32 | 31k | correct | .95 | 4/9 | 1m01* |
| nemotron-3.5-lightning | high | 23 | 42k | correct | .95 | 4/9 | 6m22 |

## Security (security-quorum)

| model | level | tools | thinking chars | verdict | conf | cov | time |
|---|---|---|---|---|---|---|---|
| gemini-3.7-flash | low | 3 | (hidden) | correct | .95 | 2/9 | 10 s |
| gemini-3.7-flash | medium | 4 | (hidden) | correct | .98 | 4/9 | 20 s* |
| gemini-3.7-flash | high | 27 | (hidden) | correct | .95 | 5/9 | 1m32 |
| kimi-k3 | low | 10 | 5.9k | correct | .85 | 5/9 | 2m06 |
| kimi-k3 | high | 14 | 21k | correct | .85 | 6/9 | 4m43 |
| kimi-k3 | max | 28 | 51k | correct | .78 | 7/9 | 9m50 |

\* first attempt failed (nemo: runtime exit 1 mid-review; sec-gem-medium: Gemini
`PROHIBITED_CONTENT` policy reject); successful retry timed. Both were infra, not verdicts.

## Findings

- **Effort scales with level everywhere** (tool calls and thinking-token volume rise
  monotonically; verified per-run `thinking_level_change` records). Higher always costs
  more; it does not always buy more.
- **gemini-3.7-flash** stays shallow at every level (2–5/9; ~45-word explanations, near-1.0
  confidence regardless). `medium` is its best standard coverage, `high` its best security
  coverage. Confidence is flat and uncalibrated — gem is a speed seat.
- **glm-5.2** is the deepest reviewer at every level ≥ minimal (6–8/9). `minimal` produced
  the most grounded run of all 22: 66 tool calls, fetched the pinned core source
  (WalletRepository.cs, LabelService.cs, Attachment.cs, TransactionTagModel.cs) and
  verified idempotency/rendering claims against it. `high`/`xhigh` match it at 8/9.
- **grok-4.6** spends heavily with level (20→77→90→92 tools) but coverage barely moves
  (4→5→4→5). **`xhigh` — the level recommended for Grok code review — returned the same
  verdict and essentially the same completeness as `low`, at 13m30 vs 1m02 and 13× the
  tool calls.** On this sample xhigh bought no review quality. Caveat: with a clean diff,
  detection power cannot be measured; this shows only that xhigh's extra compute did not
  improve explanation quality or surface any issue low/medium missed.
- **nemotron-3.5-lightning** is inverted: `minimal` gives its best coverage (7/9, 1.0 conf,
  1m10) while `low`–`high` give 3–4/9. Its "minimal" mode still reasons (17k thinking
  chars) but spends the budget on the review rather than the inner loop.
- **kimi-k3** (security): `max` gives the deepest security explanation (7/9, 51k thinking
  chars); coverage rises monotonically low→high→max. Confidence calibrates more
  conservatively as depth rises (.85→.78) — the honest-end slope.
- Structure/reliability was uniform: all successful runs returned valid structured JSON;
  2 of 22 first attempts failed on infra (nemo runtime error, gemini provider policy
  reject), both recovered on retry. No level-dependent yield breakage.

## Applied levels

| Seat | Model | `thinking-level` | Basis |
|---|---|---|---|
| rev-quorum-gem | gemini-3.7-flash | `medium` (unchanged; upstream default) | best standard cov (4/9); high adds tools, not coverage |
| rev-quorum-glm | glm-5.2 | `high` (unchanged; upstream default) | 8/9 at high; low/medium measurably thinner (6–7/9) |
| rev-quorum-grok | grok-4.6 | `medium` **(was default high)** | 5/9 at medium expense; high/xhigh add ~2.5–13× time for ≤1/9 gain |
| rev-quorum-nemo | nemotron-3.5-lightning | `minimal` **(was unset/default)** | 7/9 best-of-model at 1/6 the time of high |
| rev-sec-gem | gemini-3.7-flash | `high` **(was default medium)** | security pass needs the 5/9 tier; low was 2/9 in 10 s |
| rev-sec-kimi | kimi-k3 | `max` (unchanged; upstream default) | 7/9 deepest; security pass is low-frequency |

## Caveats

- Single clean sample: the Flint diff had no defects, so this measures **explanation
  completeness + diligence + grounding**, not detection recall. The grok-xhigh question
  (does it catch bugs lower levels miss?) is only answerable with a buggy sample; the
  measured evidence so far is that its extra compute doesn't improve the answer.
- GLM timings are provider-noisy (minimal took longest of its set); choose glm's level on
  coverage, not runtime.
- `minimal` is NOT "off" for these models — it engages a short internal pass that some
  (nemotron, glm) use productively.

## Evidence

Raw per-seat results: `~/.omp/quorum-think/zzt-*.json` (22 files). Transcripts with
per-run `thinking_level_change`, tool-call and thinking-volume data live under
`~/.omp/agent/sessions/-repos-personal-quorum-review/2026-08-18T20-46-44-125Z_…/Zzt*.jsonl`.

---

# glm-5.3 recalibration (2026-08-19)

`z-ai/glm-5.3` hit OpenRouter (1M ctx, 131k max output, output ~45% pricier than 5.2), so
both quorums were moved onto it: `rev-quorum-glm` (5.2→5.3) and `rev-sec-glm` (enabled,
5.3). Every GLM seat was re-benchmarked at all five levels (minimal/low/medium/high/xhigh)
against the same Flint PR16 benchmark — one run per level per panel, 10 runs total, same
packets (`/tmp/pkts/quorum-packet.md` standard, `/tmp/pkts/sec-packet.md` security, rebuilt
from the same staged diff in a scratch worktree at `4be5ef9`+PR16).

Note: a route-check blocked `rev-sec-glm` at spawn with a **402** ("can only afford 5976")
before any bench run. Isolated cause: the `cwe` untyped-array schema property — z-ai/glm-5.3
rejects it like Gemini does (see AGENTS.md gotchas), but as a 402 at request time, not a 400.
Removing `cwe` from `rev-sec-glm` cleared it (route-check clean, then all bench runs landed).

## Standard (quorum-review)

| level | tools | thinking chars | verdict | conf | cov | findings | time |
|---|---|---|---|---|---|---|---|
| minimal | 36 | 11.7k | correct | .90 | 8/9 | — | 5m48* |
| low | 26 | 10.8k | correct | .85 | 7/9 | — | 4m14 |
| medium | 26 | 10.8k | correct | .85 | 9/9 | — | 3m57 |
| high | 61 | 63.5k | correct | .85 | 9/9 | P3: singleton-enumeration test gap for the new labeler | 19m28* |
| xhigh | 61 | 49.8k | correct | .90 | 9/9 | — | 17m09 |

\* first spawn 402'd (account credit flap, not level-related); successful retry timed.

## Security (security-quorum)

Same 9-subclaim coverage scoring; the review surfaced a REAL defense-in-depth defect the
packet's attacker model provokes: `BTCPayWalletSweepTransactionLabeler.LabelAsync` writes the
provider-supplied sweep txid into the store's wallet as a labelled wallet-object with only a
null/empty check — no 64-char-hex validation — even though the plugin already validates the
same class of externally-supplied 32-byte ids in `SparkLightningClient.NormaliseHash`
(SparkLightningClient.cs:1035-1049). Verified against the worktree; the control is proven
feasible and simply missing on the new path. Severity is defense-in-depth (the provider
already controls the swept funds): a malicious provider can attach the sweep label to an
arbitrary txid in the merchant's wallet and persist arbitrary strings as wallet-object ids.

| level | tools | thinking chars | verdict | conf | cov | findings | time |
|---|---|---|---|---|---|---|---|
| minimal | 7 | 7.4k | **incorrect** | .60 | 7/9 | P2 txid-validation (.60) | 2m27 |
| low | 8 | 3.8k | correct | .80 | 5/9 | — | 1m12 |
| medium | 23 | 12.1k | correct | .82 | 8/9 | P3 arg-guards outside labeler try (.60) | 4m31† |
| high | 27 | 28.4k | correct | .88 | 7/9 | P3 txid-validation (.55) | 6m35 |
| xhigh | 34 | 33.9k | **incorrect** | .55 | 9/9 | P2 txid-validation (.65, NormaliseHash precedent) | 10m17‡ |

\† needed 6 spawns (4× transient 402 + one incomplete confidence-only yield) before a full
result; the 402 flap is account-credit, not level-driven (standard medium landed first try).
\‡ first run failed `schema_violation` on the verdict enum after a complete review; retry
delivered the full result.

## Findings

- **Standard completeness saturates at `medium`.** minimal/low drop a subclaim or two
  (test-constructor propagation, permissions, wallet-object semantics), but medium ties high
  and xhigh at 9/9 — at ~1/5 the wall time (3m57 vs 19m28/17m09) and 26 vs 61 tools. On the
  clean standard sample, high's only unique output was one P3 test-enumeration nit (the
  new labeler singleton missing from the startup-test enumeration). The glm-5.2-era basis
  for `high` ("low/medium measurably thinner 6–7/9") does not reproduce at 5.3.
- **Security detection is NOT monotonic in level — and it discriminated.** The one real
  defect was caught at full severity (P2, `incorrect`) by **minimal** (7 tools, 2m27 — the
  cheapest run of the sweep) and **xhigh** (34 tools, strongest brief, NormaliseHash
  precedent); **high** flagged it but downgraded to P3; **medium** found a different real
  nit (arg-guards outside the labeler's swallow-all try — also verified real) but missed the
  txid sink; **low** found nothing. The near-identical 7-8-tool runs (minimal vs low) went
  opposite ways, so low-effort security detection is a coin-flip — not a reliable seat
  behavior. For a security pass this points at depth over speed.
- **glm-5.3 remains a reliably structured reviewer** at every level: all full runs returned
  valid verdicts; the only schema failure (xhigh) recovered on retry.

## Applied levels (glm delta vs the 2026-08-18 pin)

| Seat | Model | `thinking-level` | Basis |
|---|---|---|---|
| rev-quorum-glm | glm-5.3 | `medium` **(was high)** | tie at 9/9 with high/xhigh at ~1/5 the time; high's only unique output was one P3 nit; "lower levels thinner" no longer holds at 5.3 |
| rev-sec-glm | glm-5.3 | `xhigh` **(new seat)** | only level to catch the txid defect at full severity with the deepest evidence; detection reliability (not cost) is the security-seat job; low-effort runs coin-flip |

## Caveats (2026-08-19)

- n=1 per level; the security signal rests on ONE defect. The txid finding is defense-in-depth
  (P2/P3), not P0/P1 — it measures severity-framing and detection reliability, not criticality.
- Standard-side detection is still unmeasurable (clean sample); the `medium` pin assumes 5.3's
  completeness plateau holds on buggy samples too.
- The 402 credit flap cost ~9 wasted spawns across the sweep and interleaved with successes on
  identical configs — treat OpenRouter 402s on glm-5.3 as flaky-account, retry before blaming
  the seat.

## Evidence

Raw per-seat results: `~/.omp/quorum-think/zzt-glm-5.3-{std,sec}-{minimal,low,medium,high,xhigh}.json`
(10 files). Transcripts under the 2026-08-19 session (`GlmStd*`, `GlmSec*`).
