#!/usr/bin/env node
// panel.mjs — List the ACTIVE quorum panel seats from ~/.omp/agent/agents/rev-quorum-*.md.
// The panel is discovered dynamically so the panel (size + models) changes by editing
// those agent files alone — no skill edits needed.
//
// Usage:
//   panel.mjs [--json] [--prefix <seat-prefix>]
//   panel.mjs --agents-dir <path>   # override agent discovery dir
//
// Output (markdown):
//   rev-quorum-b — venice/moonshotai/kimi-k3
// Active = file matches <prefix>*.md (default prefix `rev-quorum-`), has frontmatter
// `name:` and `model:`, and is not `disable: true`. Skills that maintain their own panel
// family pass `--prefix` (e.g. `rev-sec-` for the security-quorum panel).

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function home() {
  return process.env.HOME || process.env.USERPROFILE;
}

function parseArgs(argv) {
  const args = { json: false, prefix: "rev-quorum-", dir: join(home(), ".omp", "agent", "agents") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--agents-dir") args.dir = argv[++i];
    else if (a === "--prefix") args.prefix = argv[++i];
    else {
      console.error(`panel: unknown arg ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function frontmatterField(content, field) {
  const m = content.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

function isDisabled(content) {
  const d = frontmatterField(content, "disable");
  return d === "true" || d === "yes";
}

const args = parseArgs(process.argv.slice(2));
if (!existsSync(args.dir)) {
  console.error(`panel: agents dir not found: ${args.dir}`);
  process.exit(1);
}

const seats = [];
for (const f of readdirSync(args.dir).sort()) {
  if (!new RegExp(`^${args.prefix}.*\\.md$`).test(f)) continue;
  const content = readFileSync(join(args.dir, f), "utf8");
  if (isDisabled(content)) continue;
  const name = frontmatterField(content, "name") || f.replace(/\.md$/, "");
  const model = frontmatterField(content, "model");
  seats.push({ name, model: model || "(no model)", file: f });
}

if (seats.length === 0) {
  console.error("panel: no active rev-quorum-* seats found");
  process.exit(1);
}

if (args.json) {
  process.stdout.write(JSON.stringify(seats, null, 2) + "\n");
} else {
  for (const s of seats) process.stdout.write(`${s.name} — ${s.model}\n`);
}
