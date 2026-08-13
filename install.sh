#!/usr/bin/env bash
# install.sh — install (or refresh) the quorum-review skill bundle into an OMP/opencode install.
#
# Idempotent: safe to re-run after `git pull`. Existing files we manage are backed up
# (once, timestamped) before overwrite, so local tuning is never silently clobbered.
#
# Defaults (standard OMP global layout):
#   SKILL_DIR   = $XDG_CONFIG_HOME (or ~/.config)/opencode/skills/quorum-review
#   AGENTS_DIR  = $HOME/.omp/agent/agents
#
# Overrides (env) — useful for test homes and nonstandard installs:
#   QUORUM_SKILL_DIR=...   QUORUM_AGENTS_DIR=...   OMP_HOME=...
#
# Usage:
#   ./install.sh            # install; backups created for anything replaced
#   ./install.sh --dry-run  # show targets and what would be copied, change nothing
#   ./install.sh --no-backup
#   ./install.sh --help

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_NAME="quorum-review"

DRY_RUN=0
BACKUP=1

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-backup) BACKUP=0 ;;
    --help|-h) sed -n '1,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install: unknown arg '$arg' (see --help)" >&2; exit 2 ;;
  esac
done

OMP_HOME="${OMP_HOME:-$HOME/.omp}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
SKILL_DIR="${QUORUM_SKILL_DIR:-$CONFIG_HOME/opencode/skills/$SKILL_NAME}"
AGENTS_DIR="${QUORUM_AGENTS_DIR:-$OMP_HOME/agent/agents}"

echo "install: target SKILL_DIR=$SKILL_DIR"
echo "install: target AGENTS_DIR=$AGENTS_DIR"

# Sanity: bundle must look complete.
for f in "$REPO_ROOT/SKILL.md" "$REPO_ROOT/scripts/panel.mjs" "$REPO_ROOT/scripts/packet.mjs" "$REPO_ROOT/scripts/dedupe.mjs"; do
  [ -f "$f" ] || { echo "install: bundle incomplete (missing $f)" >&2; exit 1; }
done

if [ "$DRY_RUN" -eq 1 ]; then
  echo "install: DRY RUN — no changes"
  echo "install:   would copy: SKILL.md, scripts/*.mjs -> $SKILL_DIR/"
  mkdir -p "$AGENTS_DIR" 2>/dev/null || true
  for f in "$REPO_ROOT"/agents/rev-quorum-*.md; do
    echo "install:   would copy: $(basename "$f") -> $AGENTS_DIR/"
  done
  exit 0
fi

mkdir -p "$SKILL_DIR/scripts" "$AGENTS_DIR"

# Backup anything we replace, once per run, only if it differs from the bundle.
backup() {
  [ "$BACKUP" -eq 1 ] || return 0
  local dst="$1"
  [ -e "$dst" ] || return 0
  if cmp -s "$dst" "$2"; then return 0; fi
  local stamp bak
  stamp="$(date +%Y%m%d-%H%M%S)"
  case "$dst" in
    *"$SKILL_NAME/scripts/"*) bak="$SKILL_DIR/scripts/.quorum-backup-$stamp" ;;
    *"$SKILL_NAME/"*)         bak="$SKILL_DIR/.quorum-backup-$stamp" ;;
    *)                        bak="$OMP_HOME/quorum-backup-$stamp" ;;
  esac
  mkdir -p "$bak"
  cp -p "$dst" "$bak/"
  echo "install: backed up $(basename "$dst") -> $bak/"
}

backup "$SKILL_DIR/SKILL.md" "$REPO_ROOT/SKILL.md"
cp "$REPO_ROOT/SKILL.md" "$SKILL_DIR/SKILL.md"

for s in "$REPO_ROOT"/scripts/*.mjs; do
  backup "$SKILL_DIR/scripts/$(basename "$s")" "$s"
  cp "$s" "$SKILL_DIR/scripts/"
done
chmod +x "$SKILL_DIR"/scripts/*.mjs 2>/dev/null || true

for a in "$REPO_ROOT"/agents/rev-quorum-*.md; do
  f="$(basename "$a")"
  backup "$AGENTS_DIR/$f" "$a"
  cp "$a" "$AGENTS_DIR/$f"
done

echo "install: files installed."
if command -v node >/dev/null 2>&1; then
  echo "install: active panel discovered at install time:"
  node "$SKILL_DIR/scripts/panel.mjs" || echo "install: (panel.mjs failed — check the seat files; see README)" >&2
else
  echo "install: node not found — scripts need Node 18+ (panel/packet/dedupe will not run until it is installed)." >&2
fi
echo "install: done. In an OMP session, mention 'panel review' or 'quorum' to use the skill."
