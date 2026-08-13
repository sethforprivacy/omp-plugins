#!/usr/bin/env node
// packet.mjs — Assemble the quorum-review context packet (focus + session summary + changed files + diff).
// Deterministic context capture so every quorum reviewer sees the SAME scope.
//
// Usage:
//   packet.mjs --focus <text> [--summary <text>] [options]
//   packet.mjs --focus <text> [--files a,b,c]     # explicit changed-file list (no VCS needed)
//
// Options:
//   --focus <text>      Review focus (required). What "done / across the line" means.
//   --summary <text>    Session summary written by the main agent (what was done this session).
//   --files <a,b,c>     Explicit changed-file paths (absolute) instead of VCS diff.
//   --limit <bytes>     Max diff/embed bytes per section (default 100000).
//   --out <path>        Write markdown packet to <path> (default stdout).
//   --json              Also write machine-readable metadata to <path>.json (or stdout when no --out).
//
// Exit 0 on success. Writes the packet; any error exits 1 with a message on stderr.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

function fail(msg) {
  console.error(`packet: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { limit: 100000, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === "--focus") args.focus = val();
    else if (a === "--summary") args.summary = val();
    else if (a === "--files") args.files = val().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--limit") {
      const raw = val();
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) fail(`--limit must be a positive number, got "${raw}"`);
      args.limit = n;
    }
    else if (a === "--out") args.out = val();
    else if (a === "--json") args.json = true;
    else fail(`unknown arg ${a}`);
  }
  return args;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function truncate(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  const buf = Buffer.from(text, "utf8");
  const sliced = buf.subarray(0, limit);
  // avoid splitting a multi-byte char
  let end = sliced.length;
  while (end > 0 && (sliced[end - 1] & 0xc0) === 0x80) end--;
  const body = sliced.subarray(0, end).toString("utf8");
  return { text: `${body}\n\n... [truncated: ${buf.length} bytes total, showed ${limit}]`, truncated: true };
}

function detectVcs() {
  if (run("git", ["rev-parse", "--git-dir"])) return "git";
  if (run("jj", ["root"])) return "jj";
  return "none";
}

function gitMode(limit) {
  const cwd = process.cwd();
  const files = [];
  const status = run("git", ["status", "--short", "-uall"]) || "";
  for (const line of status.split("\n")) {
    const m = line.match(/^(..)\s+(.+)$/);
    if (m) files.push({ path: m[2], status: m[1] });
  }
  const hasHead = !!run("git", ["rev-parse", "--verify", "HEAD"]);
  let diff = hasHead ? run("git", ["diff", "HEAD"]) : run("git", ["diff"]);
  if (diff === null) diff = "";
  const d = truncate(diff, limit);
  const untracked = files.filter((f) => f.status.includes("?")).map((f) => f.path);
  // Newly created files are usually the point of a last-pass review but never appear in
  // `git diff HEAD` — embed their contents so the panel can review them too.
  const untrackedSection = [];
  let untrackedTruncated = false;
  for (const u of untracked) {
    let st;
    try {
      st = statSync(u);
    } catch {
      continue; // vanished between status and read
    }
    if (!st.isFile()) continue; // status collapses untracked DIRS to `?? dir/`; readFileSync would throw EISDIR
    const content = readFileSync(u, "utf8");
    const shown = truncate(content, limit);
    untrackedTruncated = untrackedTruncated || shown.truncated;
    untrackedSection.push(
      `### ${resolve(u)}\n\n\`\`\`\n${shown.text}\n\`\`\``
    );
  }
  return {
    vcs: "git", cwd, files, untracked,
    untrackedSection: untrackedSection.join("\n\n"),
    untrackedTruncated,
    diff: d.text, diffTruncated: d.truncated,
  };
}

function jjMode(limit) {
  const cwd = process.cwd();
  const status = run("jj", ["status"]) || "";
  const rawDiff = run("jj", ["diff", "--git"]) || "";
  const d = truncate(rawDiff, limit);
  // Files touched (filenames only, dedup)
  const files = [...new Set(
    (run("jj", ["diff", "--name-only"]) || "").split("\n").filter(Boolean).map((p) => ({ path: p, status: "M" })),
    (f) => f && f.path
  )];
  return { vcs: "jj", cwd, files: files ?? [], untracked: [], diff: d.text, diffTruncated: d.truncated, note: status.trim() || undefined };
}

