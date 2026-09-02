#!/usr/bin/env node
// collect.mjs — Collect seat results STRAIGHT FROM OMP's subagent transcripts, with provenance.
//
// OMP writes one transcript per spawned subagent next to the parent session file:
//   ~/.omp/agent/sessions/<cwd-slug>/<session-id>/<task name>.jsonl
// Each transcript records the agent that ran (`session_init.agent`), the model it ACTUALLY ran on
// (`session_init.resolvedModel`, `model_change.model` + `resolvedModelIsFallback`), the thinking
// level, every `yield` call the seat made, and the assembled final result. That is the ground
// truth for the panel's provenance check — the orchestrator never has to remember or transcribe.
//
// Usage:
//   collect.mjs [--prefix rev-quorum-] [--out <results-dir>] [--session-dir <dir>] [--since <min>]
//               [--all] [--json]
//
// Options:
//   --prefix <p>        Seat family to collect (default rev-quorum-; security: rev-sec-).
//   --out <dir>         Write one <seat>-<timestamp>.json per transcript into <dir> (created if
//                       needed): the seat's assembled result.data VERBATIM plus top-level
//                       provenance fields (seat, resolvedModel, resolvedModelIsFallback,
//                       thinkingLevel, transcript, startedAt, endedAt, status). Feed these files to
//                       dedupe.mjs (they carry `agent`/`resolvedModel`, so `--panel` cross-checks).
//   --session-dir <d>   The parent session's subagent dir. Default: scan every session dir under
//                       ~/.omp/agent/sessions for transcripts modified in the last --since minutes.
//   --since <minutes>   Freshness window for the default scan (default 360).
//   --all               Keep every transcript per seat (retries too). Default: newest per seat.
//   --json              Print the collected summary as JSON on stdout instead of the table.
//
// Status per transcript: delivered (verdict present), verdict-only (verdict, zero findings),
// partial (findings but no verdict), no-yield (never yielded — prose only), and a FALLBACK flag
// when OMP ran the seat on the parent session's model because the assigned model had no working
// route or credentials. Exit code 0 when at least one transcript was found; 1 otherwise.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

function fail(msg) {
  console.error(`collect: ${msg}`);
  process.exit(1);
}
function home() {
  return process.env.HOME || process.env.USERPROFILE;
}

function parseArgs(argv) {
  const args = { prefix: "rev-quorum-", out: null, sessionDir: null, since: 360, all: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--prefix") args.prefix = val();
    else if (a === "--out") args.out = val();
    else if (a === "--session-dir") args.sessionDir = val();
    else if (a === "--since") {
      const n = Number(val());
      if (!Number.isFinite(n) || n <= 0) fail("--since must be a positive number of minutes");
      args.since = n;
    }
    else if (a === "--all") args.all = true;
    else if (a === "--json") args.json = true;
    else fail(`unknown arg ${a}`);
  }
  return args;
}

// --- discovery -------------------------------------------------------------------------

function subagentDirs(root, sinceMs) {
  const out = [];
  if (!existsSync(root)) return out;
  const cutoff = Date.now() - sinceMs;
  for (const slug of readdirSync(root)) {
    const slugDir = join(root, slug);
    let entries;
    try { if (!statSync(slugDir).isDirectory()) continue; entries = readdirSync(slugDir); } catch { continue; }
    for (const e of entries) {
      const d = join(slugDir, e);
      try {
        const st = statSync(d);
        if (st.isDirectory() && st.mtimeMs >= cutoff) out.push(d);
      } catch { /* vanished */ }
    }
  }
  return out;
}

function transcriptsIn(dir, prefix) {
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dir, f);
    try { if (!statSync(p).isFile()) continue; } catch { continue; }
    // Task names default to the seat name (SKILL.md), but match on the recorded agent, not the
    // filename: a renamed task or a "-2" retry suffix must still be attributed to its seat.
    const head = readFileSync(p, "utf8").slice(0, 200000);
    const m = head.match(/"type":"session_init"[^\n]*?"agent":"([^"]+)"/);
    if (m && m[1].startsWith(prefix)) out.push(p);
  }
  return out;
}

