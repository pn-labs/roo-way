#!/usr/bin/env bash
# =============================================================================
# entrypoint.sh — Configure runtime credentials before starting the server
# =============================================================================
set -euo pipefail

# ─── Git + gh auth via GH_TOKEN ───────────────────────────────────────────────
if [[ -n "${GH_TOKEN:-}" ]]; then
  # gh CLI picks up GH_TOKEN automatically; configure git HTTPS auth too
  git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/"
  echo "[entrypoint] git HTTPS auth configured via GH_TOKEN"
else
  echo "[entrypoint] WARNING: GH_TOKEN is not set — git push and gh CLI calls will fail"
fi

# ─── Default git identity (can be overridden per-commit in the script) ────────
git config --global user.name  "${GIT_USER_NAME:-Roo Way}"
git config --global user.email "${GIT_USER_EMAIL:-roo-way@users.noreply.github.com}"

exec "$@"
