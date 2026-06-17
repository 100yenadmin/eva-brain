#!/usr/bin/env bash
set -euo pipefail
ORIGINAL_ARGS=("$@")

REPO_URL="${EVA_BRAIN_REPO_URL:-https://github.com/electricsheephq/eva-brain.git}"
INSTALL_DIR="${EVA_BRAIN_DIR:-$HOME/eva-brain}"
REF="${EVA_BRAIN_REF:-stable}"
GBRAIN_ROOT="${GBRAIN_HOME:-$HOME}"
if [ "${GBRAIN_ROOT%/.gbrain}" != "$GBRAIN_ROOT" ]; then
  GBRAIN_ROOT="$(dirname "$GBRAIN_ROOT")"
  export GBRAIN_HOME="$GBRAIN_ROOT"
fi
GBRAIN_DIR="$GBRAIN_ROOT/.gbrain"
GBRAIN_ENV_FILE="${GBRAIN_ENV_FILE:-$GBRAIN_DIR/gbrain.env}"
WITH_OPENCLAW="auto"
WITH_CODEX_PLUGIN="auto"
WITH_SUPPORT_KB="false"
WITH_WORKSPACE_DOCS="auto"
WORKSPACE_DOCS_SOURCE="${EVA_BRAIN_WORKSPACE_DOCS_SOURCE:-workspace-docs}"
WORKSPACE_DOCS_DIR="${EVA_BRAIN_WORKSPACE_DOCS_DIR:-$HOME/.openclaw/workspace/docs}"
RUN_DOCTOR="true"
RUN_PROVIDER_TEST="auto"
RUN_HEALTH="auto"
STOP_STALE_SERVE="false"
DRY_RUN="false"
ALLOW_DIRTY="false"

usage() {
  cat <<'USAGE'
Usage: scripts/update-local-install.sh [options]

Public local updater for Eva Brain/GBrain. It clones or fast-forwards a checkout,
installs dependencies, links the gbrain CLI, runs idempotent PGLite migrations,
and optionally refreshes host plugins.

Options:
  --dir <path>                 Checkout/install directory (default: ~/eva-brain)
  --repo <url>                 Git repo URL (default: electricsheephq/eva-brain)
  --ref <branch-or-tag>        Git ref to checkout/pull (default: stable, latest eva-v* tag)
  --with-openclaw              Install/enable the OpenClaw native plugin
  --without-openclaw           Skip OpenClaw plugin install
  --with-codex-plugin          Install/update the Codex Desktop local plugin entry
  --without-codex-plugin       Skip Codex plugin install
  --with-support-kb            Install/update the OpenClaw Support KB source
  --with-workspace-docs        Register/import ~/.openclaw/workspace/docs as source workspace-docs
  --without-workspace-docs     Skip workspace docs source registration/import
  --stop-stale-serve           Stop stale local gbrain serve processes before init/doctor
  --skip-doctor                Skip gbrain doctor
  --skip-provider-test         Skip provider probe
  --skip-health                Skip source-aware Eva health report
  --allow-dirty                Allow updating a dirty existing checkout
  --dry-run                    Print commands without mutating
  -h, --help                   Show this help

Environment:
  VOYAGE_API_KEY               Used by gbrain provider probes and embeddings
  EVA_BRAIN_DIR                Same as --dir
  EVA_BRAIN_REF                Same as --ref. Use master only for development.
  GBRAIN_HOME                  Parent for .gbrain runtime data. If it points
                               directly at a .gbrain dir, the updater normalizes it.

Examples:
  scripts/update-local-install.sh
  scripts/update-local-install.sh --ref master
  scripts/update-local-install.sh --with-openclaw --with-codex-plugin
  scripts/update-local-install.sh --with-support-kb --stop-stale-serve
  scripts/update-local-install.sh --with-support-kb --with-workspace-docs --with-openclaw
USAGE
}

log() {
  printf '[eva-brain:update] %s\n' "$*" >&2
}

die() {
  printf '[eva-brain:update] ERROR: %s\n' "$*" >&2
  exit 1
}

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [ "$DRY_RUN" = "false" ]; then
    "$@"
  fi
}