// --- parsing ---------------------------------------------------------------------------

// Seats emit `type` as ["findings"], "findings", or a STRINGIFIED array '["findings"]' (observed
// from glm). Normalize to the bare section name, or null when absent.
function yieldType(raw) {
  let v = raw;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) { try { v = JSON.parse(s); } catch { v = s; } }
  }
  if (Array.isArray(v)) v = v[0];
  return typeof v === "string" ? v.replace(/^["'\[]+|["'\]]+$/g, "").trim() || null : null;
}

function parseTranscript(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const rec = {
    transcript: path, taskName: basename(path, ".jsonl"), agent: null, resolvedModel: null,
    resolvedModelIsFallback: null, thinkingLevel: null, startedAt: null, endedAt: null, exitKind: null,
    findings: [], verdict: {}, assembled: null, yields: 0, records: lines.length,
  };
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.timestamp) {
      if (!rec.startedAt) rec.startedAt = r.timestamp;
      rec.endedAt = r.timestamp;
    }
    switch (r.type) {
      case "session_init":
        rec.agent = r.agent ?? rec.agent;
        rec.resolvedModel = r.resolvedModel ?? rec.resolvedModel;
        break;
      case "model_change":
        if (r.model) rec.resolvedModel = r.model;
        if (typeof r.resolvedModelIsFallback === "boolean") rec.resolvedModelIsFallback = r.resolvedModelIsFallback;
        break;
      case "thinking_level_change":
        rec.thinkingLevel = r.thinkingLevel ?? rec.thinkingLevel;
        break;
      case "custom":
        if (r.customType === "session_exit") rec.exitKind = r.data?.kind ?? r.data?.reason ?? null;
        break;
      case "message": {
        const msg = r.message || {};
        if (msg.role === "toolResult" && msg.toolName === "yield") {
          // Idle finalization assembles the whole result here; prefer it when present.
          const data = msg.details?.data;
          if (data && typeof data === "object" && (data.overall_correctness !== undefined || Array.isArray(data.findings))) rec.assembled = data;
        }
        const parts = Array.isArray(msg.content) ? msg.content : [];
        for (const p of parts) {
          if (!p || p.type !== "toolCall" || p.name !== "yield") continue;
          rec.yields++;
          const a = (p.arguments && typeof p.arguments === "object") ? p.arguments : {};
          const t = yieldType(a.type);
          const data = a.result && typeof a.result === "object" && "data" in a.result ? a.result.data : a.result;
          if (t === "findings") {
            if (Array.isArray(data)) rec.findings.push(...data.filter((f) => f && typeof f === "object"));
            else if (data && typeof data === "object") rec.findings.push(data);
          } else if (t === "overall_correctness" || t === "explanation" || t === "confidence") {
            rec.verdict[t] = data;
          } else if (data && typeof data === "object" && !Array.isArray(data)) {
            if (data.overall_correctness !== undefined || Array.isArray(data.findings) || data.explanation !== undefined) {
              for (const k of ["overall_correctness", "explanation", "confidence"]) if (data[k] !== undefined) rec.verdict[k] = data[k];
              if (Array.isArray(data.findings)) rec.findings.push(...data.findings.filter((f) => f && typeof f === "object"));
            } else if (data.title !== undefined && data.body !== undefined) {
              rec.findings.push(data); // untyped yield carrying a finding object (observed: glm)
            }
          } else if (Array.isArray(data) && data.every((f) => f && typeof f === "object" && f.title !== undefined)) {
            rec.findings.push(...data);
          } else if (typeof data === "string") {
            // Untyped bare-value yields: verdict enum, else the explanation.
            const s = data.trim().toLowerCase();
            if (s === "correct" || s === "incorrect") rec.verdict.overall_correctness = s;
            else if (data.trim()) rec.verdict.explanation = data;
          } else if (typeof data === "number" && data >= 0 && data <= 1) {
            rec.verdict.confidence = data;
          }
        }
        break;
      }
      default:
        break;
    }
  }
  // Final result object: assembled payload when OMP produced one, else what the yields built.
  const base = rec.assembled && typeof rec.assembled === "object" ? { ...rec.assembled } : { ...rec.verdict };
  if (!Array.isArray(base.findings) || base.findings.length === 0) base.findings = rec.findings;
  rec.result = base;
  const hasVerdict = base.overall_correctness !== undefined;
  rec.status = hasVerdict
    ? (base.findings.length ? "delivered" : "verdict-only")
    : (base.findings.length ? "partial" : (rec.yields ? "partial" : "no-yield"));
  return rec;
}

