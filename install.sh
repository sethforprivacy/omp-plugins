#!/usr/bin/env bash
# install.sh — install (or refresh) the OMP skills bundle into an OMP install.
#
# The bundle hosts multiple skills under skills/<name>/. Each skill installs to
#   $HOME/.omp/agent/skills/<name>/            (SKILL.md + scripts/)
# and its seat agents copy to $HOME/.omp/agent/agents/.
# The protocol scripts in scripts/ are the SHARED source of truth; they are copied into
# every skill's installed scripts/ dir. Skill-local scripts under skills/<name>/scripts/
# copy on top (overriding shared names when they collide).
#
# Idempotent: safe to re-run after `git pull`. Existing files we manage are backed up
# (once, timestamped) before overwrite, so local tuning is never silently clobbered.
#
# Defaults (standard OMP global layout):
#   SKILLS_DIR   = $HOME/.omp/agent/skills
#   AGENTS_DIR   = $HOME/.omp/agent/agents
#
# Overrides (env) — useful for test homes and nonstandard installs:
#   QUORUM_AGENTS_DIR=...   OMP_HOME=...
#
# Usage:
#   ./install.sh            # install; backups created for anything replaced
#   ./install.sh --dry-run  # show targets and what would be copied, change nothing
#   ./install.sh --no-backup
#   ./install.sh --help

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
SKILLS_DIR="${QUORUM_SKILLS_DIR:-$OMP_HOME/agent/skills}"
AGENTS_DIR="${QUORUM_AGENTS_DIR:-$OMP_HOME/agent/agents}"

echo "install: target SKILLS_DIR=$SKILLS_DIR"
echo "install: target AGENTS_DIR=$AGENTS_DIR"

# Sanity: shared protocol scripts must exist.
SHARED_SCRIPTS=("$REPO_ROOT"/scripts/*.mjs)
[ "${#SHARED_SCRIPTS[@]}" -gt 0 ] || { echo "install: bundle incomplete (no scripts/)" >&2; exit 1; }

# Discover skills: every skills/<name>/ containing a SKILL.md.
SKILL_DIRS=()
for d in "$REPO_ROOT"/skills/*/; do
  [ -d "$d" ] || continue
  [ -f "$d/SKILL.md" ] || { echo "install: skills/$(basename "$d") has no SKILL.md — fix before installing" >&2; exit 1; }
  SKILL_DIRS+=("$d")
done
[ "${#SKILL_DIRS[@]}" -gt 0 ] || { echo "install: no skills/*/ found" >&2; exit 1; }

# Each skill's panel seat prefix comes from its SKILL.md frontmatter (`panel_prefix:`),
# default rev-quorum- (general review panel).
panel_prefix() {
  sed -n 's/^panel_prefix:[[:space:]]*//p' "$1" | head -n1
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "install: DRY RUN — no changes"
  for d in "${SKILL_DIRS[@]}"; do
    name="$(basename "$d")"
    prefix="$(panel_prefix "$d/SKILL.md")"
    echo "install:   skill $name (panel prefix: ${prefix:-rev-quorum-})"
    echo "install:     would copy: SKILL.md + shared scripts -> $SKILLS_DIR/$name/"
    for s in "$d"/scripts/*.mjs; do
      [ -e "$s" ] && echo "install:     would copy: scripts/$(basename "$s") -> $SKILLS_DIR/$name/"
    done
    for a in "$d"/agents/*.md; do
      [ -e "$a" ] && echo "install:     would copy: $(basename "$a") -> $AGENTS_DIR/"
    done
  done
  exit 0
fi

mkdir -p "$SKILLS_DIR" "$AGENTS_DIR"

# Backup anything we replace, once per run, only if it differs from the bundle.
backup() {
  [ "$BACKUP" -eq 1 ] || return 0
  local dst="$1"
  [ -e "$dst" ] || return 0
  if cmp -s "$dst" "$2"; then return 0; fi
  local stamp bak
  stamp="$(date +%Y%m%d-%H%M%S)"
  bak="$OMP_HOME/skills-backup-$stamp"
  mkdir -p "$bak"
  cp -p "$dst" "$bak/"
  echo "install: backed up $(basename "$dst") -> $bak/"
}

for d in "${SKILL_DIRS[@]}"; do
  name="$(basename "$d")"
  dest="$SKILLS_DIR/$name"
  mkdir -p "$dest/scripts"

  backup "$dest/SKILL.md" "$d/SKILL.md"
  cp "$d/SKILL.md" "$dest/SKILL.md"

  # Shared protocol scripts, then any skill-local overrides.
  for s in "$REPO_ROOT"/scripts/*.mjs; do
    backup "$dest/scripts/$(basename "$s")" "$s"
    cp "$s" "$dest/scripts/"
  done
  for s in "$d"/scripts/*.mjs; do
    [ -e "$s" ] || continue
    backup "$dest/scripts/$(basename "$s")" "$s"
    cp "$s" "$dest/scripts/"
  done
  chmod +x "$dest"/scripts/*.mjs 2>/dev/null || true

  for a in "$d"/agents/*.md; do
    [ -e "$a" ] || continue
    f="$(basename "$a")"
    backup "$AGENTS_DIR/$f" "$a"
    cp "$a" "$AGENTS_DIR/$f"
  done
done

echo "install: files installed."
if command -v node >/dev/null 2>&1; then
  for d in "${SKILL_DIRS[@]}"; do
    name="$(basename "$d")"
    prefix="$(panel_prefix "$d/SKILL.md")"
    echo "install: active panel ($name, prefix ${prefix:-rev-quorum-}) discovered at install time:"
    node "$SKILLS_DIR/$name/scripts/panel.mjs" --prefix "${prefix:-rev-quorum-}" \
      || echo "install: (panel.mjs failed for $name — check the seat files; see README)" >&2
  done
else
  echo "install: node not found — scripts need Node 18+ (panel/packet/dedupe will not run until it is installed)." >&2
fi

for d in "${SKILL_DIRS[@]}"; do
  name="$(basename "$d")"
  LEGACY_SKILL_DIR="$CONFIG_HOME/opencode/skills/$name"
  if [ -e "$LEGACY_SKILL_DIR" ]; then
    echo "install: WARNING — legacy OpenCode-config copy found at $LEGACY_SKILL_DIR (pre-OMP path)."
    echo "install:   It is no longer the install target and will be shadowed by the OMP-native copy. Remove it with:"
    echo "install:   rm -rf \"$LEGACY_SKILL_DIR\""
  fi
done
echo "install: done. In an OMP session, mention 'panel review'/'quorum' or 'security review' to use the skills."
