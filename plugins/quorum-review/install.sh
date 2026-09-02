#!/usr/bin/env bash
# install.sh — MANUAL install (or refresh) of the quorum-review bundle into an OMP install.
#
# Preferred path is the OMP plugin (no copy step, upgrades via `omp plugin upgrade`):
#   omp plugin marketplace add sethforprivacy/omp-plugins
#   omp plugin install quorum-review@omp-plugins
# Use this script only where plugins are not an option. Hand-copied files SHADOW plugin files of
# the same name, so never run both: `./install.sh --uninstall` removes the manual copies.
#
# Layout it installs from (this plugin dir):
#   skills/<skill>/SKILL.md      -> $HOME/.omp/agent/skills/<skill>/SKILL.md
#   skills/quorum-review/scripts -> $HOME/.omp/agent/skills/quorum-review/scripts/
#   agents/rev-*.md              -> $HOME/.omp/agent/agents/
# The protocol scripts live in ONE place (the quorum-review skill dir); security-quorum's SKILL.md
# points there.
#
# Idempotent: safe to re-run after `git pull`. Existing files we manage are backed up
# (once, timestamped) before overwrite, so local tuning is never silently clobbered.
#
# Defaults (standard OMP global layout):
#   SKILLS_DIR   = $HOME/.omp/agent/skills
#   AGENTS_DIR   = $HOME/.omp/agent/agents
# Overrides (env): QUORUM_SKILLS_DIR, QUORUM_AGENTS_DIR, OMP_HOME
#
# Usage:
#   ./install.sh              # lint the bundle, then install; backups created for anything replaced
#   ./install.sh --dry-run    # show targets and what would be copied, change nothing
#   ./install.sh --uninstall  # remove the manual copies (skills + rev-* seats); backups are kept
#   ./install.sh --no-backup
#   ./install.sh --no-lint    # skip the pre-install consistency lint (scripts/lint-quorum-review.mjs)
#   ./install.sh --help
#
# Seat models are assigned in OMP config, never in seat files: see presets/README.md
# (OMP `task.agentModelOverrides`, per seat name; `omp --config <preset>.yml` for one run).

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"      # this script lives in the plugin dir
REPO_ROOT="$(cd "$PLUGIN_DIR/../.." && pwd)"                       # marketplace repo root (scripts/lint-*.mjs)

DRY_RUN=0
BACKUP=1
LINT=1
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-backup) BACKUP=0 ;;
    --no-lint) LINT=0 ;;
    --uninstall) UNINSTALL=1 ;;
    --help|-h) sed -n '1,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install: unknown arg '$arg' (see --help)" >&2; exit 2 ;;
  esac
done

OMP_HOME="${OMP_HOME:-$HOME/.omp}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
SKILLS_DIR="${QUORUM_SKILLS_DIR:-$OMP_HOME/agent/skills}"
AGENTS_DIR="${QUORUM_AGENTS_DIR:-$OMP_HOME/agent/agents}"

echo "install: target SKILLS_DIR=$SKILLS_DIR"
echo "install: target AGENTS_DIR=$AGENTS_DIR"

[ -d "$PLUGIN_DIR/skills" ] || { echo "install: bundle incomplete (no skills/ next to install.sh)" >&2; exit 1; }
SCRIPTS_SRC="$PLUGIN_DIR/skills/quorum-review/scripts"
[ -d "$SCRIPTS_SRC" ] || { echo "install: bundle incomplete (no $SCRIPTS_SRC)" >&2; exit 1; }

# Discover skills: every skills/<name>/ containing a SKILL.md.
SKILL_DIRS=()
for d in "$PLUGIN_DIR"/skills/*/; do
  [ -d "$d" ] || continue
  [ -f "$d/SKILL.md" ] || { echo "install: skills/$(basename "$d") has no SKILL.md — fix before installing" >&2; exit 1; }
  SKILL_DIRS+=("$d")
done
[ "${#SKILL_DIRS[@]}" -gt 0 ] || { echo "install: no skills/*/ found" >&2; exit 1; }

panel_prefix() {
  sed -n 's/^panel_prefix:[[:space:]]*//p' "$1" | head -n1
}

# Backup anything we replace, once per run, only if it differs from the bundle.
backup() {
  [ "$BACKUP" -eq 1 ] || return 0
  local dst="$1"
  [ -e "$dst" ] || return 0
  if [ -n "${2:-}" ] && cmp -s "$dst" "$2"; then return 0; fi
  local stamp bak
  stamp="$(date +%Y%m%d-%H%M%S)"
  bak="$OMP_HOME/skills-backup-$stamp"
  mkdir -p "$bak"
  cp -p "$dst" "$bak/"
  echo "install: backed up $(basename "$dst") -> $bak/"
}

if [ "$UNINSTALL" -eq 1 ]; then
  echo "install: UNINSTALL — removing manual copies (plugin installs are untouched)"
  for d in "${SKILL_DIRS[@]}"; do
    name="$(basename "$d")"
    if [ -d "$SKILLS_DIR/$name" ]; then
      [ "$DRY_RUN" -eq 1 ] && echo "install:   would remove $SKILLS_DIR/$name" || { rm -rf "$SKILLS_DIR/$name"; echo "install:   removed $SKILLS_DIR/$name"; }
    fi
  done
  for a in "$PLUGIN_DIR"/agents/rev-*.md; do
    f="$(basename "$a")"
    if [ -e "$AGENTS_DIR/$f" ]; then
      [ "$DRY_RUN" -eq 1 ] && echo "install:   would remove $AGENTS_DIR/$f" || { backup "$AGENTS_DIR/$f"; rm -f "$AGENTS_DIR/$f"; echo "install:   removed $AGENTS_DIR/$f"; }
    fi
  done
  echo "install: done."
  exit 0