load_gbrain_env() {
  if [ ! -f "$GBRAIN_ENV_FILE" ]; then
    return
  fi
  log "Loading GBrain env from $GBRAIN_ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  . "$GBRAIN_ENV_FILE"
  set +a
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

latest_stable_tag() {
  git ls-remote --tags --refs --sort='version:refname' "$REPO_URL" 'eva-v*' |
    awk '{print $2}' |
    sed 's#refs/tags/##' |
    tail -n 1
}

resolve_ref() {
  if [ "$REF" != "stable" ]; then
    return
  fi
  need_cmd git
  local tag
  tag="$(latest_stable_tag)"
  if [ -z "$tag" ]; then
    die "No Eva Brain release tags found in $REPO_URL. Create an eva-v* GitHub release, pass --ref <eva-v...>, or pass --ref master for a development install."
  fi
  log "Resolved stable to $tag"
  REF="$tag"
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --dir) INSTALL_DIR="${2:?missing value for --dir}"; shift 2 ;;
      --repo) REPO_URL="${2:?missing value for --repo}"; shift 2 ;;
      --ref) REF="${2:?missing value for --ref}"; shift 2 ;;
      --with-openclaw) WITH_OPENCLAW="true"; shift ;;
      --without-openclaw) WITH_OPENCLAW="false"; shift ;;
      --with-codex-plugin) WITH_CODEX_PLUGIN="true"; shift ;;
      --without-codex-plugin) WITH_CODEX_PLUGIN="false"; shift ;;
      --with-support-kb) WITH_SUPPORT_KB="true"; shift ;;
      --with-workspace-docs) WITH_WORKSPACE_DOCS="true"; shift ;;
      --without-workspace-docs) WITH_WORKSPACE_DOCS="false"; shift ;;
      --stop-stale-serve) STOP_STALE_SERVE="true"; shift ;;
      --skip-doctor) RUN_DOCTOR="false"; shift ;;
      --skip-provider-test) RUN_PROVIDER_TEST="false"; shift ;;
      --skip-health) RUN_HEALTH="false"; shift ;;
      --allow-dirty) ALLOW_DIRTY="true"; shift ;;
      --dry-run) DRY_RUN="true"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "Unknown option: $1" ;;
    esac
  done
}

checkout_repo() {
  need_cmd git
  if git -C "$INSTALL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    log "Updating checkout: $INSTALL_DIR"
    if [ "$ALLOW_DIRTY" = "false" ] && [ -n "$(git -C "$INSTALL_DIR" status --porcelain)" ]; then
      die "Checkout is dirty. Commit/stash changes or pass --allow-dirty."
    fi
    run git -C "$INSTALL_DIR" fetch origin "$REF"
    if git -C "$INSTALL_DIR" rev-parse --verify --quiet "refs/heads/$REF" >/dev/null; then
      run git -C "$INSTALL_DIR" switch "$REF"
      run git -C "$INSTALL_DIR" pull --ff-only origin "$REF"
    else
      run git -C "$INSTALL_DIR" switch --detach FETCH_HEAD
    fi
  elif [ -e "$INSTALL_DIR" ]; then
    die "Install dir exists but is not a git checkout: $INSTALL_DIR"
  else
    log "Cloning $REPO_URL into $INSTALL_DIR"
    run git clone --branch "$REF" "$REPO_URL" "$INSTALL_DIR"
  fi
}

reexec_from_checked_out_updater() {
  if [ "${EVA_BRAIN_UPDATER_REEXECED:-}" = "1" ]; then
    return
  fi
  if [ "$DRY_RUN" = "true" ]; then
    return
  fi
  local updated_script="$INSTALL_DIR/scripts/update-local-install.sh"
  if [ ! -f "$updated_script" ]; then
    return
  fi
  log "Re-executing updater from checked-out ref: $updated_script"
  cd "$INSTALL_DIR"
  exec env EVA_BRAIN_UPDATER_REEXECED=1 bash "$updated_script" "${ORIGINAL_ARGS[@]}"
}

ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    return
  fi
  die "Bun is required. Install it from https://bun.sh, then rerun this script."
}

ensure_gbrain_cli() {
  if [ "$DRY_RUN" = "true" ]; then
    return
  fi

  local global_bin="$HOME/.bun/bin/gbrain"
  local checkout_bin="$INSTALL_DIR/src/cli.ts"

  if [ -x "$global_bin" ]; then
    return
  fi

  if [ -x "$checkout_bin" ]; then
    log "Restoring missing gbrain CLI shim: $global_bin -> $checkout_bin"
    run mkdir -p "$(dirname "$global_bin")"
    run ln -sfn "$checkout_bin" "$global_bin"
  fi

  if [ ! -x "$global_bin" ]; then
    die "gbrain CLI was not linked at $global_bin. Run from a valid Eva Brain checkout or reinstall with Bun, then rerun this updater."
  fi
}

