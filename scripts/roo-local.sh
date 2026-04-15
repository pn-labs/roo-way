#!/usr/bin/env bash
# =============================================================================
# roo-local.sh — Run Roo workflows locally using git + roo CLI + gh CLI
#
# Usage:
#   ./scripts/roo-local.sh <command> [extra instruction]
#
# Content is supplied via environment variables (NOT fetched from GitHub):
#   ROO_TITLE     Issue / ticket title                       (required)
#   ROO_BODY      Issue / ticket body / description          (required)
#   ROO_COMMENTS  Prior comment history, plain text          (optional)
#   ROO_BRANCH    Exact branch name to checkout / create     (optional)
#   ROO_ISSUE     GitHub issue number for posting comments   (optional)
#
# Commands:
#   roo-code    Implement a feature described in ROO_TITLE / ROO_BODY
#   roo-design  Design / architecture work (uses same flow as roo-code)
#
# Required environment variables:
#   OPENROUTER_API_KEY   Your OpenRouter API key
#   REPO_URL             HTTPS clone URL of the target repo (e.g. https://github.com/org/repo.git)
#                        The script clones this repo into a fresh temp directory on every run.
#
# Examples:
#   ROO_TITLE="Add dark mode" ROO_BODY="..." \
#     OPENROUTER_API_KEY=sk-... ./scripts/roo-local.sh roo-code
#
#   ROO_TITLE="Design auth flow" ROO_BODY="..." ROO_ISSUE=42 \
#     OPENROUTER_API_KEY=sk-... ./scripts/roo-local.sh roo-design "Focus on the OAuth module"
# =============================================================================

set -euo pipefail

# ─── Colours ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[info]${RESET}  $*"; }
success() { echo -e "${GREEN}[ok]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${RESET}  $*"; }
error()   { echo -e "${RED}[error]${RESET} $*" >&2; }
die()     { error "$*"; exit 1; }

# ─── Usage ───────────────────────────────────────────────────────────────────
usage() {
  grep '^#' "$0" | grep -v '^#!/' | sed 's/^# \?//' | head -40
  exit 1
}

# ─── Args ────────────────────────────────────────────────────────────────────
COMMAND="${1:-}"
EXTRA_INSTRUCTION="${2:-}"

[[ -z "$COMMAND" ]] && usage

case "$COMMAND" in
  roo-code|roo-design) ;;
  *) die "Unknown command '$COMMAND'. Must be one of: roo-code roo-design" ;;
esac

# ─── Content env vars ─────────────────────────────────────────────────────────
ROO_TITLE="${ROO_TITLE:-}"
ROO_BODY="${ROO_BODY:-}"
ROO_COMMENTS="${ROO_COMMENTS:-}"
ROO_BRANCH="${ROO_BRANCH:-}"
ROO_ISSUE="${ROO_ISSUE:-}"
REPO_URL="${REPO_URL:-}"

[[ -z "$ROO_TITLE" ]] && die "ROO_TITLE is required. Pass the issue/ticket title as an env var."
[[ -z "$ROO_BODY"  ]] && die "ROO_BODY is required. Pass the issue/ticket body as an env var."
[[ -z "$REPO_URL"  ]] && die "REPO_URL is required. Set it to the HTTPS clone URL of the target repo (e.g. https://github.com/org/repo.git)."