// --- main ------------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
let dirs;
if (args.sessionDir) {
  if (!existsSync(args.sessionDir)) fail(`--session-dir not found: ${args.sessionDir}`);
  dirs = [args.sessionDir];
} else {
  dirs = subagentDirs(join(home(), ".omp", "agent", "sessions"), args.since * 60 * 1000);
}
const files = dirs.flatMap((d) => transcriptsIn(d, args.prefix));
if (files.length === 0) fail(`no ${args.prefix}* subagent transcripts found in ${args.sessionDir || `sessions modified in the last ${args.since} min`} — did the seats spawn, and is this the right session?`);

let recs = files.map(parseTranscript).sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
if (!args.all) {
  const latest = new Map();
  for (const r of recs) latest.set(r.agent, r); // sorted ascending → last write wins
  recs = [...latest.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

const written = [];
if (args.out) {
  mkdirSync(args.out, { recursive: true });
  for (const r of recs) {
    const ts = String(r.startedAt || new Date().toISOString()).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const file = join(args.out, `${r.agent}-${ts}.json`);
    const payload = {
      seat: r.agent,
      agent: r.agent,
      resolvedModel: r.resolvedModel,
      resolvedModelIsFallback: r.resolvedModelIsFallback,
      thinkingLevel: r.thinkingLevel,
      transcript: r.transcript,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      exitKind: r.exitKind,
      status: r.status,
      ...r.result, // overall_correctness, explanation, confidence, findings — verbatim
    };
    writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
    written.push(file);
    r.file = file;
  }
}

const rows = recs.map((r) => ({
  seat: r.agent, model: r.resolvedModel, fallback: r.resolvedModelIsFallback, level: r.thinkingLevel,
  status: r.status, verdict: r.result.overall_correctness ?? null, findings: r.result.findings.length,
  yields: r.yields, startedAt: r.startedAt, endedAt: r.endedAt, exit: r.exitKind, transcript: r.transcript, file: r.file || null,
}));

if (args.json) {
  process.stdout.write(JSON.stringify({ prefix: args.prefix, sessionDirs: dirs.filter((d) => files.some((f) => f.startsWith(d))), seats: rows }, null, 2) + "\n");
} else {
  process.stdout.write("| seat | resolved model | fallback | level | status | verdict | findings | transcript |\n|---|---|---|---|---|---|---|---|\n");
  for (const r of rows) {
    process.stdout.write(`| ${r.seat} | ${r.model || "?"} | ${r.fallback === true ? "**YES**" : r.fallback === false ? "no" : "?"} | ${r.level || "?"} | ${r.status} | ${r.verdict ?? "—"} | ${r.findings} | \`${basename(r.transcript)}\` |\n`);
  }
}
const fallbacks = rows.filter((r) => r.fallback === true).map((r) => r.seat);
const noYield = rows.filter((r) => r.status === "no-yield").map((r) => r.seat);
console.error(
  `collect: ${rows.length} seat transcript(s)` + (written.length ? `, wrote ${written.length} result file(s) to ${args.out}` : "") +
  (fallbacks.length ? `; FALLBACK (not independent — treat as failed): ${fallbacks.join(", ")}` : "") +
  (noYield.length ? `; NO YIELD (failed seat): ${noYield.join(", ")}` : "")
);