install_gbrain() {
  ensure_bun
  export PATH="$HOME/.bun/bin:$PATH"
  run bun install
  run bun link
  ensure_gbrain_cli
  stop_stale_serve_if_requested
  local config_path="$GBRAIN_DIR/config.json"
  if [ -f "$config_path" ]; then
    run "$HOME/.bun/bin/gbrain" init
  else
    run "$HOME/.bun/bin/gbrain" init --pglite --embedding-model voyage:voyage-4-large --embedding-dimensions 2048
  fi
}

stop_stale_serve_if_requested() {
  if [ "$STOP_STALE_SERVE" != "true" ]; then
    return
  fi

  local pids
  pids="$(
    {
      pgrep -f '[g]brain serve' || true
      pgrep -f '[l]aunch-gbrain-serve\.mjs' || true
    } | sort -u
  )"

  if [ -z "$pids" ]; then
    return
  fi

  log "Stopping stale gbrain serve/plugin launcher processes before local PGLite work: $(printf '%s' "$pids" | tr '\n' ' ')"
  run kill $pids
  if [ "$DRY_RUN" = "true" ]; then
    log "Dry-run: skipping stale gbrain serve cleanup verification"
    return
  fi
  sleep 1

  pids="$(
    {
      pgrep -f '[g]brain serve' || true
      pgrep -f '[l]aunch-gbrain-serve\.mjs' || true
    } | sort -u
  )"
  if [ -n "$pids" ]; then
    log "Escalating stale gbrain serve cleanup with SIGKILL: $(printf '%s' "$pids" | tr '\n' ' ')"
    run kill -KILL $pids
    sleep 1
  fi

  pids="$(
    {
      pgrep -f '[g]brain serve' || true
      pgrep -f '[l]aunch-gbrain-serve\.mjs' || true
    } | sort -u
  )"
  if [ -n "$pids" ]; then
    die "Stale gbrain serve/plugin launcher processes remain after cleanup: $(printf '%s' "$pids" | tr '\n' ' ')"
  fi
}

doctor() {
  if [ "$RUN_DOCTOR" != "true" ]; then
    return
  fi
  stop_stale_serve_if_requested
  run env GBRAIN_SKILLS_DIR="$INSTALL_DIR/skills" "$HOME/.bun/bin/gbrain" doctor --json
}

health_report() {
  if [ "$RUN_HEALTH" = "false" ]; then
    return
  fi
  local require_workspace_docs="false"
  if [ "$WITH_WORKSPACE_DOCS" = "true" ] || { [ "$WITH_WORKSPACE_DOCS" = "auto" ] && [ -d "$WORKSPACE_DOCS_DIR" ]; }; then
    require_workspace_docs="true"
  fi
  if [ "$RUN_HEALTH" = "auto" ] && [ "$WITH_SUPPORT_KB" != "true" ] && [ "$require_workspace_docs" != "true" ]; then
    log "Skipping source-aware health report because no source package was requested or detected"
    return
  fi
  local health_args=()
  if [ "$WITH_OPENCLAW" = "true" ]; then
    health_args+=(--require-openclaw)
  fi
  if [ "$WITH_SUPPORT_KB" = "true" ]; then
    health_args+=(--require-support-kb)
  else
    health_args+=(--allow-missing-support-kb)
  fi
  if [ "$require_workspace_docs" = "true" ]; then
    health_args+=(--require-workspace-docs)
  fi
  if [ "$DRY_RUN" = "true" ]; then
    run node scripts/eva-brain-health.mjs "${health_args[@]}"
    return
  fi
  run env GBRAIN_BIN="$HOME/.bun/bin/gbrain" node scripts/eva-brain-health.mjs "${health_args[@]}"
}

provider_test() {
  if [ "$RUN_PROVIDER_TEST" = "false" ]; then
    return
  fi
  if [ "${RUN_PROVIDER_TEST}" = "auto" ] && [ -z "${VOYAGE_API_KEY:-}" ]; then
    log "Skipping Voyage provider probe because VOYAGE_API_KEY is not set"
    return
  fi
  run "$HOME/.bun/bin/gbrain" providers test
}