# ─── Prerequisite checks ─────────────────────────────────────────────────────
check_deps() {
  info "Checking prerequisites…"

  # git
  command -v git &>/dev/null || die "git is not installed. Install it via your package manager."

  # gh CLI — only required when we need to post comments or manage PRs
  if [[ -n "$ROO_ISSUE" ]] || [[ "${ROO_NEEDS_GH:-false}" == "true" ]]; then
    if ! command -v gh &>/dev/null; then
      die "gh (GitHub CLI) is not installed.\nInstall it from https://cli.github.com/ or run:\n  sudo apt install gh  (Debian/Ubuntu)\n  brew install gh      (macOS)"
    fi
    if ! gh auth status &>/dev/null; then
      die "gh is not authenticated. Run: gh auth login"
    fi
    success "gh CLI authenticated."
  else
    info "gh CLI not required (no ROO_ISSUE set and no gh operations needed)."
  fi

  # roo CLI — install if missing
  if ! command -v roo &>/dev/null; then
    warn "roo CLI not found — installing now…"
    curl -fsSL https://raw.githubusercontent.com/RooCodeInc/Roo-Code/main/apps/cli/install.sh | sh
    # Add ~/.local/bin to PATH for this session
    export PATH="$HOME/.local/bin:$PATH"
    command -v roo &>/dev/null || die "roo CLI installation failed. Add ~/.local/bin to your PATH and retry."
    success "roo CLI installed: $(roo --version 2>/dev/null || echo 'unknown version')"
  else
    success "roo CLI found: $(roo --version 2>/dev/null || echo 'unknown version')"
  fi

  # OPENROUTER_API_KEY
  [[ -n "${OPENROUTER_API_KEY:-}" ]] || die "OPENROUTER_API_KEY is not set.\nExport it first:\n  export OPENROUTER_API_KEY=sk-..."

  success "All prerequisites satisfied."
}

# ─── Clone target repo to a fresh workspace ───────────────────────────────────
setup_workspace() {
  local dir
  dir=$(mktemp -d /tmp/roo-workspace-XXXXXX)
  info "Cloning ${REPO_URL} into ${dir}…"
  git clone "$REPO_URL" "$dir"
  cd "$dir"
  success "Workspace ready: ${dir}"
}

# ─── Resolve or create branch ─────────────────────────────────────────────────
resolve_branch() {
  local prefix="$1"   # e.g. feature-mode, bug-mode, doc-mode

  info "Resolving branch (prefix=${prefix})…"

  # If an explicit branch was provided, use it directly
  if [[ -n "$ROO_BRANCH" ]]; then
    BRANCH="$ROO_BRANCH"
    if git ls-remote --heads origin "$BRANCH" | grep -q .; then
      info "Found existing remote branch: $BRANCH"
      git fetch origin "$BRANCH"
      git checkout "$BRANCH"
    else
      warn "Branch '$BRANCH' not found on remote — creating."
      git checkout -b "$BRANCH"
      git push origin "$BRANCH"
      success "Created and pushed branch: $BRANCH"
    fi
    return
  fi

  # Derive a slug from ROO_TITLE (and optionally ROO_ISSUE)
  local SLUG
  SLUG=$(echo "$ROO_TITLE" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]/-/g' \
    | sed 's/--*/-/g' \
    | sed 's/^-//;s/-$//' \
    | cut -c1-50)

  local identifier="${ROO_ISSUE:-0}"

  # Check for an existing branch matching the prefix/issue pattern
  if [[ -n "$ROO_ISSUE" ]]; then
    BRANCH=$(git ls-remote --heads origin \
      | grep "refs/heads/${prefix}/${identifier}-" \
      | head -1 \
      | awk '{print $2}' \
      | sed 's|refs/heads/||') || true
  fi

  if [[ -z "${BRANCH:-}" ]]; then
    BRANCH="${prefix}/${identifier}-${SLUG}"
    warn "No existing branch found. Creating: $BRANCH"
    git checkout -b "$BRANCH"
    git push origin "$BRANCH"
    success "Created and pushed branch: $BRANCH"
  else
    info "Found existing branch: $BRANCH"
    git fetch origin "$BRANCH"
    git checkout "$BRANCH"
  fi
}

# ─── Build context from env vars (no GitHub API calls) ───────────────────────
build_context() {
  local section_title="$1"
  local default_instruction="$2"

  info "Building context from supplied content…"

  local HISTORY="${ROO_COMMENTS:-}"
  [[ -z "$HISTORY" ]] && HISTORY="(no prior comments)"

  local INSTRUCTION="${EXTRA_INSTRUCTION:-${default_instruction}}"

  FULL_PROMPT="$(cat <<EOF
# Issue / Ticket: ${ROO_TITLE}

${ROO_BODY}

# Comment History
${HISTORY}

# ${section_title}
${INSTRUCTION}
EOF
)"

  printf '%s' "$FULL_PROMPT" > /tmp/full_context.txt
  success "Context written to /tmp/full_context.txt"
}

# ─── Build final roo prompt ───────────────────────────────────────────────────
build_prompt() {
  local preamble="$1"
  printf '%s\n\n' "$preamble" > /tmp/roo_prompt.txt
  cat /tmp/full_context.txt >> /tmp/roo_prompt.txt
}

