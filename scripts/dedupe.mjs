#!/usr/bin/env node
// dedupe.mjs — Merge N quorum-reviewer findings files, dedupe across reviewers, and emit a
// consensus-ranked report. Deterministic: same inputs → same output (stable sort, no randomness).
//
// Usage:
//   dedupe.mjs <findings.json...> [--out <path>] [--json]
//   dedupe.mjs --dir <path>        # scan <path>/*.json for reviewer results
//
// Options:
//   --out <path>   Write markdown report to <path> (default stdout).
//   --json         Also write machine-readable merged JSON to <path>.json (or stdout when no --out).
//
// Input file shape (permissive extraction):
//   { findings: [...], overall_correctness?, explanation?, confidence? }
//   or same nested under result.data / data / output / result.
//   Each finding: { title, body, priority (0-3), confidence (0-1), file_path, line_start, line_end }.
//
// Dedup: cluster findings from different reviewers that describe the same issue. A finding in the
// same file clusters with an existing cluster when
//   (a) normalized titles match exactly, or
//   (b) line ranges overlap AND title-token Jaccard similarity >= 0.5.
// Canonical member = highest (priority desc, confidence desc, body length desc). Report shows
// corroboration count (≥2 reviewers) so the session can weight consensus.

import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function fail(msg) {
  console.error(`dedupe: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { files: [], dir: null, out: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--out") args.out = val();
    else if (a === "--json") args.json = true;
    else if (a === "--dir") args.dir = val();
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

function sameIssue(a, b) {
  if (a.fileKey !== b.fileKey) return false;
  if (normalizeTitle(a.title) === normalizeTitle(b.title)) return true;
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
  return {
    verdict: {
      overall_correctness: src.overall_correctness,
      explanation: src.explanation,
      confidence: src.confidence,
    },
    findings,
  };
}

function renderPriority(p) {
  return p === 0 ? "P0" : p === 1 ? "P1" : p === 2 ? "P2" : "P3";
}

const args = parseArgs(process.argv.slice(2));
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
  const { verdict, findings } = extract(raw);
  const source = f.replace(/\.json$/i, "").split(/[\\/]/).pop();
  reviewers.push({ source, verdict, findings, raw });
}
if (reviewers.length === 0) fail(`no reviewer files could be parsed (${skipped.length} skipped)`);

// Flatten all findings with provenance.
const clusterKey = new Map();
const clusters = [];
const byFile = new Map();
for (let ri = 0; ri < reviewers.length; ri++) {
  for (const f of reviewers[ri].findings) {
    if (!f || typeof f !== "object") continue;
    const fileKey = String(f.file_path || "(no file)");
    const item = {
      ri,
      source: reviewers[ri].source,
      title: String(f.title || ""),
      body: String(f.body || ""),
      priority: Number.isFinite(f.priority) ? f.priority : 3,
      confidence: Number.isFinite(f.confidence) ? f.confidence : 0,
      file_path: fileKey,
      line_start: Number.isFinite(f.line_start) ? f.line_start : null,
      line_end: Number.isFinite(f.line_end) ? f.line_end : null,
      fileKey,
    };
    const fileClusters = byFile.get(fileKey) || (byFile.set(fileKey, []).get(fileKey));
    let matched = null;
    for (const c of fileClusters) {
      if (c.items.some((m) => sameIssue(item, m))) { matched = c; break; }
    }
    if (matched) {
      matched.items.push(item);
    } else {
      const c = { items: [item] };
      fileClusters.push(c);
      clusters.push(c);
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
    reviewers: sources,
    count: sources.length,
    corroborated: sources.length >= 2,
    members: items.map((it) => ({ source: it.source, priority: it.priority, confidence: it.confidence })),
  };
});

const sortKey = (m) => [
  m.file_path,
  m.priority,                      // P0 first
  -m.count,                        // more corroboration first
  -(m.confidence ?? 0),
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

const corr = merged.filter((m) => m.corroborated).length;
const uniq = merged.length - corr;

// Render.
const L = [];
L.push("# Quorum Review Report");
L.push("");
L.push(`- reviewers: ${reviewers.map((r) => r.source).join(", ")}`);
if (meanConf !== null) L.push(`- mean verdict confidence: ${meanConf.toFixed(2)}`);
L.push(`- findings: ${merged.length} unique (${corr} corroborated by ≥2, ${uniq} single-reviewer)`);
L.push("");
L.push("## Panel verdict");
L.push("");
L.push(`- correct: ${votes.correct}/${reviewers.length} · incorrect: ${votes.incorrect}/${reviewers.length}${votes.missing ? ` · no verdict: ${votes.missing}` : ""}`);
L.push("");
for (const r of reviewers) {
  const v = r.verdict.overall_correctness || "(no verdict)";
  const c = Number.isFinite(r.verdict.confidence) ? ` (conf ${r.verdict.confidence.toFixed(2)})` : "";
  const e = r.verdict.explanation ? ` — ${r.verdict.explanation}` : "";
  L.push(`- **${r.source}**: ${v}${c}${e}`);
}
L.push("");
L.push("## Findings");
L.push("");
if (merged.length === 0) {
  L.push("_No findings reported by any reviewer._");
} else {
  for (const m of merged) {
    const loc = m.file_path === "(no file)" ? "(no file)" : `\`${m.file_path}\``;
    const range = m.line_start != null && m.line_end != null ? `:${m.line_start}-${m.line_end}` : "";
    const corroboration = m.corroborated
      ? ` · **${m.count}/${reviewers.length}** (${m.reviewers.join(", ")})`
      : ` · 1/${reviewers.length} (${m.reviewers.join(", ")})`;
    L.push(`### ${loc}${range} · ${renderPriority(m.priority)} · conf ${m.confidence.toFixed(2)}${corroboration}`);
    L.push("");
    L.push(`**${m.title}**`);
    L.push("");
    L.push(m.body);
    L.push("");
  }
}

const report = L.join("\n");
if (args.out) {
  writeFileSync(args.out, report);
  if (args.json) {
    writeFileSync(args.out + ".report.json", JSON.stringify({
      reviewers: reviewers.map((r) => ({ source: r.source, ...r.verdict })),
      verdict: { votes, meanConfidence: meanConf },
      findings: merged,
    }, null, 2));
  }
} else {
  process.stdout.write(report);
  if (args.json) {
    process.stdout.write("\n\n=== merged.json ===\n");
    process.stdout.write(JSON.stringify({ reviewers, verdict: { votes, meanConfidence: meanConf }, findings: merged }, null, 2));
  }
}
console.error(`dedupe: ${reviewers.length} reviewer file(s), ${merged.length} unique findings (${corr} corroborated)`);