configured_embedding_model() {
  if [ ! -f "$GBRAIN_DIR/config.json" ]; then
    printf 'voyage:voyage-4-large\n'
    return
  fi
  node -e '
const fs = require("fs");
const path = process.argv[1];
try {
  const config = JSON.parse(fs.readFileSync(path, "utf8"));
  process.stdout.write(String(config.embedding_model || "voyage:voyage-4-large"));
} catch {
  process.stdout.write("voyage:voyage-4-large");
}
' "$GBRAIN_DIR/config.json"
  printf '\n'
}

source_exists() {
  local source_id="$1"
  if [ "$DRY_RUN" = "true" ]; then
    return 1
  fi
  "$HOME/.bun/bin/gbrain" sources list --json | node -e '
const id = process.argv[1];
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw || "{}");
    const sources = Array.isArray(parsed) ? parsed : Array.isArray(parsed.sources) ? parsed.sources : [];
    process.exit(sources.some(source => String(source.id ?? source.source_id ?? source.sourceId) === id) ? 0 : 1);
  } catch {
    process.exit(1);
  }
});
' "$source_id"
}

embed_source_if_provider_auth_available() {
  local source_id="$1"
  local label="$2"
  local model
  model="$(configured_embedding_model)"
  if [ "${model#voyage:}" != "$model" ] && [ -z "${VOYAGE_API_KEY:-}" ]; then
    log "Skipping $label embedding because $model requires VOYAGE_API_KEY and no key is configured. Source-scoped text search will still be validated."
    return
  fi
  run "$HOME/.bun/bin/gbrain" embed --stale --source "$source_id"
}

embed_support_kb_if_provider_auth_available() {
  embed_source_if_provider_auth_available "openclaw-support-kb" "Support KB"
}

install_openclaw_plugin() {
  if [ "$WITH_OPENCLAW" = "auto" ] && ! command -v openclaw >/dev/null 2>&1; then
    log "OpenClaw not found; skipping OpenClaw plugin install"
    return
  fi
  if [ "$WITH_OPENCLAW" = "false" ]; then
    return
  fi
  need_cmd openclaw
  run openclaw plugins install --force --dangerously-force-unsafe-install ./plugins/openclaw-gbrain
  run openclaw plugins enable gbrain
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files openclaw-gateway.service --no-legend 2>/dev/null | grep -q '^openclaw-gateway.service'; then
    if [ "$(id -u)" -eq 0 ]; then
      run systemctl restart openclaw-gateway
    elif sudo -n true >/dev/null 2>&1; then
      run sudo systemctl restart openclaw-gateway
    else
      log "OpenClaw systemd service detected, but passwordless sudo is unavailable; run: sudo systemctl restart openclaw-gateway"
    fi
  else
    run openclaw gateway restart
  fi
  run openclaw plugins inspect gbrain --runtime --json
}

install_codex_plugin() {
  if [ "$WITH_CODEX_PLUGIN" = "auto" ] && [ ! -d "$HOME/.codex" ] && [ ! -d "$HOME/.agents" ]; then
    log "Codex Desktop config dirs not found; skipping Codex plugin install"
    return
  fi
  if [ "$WITH_CODEX_PLUGIN" = "false" ]; then
    return
  fi
  need_cmd node
  if [ "$DRY_RUN" = "true" ]; then
    run node scripts/install-codex-plugin.mjs --dry-run
  else
    run node scripts/install-codex-plugin.mjs
  fi
}

install_support_kb() {
  if [ "$WITH_SUPPORT_KB" != "true" ]; then
    return
  fi
  need_cmd git
  need_cmd node
  local kb_repo="${OPENCLAW_SUPPORT_KB_REPO:-https://github.com/electricsheephq/openclaw-support-kb.git}"
  local kb_dir="${OPENCLAW_SUPPORT_KB_DIR:-$GBRAIN_DIR/sources/openclaw-support-kb}"
  if [ -d "$kb_dir/.git" ]; then
    if [ -n "$(git -C "$kb_dir" status --porcelain)" ]; then
      local backup_dir="$GBRAIN_DIR/backups/openclaw-support-kb-$(date -u +%Y%m%dT%H%M%SZ)"
      log "Support KB checkout has local changes; archiving it to $backup_dir before reinstalling"
      run mkdir -p "$(dirname "$backup_dir")"
      run mv "$kb_dir" "$backup_dir"
      run git clone "$kb_repo" "$kb_dir"
    else
      run git -C "$kb_dir" pull --ff-only
    fi
  else
    run mkdir -p "$(dirname "$kb_dir")"
    run git clone "$kb_repo" "$kb_dir"
  fi
  run node "$kb_dir/scripts/update-client.mjs"
  run node "$kb_dir/scripts/status.mjs"
  run "$HOME/.bun/bin/gbrain" sync --repo "$kb_dir" --source openclaw-support-kb --no-embed
  embed_support_kb_if_provider_auth_available
  disable_source_cycle_freshness_if_supported openclaw-support-kb
}