# ─── Commit and push ──────────────────────────────────────────────────────────
commit_and_push() {
  local committer_name="$1"
  local committer_email="$2"
  local commit_message="$3"
  local add_pattern="${4:--A}"   # default: git add -A; pass specific file for selective adds

  git config user.name  "$committer_name"
  git config user.email "$committer_email"

  if [[ "$add_pattern" == "-A" ]]; then
    git add -A
  else
    git add "$add_pattern"
  fi

  if git diff --cached --quiet; then
    warn "No changes to commit."
    CHANGED=false
  else
    git commit -m "$commit_message"
    git push origin "$BRANCH"
    CHANGED=true
    success "Pushed to $BRANCH"
  fi
}

# ─── Mark draft PR ready ──────────────────────────────────────────────────────
mark_pr_ready() {
  local PR
  PR=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number // empty') || true
  if [[ -n "$PR" ]]; then
    gh pr ready "$PR" 2>/dev/null || true
    success "Marked PR #$PR as ready for review"
  else
    info "No open PR found for branch $BRANCH"
  fi
}

# ─── Post issue comment (only if ROO_ISSUE is set) ───────────────────────────
post_comment() {
  local body="$1"
  if [[ -z "$ROO_ISSUE" ]]; then
    info "ROO_ISSUE not set — skipping issue comment."
    return
  fi
  gh issue comment "$ROO_ISSUE" --body "$body"
  success "Posted comment on issue #${ROO_ISSUE}"
}

# ─── Get PR link string ───────────────────────────────────────────────────────
get_pr_link() {
  local PR_JSON
  PR_JSON=$(gh pr list --head "$BRANCH" --json number,title,url --jq '.[0] // empty') || true
  if [[ -n "$PR_JSON" ]]; then
    local PR_NUMBER PR_TITLE PR_URL
    PR_NUMBER=$(echo "$PR_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['number'])")
    PR_TITLE=$(echo  "$PR_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['title'])")
    PR_URL=$(echo    "$PR_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['url'])")
    echo "**Pull Request:** [#${PR_NUMBER} ${PR_TITLE}](${PR_URL})"
  else
    echo "_(no open PR found)_"
  fi
}

cmd_roo_code() {
  echo -e "\n${BOLD}✨ roo-code — ${ROO_TITLE}${RESET}\n"

  resolve_branch "feature-mode"

  build_context \
    "Implementation Instruction" \
    "Implement this feature fully following the architecture plan above. Follow existing project conventions."

  build_prompt \
    'You are working on the imc-resource-planner project (TanStack Start + Convex + TypeScript). Implement the feature described in the following context. Follow all existing project conventions: use Convex for data, TanStack Router file-based routes under src/routes/, shadcn/ui components, and TypeScript throughout. Read existing files before editing them.'

  info "Running roo in feature-mode…"
  roo "$(cat /tmp/roo_prompt.txt)" \
    --mode "feature-mode" \
    --provider "openrouter" \
    --api-key "$OPENROUTER_API_KEY"

  commit_and_push \
    "Roo Code" \
    "roo-code@users.noreply.github.com" \
    "feat: implement feature${ROO_ISSUE:+ for issue #${ROO_ISSUE}}" \
    "-A"

  if [[ "$CHANGED" == "true" ]]; then
    post_comment "### ✨ Feature Implementation Complete

Roo has implemented the feature and pushed changes to the branch.

**Branch:** \`${BRANCH}\`

Changes have been committed and pushed. Review the branch when ready."
  else
    post_comment "### ✨ Roo Code ran — no file changes detected

**Branch:** \`${BRANCH}\`

Roo completed without modifying any files. Check the output above for details."
  fi
}

# =============================================================================
# ─── MAIN ────────────────────────────────────────────────────────────────────
# =============================================================================

check_deps
setup_workspace

CHANGED=false
BRANCH=""

case "$COMMAND" in
  roo-code)    cmd_roo_code   ;;
  roo-design)  cmd_roo_code   ;;  # extend with a dedicated cmd_roo_design if needed
esac

echo -e "\n${GREEN}${BOLD}Done.${RESET}\n"