function filesMode(paths, limit) {
  const sections = [];
  const meta = [];
  let totalBytes = 0;
  let truncatedAny = false;
  for (const p of paths) {
    if (!existsSync(p)) {
      meta.push({ path: p, status: "MISSING" });
      sections.push(`### ${p}\n\n(not found on disk)`);
      continue;
    }
    const content = readFileSync(p, "utf8");
    totalBytes += Buffer.byteLength(content);
    const shown = truncate(content, limit);
    truncatedAny = truncatedAny || shown.truncated;
    const rel = p.startsWith(process.cwd() + "/") ? p.slice(process.cwd().length + 1) : p;
    sections.push(`### ${p}${rel !== p ? ` (${rel})` : ""} — ${shown.truncated ? `truncated at ${limit} bytes` : Buffer.byteLength(content) + " bytes"}\n\n\`\`\`\n${shown.text}\n\`\`\``);
    meta.push({ path: p, bytes: Buffer.byteLength(content), truncated: shown.truncated });
  }
  return {
    vcs: "files",
    cwd: process.cwd(),
    files: paths.map((p) => ({ path: p, status: "CHANGED" })),
    untracked: [],
    diff: sections.join("\n\n"),
    diffTruncated: truncatedAny,
    totalBytes,
  };
}

const args = parseArgs(process.argv.slice(2));
if (!args.focus) fail("--focus <text> is required");

const vcs = args.files.length > 0 ? "files" : detectVcs();
let info;
if (vcs === "files") info = filesMode(args.files, args.limit);
else if (vcs === "git") info = gitMode(args.limit);
else if (vcs === "jj") info = jjMode(args.limit);
else fail("no VCS detected and --files not given; pass --files <paths> or run from a git/jj repo");

const md = [
  "# Review Packet",
  "",
  "- generated: " + new Date().toISOString(),
  `- cwd: \`${info.cwd}\``,
  `- vcs: ${info.vcs}`,
  "",
  "## Focus",
  "",
  args.focus.trim(),
  "",
];
if (args.summary) {
  md.push("## Session summary", "", args.summary.trim(), "");
}
md.push(
  "## Changed files",
  "",
  "| status | path |",
  "|--------|------|",
  ...(info.files.length
    ? info.files.map((f) => `| ${f.status} | \`${f.path}\` |`)
    : ["| - | (no changes detected) |"]),
  ""
);
if (info.vcs === "files") {
  // Each embedded file already carries its own code fence; an outer diff fence
  // would close on the first inner fence and leak the rest out of the block.
  md.push("## File contents", "", info.diff, "");
} else {
  md.push("## Diff / file contents", "", "```diff", info.diff, "```", "");
  if (info.untracked && info.untracked.length) {
    md.push(
      "",
      "## Untracked files (new, embedded below)",
      "",
      `New files not present in any diff${info.untrackedTruncated ? ` (each truncated at ${args.limit} bytes)` : ""}:`,
      "",
      info.untrackedSection || info.untracked.map((u) => `- \`${u}\``).join("\n"),
      ""
    );
  }
}
if (info.note) md.push("> " + info.note, "");

const packet = md.join("\n");
if (args.out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args.out, packet);
  if (args.json) {
    const jsonInfo = {
      generated: new Date().toISOString(),
      cwd: info.cwd,
      vcs: info.vcs,
      focus: args.focus.trim(),
      summary: args.summary?.trim(),
      files: info.files,
      untracked: info.untracked,
      diffTruncated: info.diffTruncated,
      packetPath: args.out,
    };
    writeFileSync(args.out + ".json", JSON.stringify(jsonInfo, null, 2));
  }
} else {
  process.stdout.write(packet);
  if (args.json) {
    process.stdout.write("\n\n=== packet.json ===\n");
    process.stdout.write(JSON.stringify({
      generated: new Date().toISOString(), cwd: info.cwd, vcs: info.vcs, files: info.files,
      untracked: info.untracked, diffTruncated: info.diffTruncated,
    }, null, 2));
  }
}
console.error(`packet: wrote ${info.files.length} changed file(s); diff ${info.diffTruncated ? "truncated" : "complete"} (${basename(args.out || "(stdout)")})`);