disable_source_cycle_freshness_if_supported() {
  disable_source_freshness_if_supported "$1" cycle-freshness
}

disable_source_sync_freshness_if_supported() {
  disable_source_freshness_if_supported "$1" sync-freshness
}

disable_source_freshness_if_supported() {
  local source_id="$1"
  local freshness_command="$2"
  local output
  local cmd=("$HOME/.bun/bin/gbrain" sources "$freshness_command" "$source_id" off)
  printf '+'
  printf ' %q' "${cmd[@]}"
  printf '\n'
  if [ "$DRY_RUN" = "true" ]; then
    log "Dry-run: skipping optional $freshness_command disable execution"
    return
  fi
  if output="$("${cmd[@]}" 2>&1)"; then
    printf '%s\n' "$output"
    return
  fi
  local normalized_output
  normalized_output="$(printf '%s' "$output" | tr -d '\r' | sed -e 's/[[:space:]]*$//')"
  if [ "$normalized_output" = "Unknown sources subcommand: $freshness_command" ]; then
    log "Skipping $freshness_command disable; installed gbrain does not expose 'sources $freshness_command'."
    return
  fi
  printf '%s\n' "$output" >&2
  return 1
}

install_workspace_docs() {
  if [ "$WITH_WORKSPACE_DOCS" = "false" ]; then
    return
  fi
  if [ ! -d "$WORKSPACE_DOCS_DIR" ]; then
    if [ "$WITH_WORKSPACE_DOCS" = "true" ]; then
      die "Workspace docs directory not found: $WORKSPACE_DOCS_DIR"
    fi
    log "Workspace docs directory not found; skipping workspace-docs source: $WORKSPACE_DOCS_DIR"
    return
  fi
  if [ -z "$(find "$WORKSPACE_DOCS_DIR" -type f \( -name '*.md' -o -name '*.mdx' \) -print -quit)" ]; then
    if [ "$WITH_WORKSPACE_DOCS" = "true" ]; then
      die "Workspace docs directory has no markdown files: $WORKSPACE_DOCS_DIR"
    fi
    log "Workspace docs directory has no markdown files; skipping workspace-docs source: $WORKSPACE_DOCS_DIR"
    return
  fi
  if source_exists "$WORKSPACE_DOCS_SOURCE"; then
    log "GBrain source $WORKSPACE_DOCS_SOURCE already registered; importing current docs from $WORKSPACE_DOCS_DIR"
  else
    run "$HOME/.bun/bin/gbrain" sources add "$WORKSPACE_DOCS_SOURCE" --path "$WORKSPACE_DOCS_DIR" --name "Workspace Docs" --federated
  fi
  run "$HOME/.bun/bin/gbrain" import "$WORKSPACE_DOCS_DIR" --source-id "$WORKSPACE_DOCS_SOURCE" --no-embed
  embed_source_if_provider_auth_available "$WORKSPACE_DOCS_SOURCE" "Workspace docs"
  disable_source_cycle_freshness_if_supported "$WORKSPACE_DOCS_SOURCE"
  disable_source_sync_freshness_if_supported "$WORKSPACE_DOCS_SOURCE"
}

main() {
  parse_args "$@"
  load_gbrain_env
  resolve_ref
  checkout_repo
  reexec_from_checked_out_updater
  if [ -d "$INSTALL_DIR" ]; then
    cd "$INSTALL_DIR"
  elif [ "$DRY_RUN" = "true" ]; then
    log "Dry-run: install dir does not exist yet; continuing from current checkout for command preview"
  else
    die "Install dir was not created: $INSTALL_DIR"
  fi
  install_gbrain
  install_openclaw_plugin
  install_codex_plugin
  install_support_kb
  install_workspace_docs
  provider_test
  doctor
  health_report
  log "Update complete."
}

main "$@"
