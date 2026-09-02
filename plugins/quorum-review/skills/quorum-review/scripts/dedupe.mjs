#!/usr/bin/env node
// dedupe.mjs — Merge N quorum-reviewer findings files, dedupe across reviewers, and emit a
// consensus-ranked report. Deterministic: same inputs → same output (stable sort, no randomness).
//
// Usage:
//   dedupe.mjs <findings.json...> [--out <path>] [--json] [--expected <seat,seat,...>]
//   dedupe.mjs --dir <path>        # scan <path>/*.json for reviewer results
//
// Options:
//   --out <path>        Write markdown report to <path> (default stdout).
//   --json              Also write machine-readable merged JSON to <path>.json (or stdout when no --out).
//   --expected <a,b,c>  The ACTIVE seat names this run spawned (paste panel.mjs output names). Any
//                       expected seat with no result file is listed as "no result" and counted in
//                       every denominator, so a failed seat can never silently shrink the panel.
//                       A result file matches a seat when its basename is the seat name or starts
//                       with "<seat>-" (or its JSON carries `seat`/`agent`).
//   --panel <path>      Same as --expected, read from `panel.mjs --json > <path>` (the seat list
//                       captured at spawn time). Also cross-checks each result's resolvedModel
//                       against the panel's effective model and flags mismatches.
//   --refuted <path>    A refutation-pass result (the seat output produced from a
//                       `minipacket.mjs --mode refute` packet). Its findings are matched to clusters
//                       by title (or same file + overlapping lines); a body starting with REFUTED
//                       moves the cluster into a "Refuted in verification" section (shown, not
//                       actioned), CONFIRMED marks it verified. The refuter never enters the panel
//                       vote and is never a reviewer.
//
// File paths are normalized before clustering (absolute → relative to --cwd or the process cwd;
// a path that is a suffix of another counts as the same file), because seats cite the same file
// as `/abs/path/x.cs`, `x.cs` or `src/x.cs` and un-normalized keys silently prevent corroboration.
//
// Ranking: priority first (P0 before P3), then corroboration count, then confidence, then file.
// Corroboration promotes a finding; it never demotes one — a specific single-seat P0/P1 sits above
// a corroborated P2, and the report calls those out separately so consensus never buries them.
//
// Input file shape (permissive extraction):
//   { findings: [...], overall_correctness?, explanation?, confidence? }
//   or same nested under result.data / data / output / result.
//   Each finding: { title, body, priority (0-3), confidence (0-1), file_path, line_start, line_end,
//                   category? (string), cwe? (string) }.
//
// Dedup: cluster findings from different reviewers that describe the same issue. A finding in the
// same file clusters with an existing cluster when
//   (a) normalized titles match exactly, or
//   (b) line ranges overlap AND title-token Jaccard similarity >= 0.5, or
//   (c) line ranges are close AND title+body share a distinctive token.
// Categories, when BOTH findings carry one, gate this:
//   - categories DIFFER  → cluster only on exact normalized-title match (no cross-category merges
//     of findings that merely sit near each other).
//   - categories MATCH   → also cluster on proximity alone (overlap or line gap <= 20), since the
//     category already establishes the two reviewers are talking about the same class of bug.
//   - either missing     → rules (a)-(c) exactly as before.
// Canonical member = highest (priority desc, confidence desc, body length desc); its category and
// cwe are the ones reported. Report shows corroboration count (≥2 reviewers) so the session can
// weight consensus.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function fail(msg) {
  console.error(`dedupe: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { files: [], dir: null, out: null, json: false, expected: [], panel: null, cwd: process.cwd(), refuted: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--out") args.out = val();
    else if (a === "--json") args.json = true;
    else if (a === "--dir") args.dir = val();
    else if (a === "--cwd") args.cwd = val();
    else if (a === "--expected") args.expected = (val() || "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--panel") args.panel = val();
    else if (a === "--refuted") args.refuted = val();
    else if (a.startsWith("-")) fail(`unknown arg ${a}`);
    else args.files.push(a);
  }
  return args;
}

function normalizeTitle(t) {
  return String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(t) {
  return new Set(normalizeTitle(t).split(/\s+/).filter(Boolean));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function rangesOverlap(f1, f2) {
  const has1 = Number.isFinite(f1.line_start) && Number.isFinite(f1.line_end);
  const has2 = Number.isFinite(f2.line_start) && Number.isFinite(f2.line_end);
  if (!has1 || !has2) return false;
  return f1.line_start <= f2.line_end && f2.line_start <= f1.line_end;
}

function lineGap(f1, f2) {
  const has1 = Number.isFinite(f1.line_start) && Number.isFinite(f1.line_end);
  const has2 = Number.isFinite(f2.line_start) && Number.isFinite(f2.line_end);
  if (!has1 || !has2) return Infinity;
  const c1 = (f1.line_start + f1.line_end) / 2;
  const c2 = (f2.line_start + f2.line_end) / 2;
  return Math.abs(c1 - c2);
}

// Low-information title words that shouldn't count as evidence of "same issue".
const STOP = new Set([
  "about", "above", "across", "after", "against", "already", "also", "although",
  "always", "another", "because", "before", "being", "between", "could", "didnt",
  "doesnt", "during", "either", "ensure", "every", "first", "further", "handle",
  "handles", "handling", "having", "inside", "issue", "issues", "might", "never",
  "other", "others", "should", "since", "sometimes", "still", "such", "than",
  "that", "there", "these", "thing", "things", "those", "through", "under",
  "using", "very", "while", "within", "without", "would",
]);

function distinctiveTokens(s) {
  return new Set(
    normalizeTitle(s)
      .split(/\s+/)
      .filter((t) => t.length >= 6 && !STOP.has(t))
  );
}

function normalizeCategory(c) {
  const s = String(c || "").trim().toLowerCase();
  return s || null;
}

function sameIssue(a, b) {
  if (!sameFile(a.fileKey, b.fileKey)) return false;
  if (normalizeTitle(a.title) === normalizeTitle(b.title)) return true;
  const ca = normalizeCategory(a.category), cb = normalizeCategory(b.category);
  if (ca && cb) {
    // Two reviewers that both classified the finding and disagree on the class are not
    // describing the same issue — only an identical title can override that.
    if (ca !== cb) return false;
    // Same class in the same neighborhood is enough on its own; wording need not overlap.
    if (rangesOverlap(a, b) || lineGap(a, b) <= 20) return true;
  }
  if (jaccard(tokens(a.title), tokens(b.title)) >= 0.5) return true;
  // Same neighborhood AND a shared distinctive token (identifier/verb) in title+body is
  // strong evidence both reviewers mean the same bug even when wording diverges.
  const close = rangesOverlap(a, b) || lineGap(a, b) <= 20;
  if (close) {
    const da = new Set([...distinctiveTokens(a.title), ...distinctiveTokens(a.body)]);
    const db = new Set([...distinctiveTokens(b.title), ...distinctiveTokens(b.body)]);
    for (const t of da) if (db.has(t)) return true;
  }
  return false;
}

function extract(obj) {
  // Pull the envelope out of common result shapes.
  let src = obj;
  if (obj && typeof obj === "object") {
    for (const key of ["result", "data", "output"]) {
      if (obj[key] && typeof obj[key] === "object") {
        const nested = obj[key];
        const data = nested.data !== undefined && typeof nested.data === "object" ? nested.data : nested;
        if (data && (data.findings || data.overall_correctness)) src = data;
        break;
      }
    }
  }
  const findings = Array.isArray(src.findings) ? src.findings : [];
  // Provenance, when the saved result carries it (OMP reports the model a spawn actually ran on
  // as `resolvedModel`; a fallback onto the parent session's model is NOT an independent seat).
  const pick = (...vals) => vals.find((v) => typeof v === "string" && v.trim()) || null;
  const resolvedModel = pick(obj?.resolvedModel, obj?.model, src?.resolvedModel, src?.model);
  const fallback = obj?.resolvedModelIsFallback === true || src?.resolvedModelIsFallback === true;
  const seatName = pick(obj?.seat, obj?.agent, src?.seat, src?.agent);
  // Verdict may sit under `verdict:` as a string ("incorrect - reason") or object in
  // hand-transcribed results; normalize to the enum and keep the remainder as explanation.
  const v = src.verdict && typeof src.verdict === "object" ? src.verdict : {};
  let overall = src.overall_correctness ?? v.overall_correctness;
  let explanation = src.explanation ?? v.explanation;
  if (overall === undefined && typeof src.verdict === "string") {
    const m = src.verdict.match(/^\s*(incorrect|correct)\b[\s:\-—]*(.*)$/is);
    if (m) { overall = m[1].toLowerCase(); explanation = explanation ?? (m[2].trim() || undefined); }
    else overall = src.verdict;
  }
  return {
    verdict: {
      overall_correctness: overall,
      explanation,
      confidence: src.confidence ?? v.confidence,
    },
    findings,
    resolvedModel,
    fallback,
    seatName,
    transcribed: findings.some((f) => f && typeof f === "object" && (f.severity !== undefined || f.area !== undefined) && f.priority === undefined),
  };
}

// Priority may arrive as 0-3, "P1", or "1" — a transcribed result should not read as P3 conf 0.
function parsePriority(f) {
  if (Number.isFinite(f.priority)) return f.priority;
  const raw = f.priority ?? f.severity;
  const m = String(raw ?? "").match(/([0-3])/);
  return m ? Number(m[1]) : 3;
}

function seatOf(source, expected) {
  return expected.find((s) => source === s || source.startsWith(`${s}-`)) || null;
}

// Normalize a cited path to a repo-relative form for clustering.
function normalizePath(p, cwd) {
  let s = String(p || "").trim().replace(/\\/g, "/");
  if (!s) return "(no file)";
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  if (s.startsWith(root)) s = s.slice(root.length);
  return s.replace(/^\.\//, "").replace(/:\d+(-\d+)?$/, "");
}

// Same file when the keys are equal or one is a path-suffix of the other (`x.cs` vs `src/x.cs`).
function sameFile(a, b) {
  if (a === b) return true;
  if (a === "(no file)" || b === "(no file)") return false;
  return a.endsWith("/" + b) || b.endsWith("/" + a);
}

// A model selector matches when the two strings are equal after stripping a `:level` suffix,
// or one is the other's suffix (`glm-5.3` vs `nanogpt/zai-org/glm-5.3`).
function modelMatches(resolved, expected) {
  const strip = (s) => String(s || "").trim().replace(/:[a-z]+$/i, "");
  const r = strip(resolved), e = strip(expected);
  if (!r || !e) return true;
  return r === e || r.endsWith("/" + e) || e.endsWith("/" + r);
}

function renderPriority(p) {
  return p === 0 ? "P0" : p === 1 ? "P1" : p === 2 ? "P2" : "P3";
}

const args = parseArgs(process.argv.slice(2));
const panelModels = new Map(); // seat -> effective model at spawn time
if (args.panel) {
  let panel;
  try {
    panel = JSON.parse(readFileSync(args.panel, "utf8"));
  } catch (e) {
    fail(`--panel ${args.panel}: ${e.message}`);
  }
  const seats = Array.isArray(panel) ? panel : Array.isArray(panel?.seats) ? panel.seats : null;
  if (!seats) fail(`--panel ${args.panel}: expected panel.mjs --json output ({ seats: [...] })`);
  for (const s of seats) {
    if (!s?.name) continue;
    if (!args.expected.includes(s.name)) args.expected.push(s.name);
    if (s.model) panelModels.set(s.name, s.model);
  }
}
if (args.dir) {
  if (!existsSync(args.dir)) fail(`--dir ${args.dir} does not exist`);
  // Only reviewer-result files: exclude dedupe's own report artifacts and any
  // clearly-merged JSON so re-scans don't ingest phantom reviewers/stale findings.
  args.files = readdirSync(args.dir)
    .filter((f) => f.endsWith(".json") && !/\.report\.json$/.test(f) && !/^merged[-_.]/.test(f))
    .sort()
    .map((f) => join(args.dir, f));
}
if (args.files.length === 0) fail("no findings files given; pass <file>.json paths or --dir <path>");

const reviewers = [];
const skipped = [];
for (const f of args.files) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    console.error(`dedupe: warning — skipping unparseable ${f}: ${e.message}`);
    skipped.push(f);
    continue;
  }
  const { verdict, findings, resolvedModel, fallback, seatName, transcribed } = extract(raw);
  const source = f.replace(/\.json$/i, "").split(/[\\/]/).pop();
  if (!Array.isArray(raw?.findings) && verdict.overall_correctness === undefined && findings.length === 0) {
    console.error(`dedupe: warning — skipping ${f}: not a reviewer result (no findings/verdict; a panel snapshot or packet metadata?)`);
    skipped.push(f);
    continue;
  }
  if (transcribed) console.error(`dedupe: warning — ${source} looks hand-transcribed (severity/area instead of priority/file_path); save raw seat results, not paraphrases`);
  const seat = seatOf(source, args.expected) || (seatName && args.expected.includes(seatName) ? seatName : null);
  const expectedModel = seat ? panelModels.get(seat) : undefined;
  const modelMismatch = !!(expectedModel && resolvedModel && !modelMatches(resolvedModel, expectedModel));
  reviewers.push({ source, seat, verdict, findings, resolvedModel, expectedModel, modelMismatch, fallback, raw });
}
if (reviewers.length === 0) fail(`no reviewer files could be parsed (${skipped.length} skipped)`);

// Expected seats that delivered nothing. Denominators use the full expected panel.
const delivered = new Set(reviewers.map((r) => r.seat).filter(Boolean));
const missing = args.expected.filter((s) => !delivered.has(s));
const unexpected = args.expected.length ? reviewers.filter((r) => !r.seat).map((r) => r.source) : [];
const panelSize = args.expected.length ? Math.max(args.expected.length, reviewers.length) : reviewers.length;

// Flatten all findings with provenance.
const clusterKey = new Map();
const clusters = [];
for (let ri = 0; ri < reviewers.length; ri++) {
  for (const f of reviewers[ri].findings) {
    if (!f || typeof f !== "object") continue;
    const fileKey = normalizePath(f.file_path || f.file || f.area, args.cwd);
    const item = {
      ri,
      source: reviewers[ri].source,
      title: String(f.title || ""),
      body: String(f.body || ""),
      priority: parsePriority(f),
      confidence: Number.isFinite(f.confidence) ? f.confidence : 0,
      file_path: fileKey,
      line_start: Number.isFinite(f.line_start) ? f.line_start : null,
      line_end: Number.isFinite(f.line_end) ? f.line_end : null,
      category: typeof f.category === "string" && f.category.trim() ? f.category.trim() : null,
      cwe: typeof f.cwe === "string" && f.cwe.trim() ? f.cwe.trim() : null,
      fileKey,
    };
    let matched = null;
    for (const c of clusters) {
      // Only cluster findings from DIFFERENT reviewers: the same reviewer's findings are
      // distinct by construction, and merging them collapses real findings that merely
      // share a file, a line neighborhood, and a common distinctive token. sameIssue()
      // starts with the (suffix-tolerant) same-file test, so scanning all clusters is safe.
      if (c.items.some((m) => m.ri !== item.ri && sameIssue(item, m))) { matched = c; break; }
    }
    if (matched) {
      matched.items.push(item);
    } else {
      clusters.push({ items: [item] });
    }
    clusterKey.set(item, clusterKey.size);
  }
}

// Canonical + ranking per cluster.
const merged = clusters.map((c) => {
  const items = c.items;
  const canon = items.reduce((best, it) => {
    if (it.priority < best.priority) return it;
    if (it.priority > best.priority) return best;
    if (it.confidence > best.confidence) return it;
    if (it.confidence < best.confidence) return best;
    return it.body.length > best.body.length ? it : best;
  });
  const sources = [...new Set(items.map((it) => it.source))].sort();
  const pri = Math.min(...items.map((it) => it.priority));
  const conf = Math.max(...items.map((it) => it.confidence));
  return {
    title: canon.title || "(untitled finding)",
    body: canon.body,
    priority: pri,
    confidence: conf,
    file_path: canon.file_path,
    line_start: canon.line_start,
    line_end: canon.line_end,
    // Members may disagree on category/cwe; the canonical member's classification wins.
    category: canon.category,
    cwe: canon.cwe,
    reviewers: sources,
    count: sources.length,
    corroborated: sources.length >= 2,
    members: items.map((it) => ({ source: it.source, priority: it.priority, confidence: it.confidence, category: it.category, cwe: it.cwe })),
  };
});

const sortKey = (m) => [
  m.priority,                      // P0 first — severity is never outranked by file order
  -m.count,                        // more corroboration first
  -(m.confidence ?? 0),
  m.file_path,
  m.title.toLowerCase(),
];
merged.sort((a, b) => {
  const ka = sortKey(a), kb = sortKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
});

// Refutation pass: annotate clusters from a refuter's result (never a panel member).
let refuter = null;
if (args.refuted) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(args.refuted, "utf8"));
  } catch (e) {
    fail(`--refuted ${args.refuted}: ${e.message}`);
  }
  const ex = extract(raw);
  refuter = { source: args.refuted.replace(/\.json$/i, "").split(/[\\/]/).pop(), resolvedModel: ex.resolvedModel, matched: 0, unmatched: [] };
  for (const f of ex.findings) {
    if (!f || typeof f !== "object") continue;
    const body = String(f.body || "");
    const m = body.match(/^\s*(CONFIRMED|REFUTED)\b[\s:\-—]*/i);
    if (!m) { refuter.unmatched.push(`${f.title} (body does not start with CONFIRMED/REFUTED)`); continue; }
    const verdict = m[1].toUpperCase();
    const key = normalizePath(f.file_path || f.file || f.area, args.cwd);
    const probe = { fileKey: key, title: f.title, line_start: Number.isFinite(f.line_start) ? f.line_start : null, line_end: Number.isFinite(f.line_end) ? f.line_end : null };
    const target = merged.find((c) => normalizeTitle(c.title) === normalizeTitle(f.title))
      || merged.find((c) => sameFile(normalizePath(c.file_path, args.cwd), key) && rangesOverlap({ line_start: c.line_start, line_end: c.line_end }, probe));
    if (!target) { refuter.unmatched.push(`${f.title} (no matching cluster)`); continue; }
    target.verification = { verdict, reason: body.slice(m[0].length).trim(), priority: parsePriority(f), confidence: Number.isFinite(f.confidence) ? f.confidence : null };
    refuter.matched++;
  }
  for (const u of refuter.unmatched) console.error(`dedupe: warning — refutation finding ignored: ${u}`);
}
const refuted = merged.filter((m) => m.verification?.verdict === "REFUTED");
const live = merged.filter((m) => m.verification?.verdict !== "REFUTED");

// Panel verdict.
const votes = { correct: 0, incorrect: 0, missing: 0 };
for (const r of reviewers) {
  const v = r.verdict.overall_correctness;
  if (v === "correct") votes.correct++;
  else if (v === "incorrect") votes.incorrect++;
  else votes.missing++;
}
const confs = reviewers.map((r) => r.verdict.confidence).filter((c) => Number.isFinite(c));
const meanConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

const corr = live.filter((m) => m.corroborated).length;
const uniq = live.length - corr;
const singleHigh = live.filter((m) => !m.corroborated && m.priority <= 1);
const fallbackSeats = reviewers.filter((r) => r.fallback).map((r) => r.source);
const mismatched = reviewers.filter((r) => r.modelMismatch).map((r) => `${r.source} (ran ${r.resolvedModel}, panel expected ${r.expectedModel})`);

// Render.
const L = [];
L.push("# Quorum Review Report");
L.push("");
L.push(`- reviewers: ${reviewers.map((r) => r.source).join(", ")}${missing.length ? ` · no result: ${missing.join(", ")}` : ""}`);
L.push(`- panel: ${reviewers.length}/${panelSize} seat(s) delivered${missing.length ? ` — ${missing.length} expected seat(s) returned nothing (denominators below use ${panelSize})` : ""}`);
if (unexpected.length) L.push(`- ⚠ results not matching any expected seat (non-seat reviewer or wrong run?): ${unexpected.join(", ")}`);
if (fallbackSeats.length) L.push(`- ⚠ ran on a FALLBACK model (parent-session model, not the seat's pin — not an independent vote): ${fallbackSeats.join(", ")}`);
if (mismatched.length) L.push(`- ⚠ resolved model differs from the panel's effective model: ${mismatched.join("; ")}`);
if (meanConf !== null) L.push(`- mean verdict confidence: ${meanConf.toFixed(2)} (unweighted self-reported; not comparable across models)`);
L.push(`- findings: ${live.length} unique (${corr} corroborated by ≥2, ${uniq} single-reviewer${singleHigh.length ? `; **${singleHigh.length} single-seat P0/P1 — judge on merit or arbitrate, never drop for lack of consensus**` : ""})${refuted.length ? ` · ${refuted.length} refuted in verification (listed last)` : ""}`);
if (refuter) L.push(`- verification pass: ${refuter.source}${refuter.resolvedModel ? ` [${refuter.resolvedModel}]` : ""} re-checked ${refuter.matched} finding(s)${refuter.unmatched.length ? `; ${refuter.unmatched.length} unmatched (see stderr)` : ""}`);
L.push("");
L.push("## Panel verdict");
L.push("");
L.push(`- correct: ${votes.correct}/${panelSize} · incorrect: ${votes.incorrect}/${panelSize}${votes.missing ? ` · no verdict: ${votes.missing}` : ""}${missing.length ? ` · no result: ${missing.length}` : ""}`);
L.push("");
for (const r of reviewers) {
  const v = r.verdict.overall_correctness || "(no verdict)";
  const c = Number.isFinite(r.verdict.confidence) ? ` (conf ${r.verdict.confidence.toFixed(2)})` : "";
  const m = r.resolvedModel ? ` [${r.resolvedModel}${r.fallback ? " — FALLBACK" : ""}]` : "";
  const e = r.verdict.explanation ? ` — ${r.verdict.explanation}` : "";
  L.push(`- **${r.source}**${m}: ${v}${c}${e}`);
}
for (const s of missing) L.push(`- **${s}**: no result (seat failed or was not spawned)`);
L.push("");
L.push("## Findings");
L.push("");
function renderFinding(m) {
    const loc = m.file_path === "(no file)" ? "(no file)" : `\`${m.file_path}\``;
    const range = m.line_start != null && m.line_end != null ? `:${m.line_start}-${m.line_end}` : "";
    const corroboration = m.corroborated
      ? ` · **${m.count}/${panelSize}** (${m.reviewers.join(", ")})`
      : ` · 1/${panelSize} (${m.reviewers.join(", ")})`;
    const cat = m.category ? ` (${m.category})` : "";
    const verified = m.verification?.verdict === "CONFIRMED" ? " · ✔ verified" : "";
    L.push(`### ${loc}${range} · ${renderPriority(m.priority)}${cat} · conf ${m.confidence.toFixed(2)}${corroboration}${verified}`);
    L.push("");
    L.push(`**${m.title}**`);
    L.push("");
    L.push(m.cwe ? `${m.body} (CWE: ${m.cwe})` : m.body);
    if (m.verification) L.push("", `> ${m.verification.verdict}${m.verification.priority != null ? ` (re-assessed ${renderPriority(m.verification.priority)})` : ""}: ${m.verification.reason || "(no reason given)"}`);
    L.push("");
}
if (live.length === 0 && refuted.length === 0) {
  L.push("_No findings reported by any reviewer._");
} else {
  for (const m of live) renderFinding(m);
  if (refuted.length) {
    L.push("## Refuted in verification (shown for the record, not actioned)", "");
    for (const m of refuted) renderFinding(m);
  }
}

const report = L.join("\n");
if (args.out) {
  writeFileSync(args.out, report);
  if (args.json) {
    writeFileSync(args.out + ".report.json", JSON.stringify({
      reviewers: reviewers.map((r) => ({ source: r.source, seat: r.seat, resolvedModel: r.resolvedModel, fallback: r.fallback, ...r.verdict })),
      panel: { expected: args.expected, delivered: reviewers.length, size: panelSize, missing, unexpected },
      verdict: { votes, meanConfidence: meanConf },
      verification: refuter,
      findings: merged,
    }, null, 2));
  }
} else {
  process.stdout.write(report);
  if (args.json) {
    process.stdout.write("\n\n=== merged.json ===\n");
    process.stdout.write(JSON.stringify({
      reviewers: reviewers.map((r) => ({ source: r.source, seat: r.seat, resolvedModel: r.resolvedModel, fallback: r.fallback, ...r.verdict, findings: r.findings })),
      panel: { expected: args.expected, delivered: reviewers.length, size: panelSize, missing, unexpected },
      verdict: { votes, meanConfidence: meanConf },
      findings: merged,
    }, null, 2));
  }
}
console.error(
  `dedupe: ${reviewers.length}/${panelSize} reviewer file(s), ${live.length} unique findings (${corr} corroborated, ${singleHigh.length} single-seat P0/P1${refuted.length ? `, ${refuted.length} refuted` : ""})` +
  (missing.length ? `; NO RESULT from: ${missing.join(", ")}` : "") +
  (fallbackSeats.length ? `; FALLBACK model: ${fallbackSeats.join(", ")}` : "") +
  (mismatched.length ? `; MODEL MISMATCH: ${mismatched.length}` : "")
);