fi

# Refuse to install a bundle that fails its own consistency lint (seat/schema drift, write tools
# on a seat, a seat that can spawn helpers, category enums out of sync with dedupe, ...).
if [ "$LINT" -eq 1 ] && [ -f "$REPO_ROOT/scripts/lint-quorum-review.mjs" ]; then
  if command -v node >/dev/null 2>&1; then
    node "$REPO_ROOT/scripts/lint-quorum-review.mjs" --quiet || { echo "install: lint failed — fix the seat files (or pass --no-lint to force)" >&2; exit 1; }
  else
    echo "install: node not found — skipping lint (scripts need Node 18+)." >&2
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "install: DRY RUN — no changes"
  for d in "${SKILL_DIRS[@]}"; do
    name="$(basename "$d")"
    prefix="$(panel_prefix "$d/SKILL.md")"
    echo "install:   skill $name (panel prefix: ${prefix:-rev-quorum-})"
    echo "install:     would copy: SKILL.md -> $SKILLS_DIR/$name/"
    if [ "$name" = "quorum-review" ]; then
      for s in "$SCRIPTS_SRC"/*.mjs; do echo "install:     would copy: scripts/$(basename "$s") -> $SKILLS_DIR/$name/scripts/"; done
    fi
    for a in "$PLUGIN_DIR"/agents/${prefix:-rev-quorum-}*.md; do
      [ -e "$a" ] && echo "install:     would copy: $(basename "$a") -> $AGENTS_DIR/"
    done
  done
  exit 0
fi

mkdir -p "$SKILLS_DIR" "$AGENTS_DIR"

for d in "${SKILL_DIRS[@]}"; do
  name="$(basename "$d")"
  dest="$SKILLS_DIR/$name"
  mkdir -p "$dest"

  backup "$dest/SKILL.md" "$d/SKILL.md"
  cp "$d/SKILL.md" "$dest/SKILL.md"

  if [ "$name" = "quorum-review" ]; then
    mkdir -p "$dest/scripts"
    for s in "$SCRIPTS_SRC"/*.mjs; do
      backup "$dest/scripts/$(basename "$s")" "$s"
      cp "$s" "$dest/scripts/"
    done
    chmod +x "$dest"/scripts/*.mjs 2>/dev/null || true
  elif [ -d "$dest/scripts" ]; then
    # Older bundles copied the scripts into every skill dir; the single source is now the
    # quorum-review skill dir. Remove the stale duplicates so nothing runs an old copy.
    rm -rf "$dest/scripts"
    echo "install: removed stale $dest/scripts (scripts now live only under skills/quorum-review/)"
  fi
done

for a in "$PLUGIN_DIR"/agents/rev-*.md; do
  [ -e "$a" ] || continue
  f="$(basename "$a")"
  backup "$AGENTS_DIR/$f" "$a"
  cp "$a" "$AGENTS_DIR/$f"
done

echo "install: files installed."
if command -v node >/dev/null 2>&1; then
  for d in "${SKILL_DIRS[@]}"; do
    name="$(basename "$d")"
    prefix="$(panel_prefix "$d/SKILL.md")"
    echo "install: active panel ($name, prefix ${prefix:-rev-quorum-}) with EFFECTIVE models (seat pin unless an OMP task.agentModelOverrides entry applies):"
    node "$SKILLS_DIR/quorum-review/scripts/panel.mjs" --prefix "${prefix:-rev-quorum-}" --agents-dir "$AGENTS_DIR" 2>/dev/null \
      || echo "install: (panel.mjs failed for $name — check the seat files; see README)" >&2
  done
else
  echo "install: node not found — scripts need Node 18+ (panel/packet/dedupe will not run until it is installed)." >&2
fi

if ls "$OMP_HOME"/plugins/cache/plugins/*quorum-review* >/dev/null 2>&1; then
  echo "install: WARNING — a plugin install of quorum-review exists under $OMP_HOME/plugins/. The manual copies"
  echo "install:   just written SHADOW it by name. Pick one: keep the plugin (run ./install.sh --uninstall) or keep manual."
fi
for d in "${SKILL_DIRS[@]}"; do
  name="$(basename "$d")"
  LEGACY_SKILL_DIR="$CONFIG_HOME/opencode/skills/$name"
  if [ -e "$LEGACY_SKILL_DIR" ]; then
    echo "install: WARNING — legacy OpenCode-config copy found at $LEGACY_SKILL_DIR (pre-OMP path); remove it: rm -rf \"$LEGACY_SKILL_DIR\""
  fi
done
if [ -f "$OMP_HOME/agent/.env" ]; then
  perms="$(stat -f '%Lp' "$OMP_HOME/agent/.env" 2>/dev/null || stat -c '%a' "$OMP_HOME/agent/.env" 2>/dev/null || true)"
  case "$perms" in
    600|400|"") ;;
    *) echo "install: NOTE — $OMP_HOME/agent/.env is mode $perms; provider keys live there: chmod 600 \"$OMP_HOME/agent/.env\"" ;;
  esac
fi
echo "install: done. In an OMP session, mention 'panel review'/'quorum' or 'security review' to use the skills."
echo "install: assign seat models in your OMP config — see presets/README.md next to this script."
