#!/usr/bin/env bash
# Bulk-upload secrets and the PUBLIC_MEDIA_BASE_URL variable to GitHub Actions
# by reading a local .env file. Idempotent — re-running overwrites values.
#
# Usage:
#   ./scripts/push-secrets.sh           # reads ./.env in current dir
#   ./scripts/push-secrets.sh path/to/.env
#
# Requires `gh auth status` to be logged in to the repo's owner.

set -euo pipefail

ENV_FILE="${1:-.env}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

# Workflow-local env vars that should NOT be pushed to GitHub
# (DRY_RUN is passed via workflow_dispatch input; TIMEZONE is set inline).
SKIP_KEYS=(DRY_RUN TIMEZONE)

# These go to GitHub Actions VARIABLES (plaintext, readable), not secrets.
VAR_KEYS=(PUBLIC_MEDIA_BASE_URL)

is_in() {
  local needle="$1"; shift
  for k in "$@"; do [[ "$k" == "$needle" ]] && return 0; done
  return 1
}

pushed_secrets=0
pushed_vars=0
skipped=0

while IFS= read -r line || [[ -n "$line" ]]; do
  # strip CR, trim leading spaces
  line="${line%$'\r'}"
  line="${line#"${line%%[![:space:]]*}"}"

  # skip empty lines and comments
  [[ -z "$line" || "$line" == \#* ]] && continue

  # split on first '='
  key="${line%%=*}"
  value="${line#*=}"
  key="${key%"${key##*[![:space:]]}"}"  # rtrim key

  [[ -z "$key" || -z "$value" ]] && continue

  if is_in "$key" "${SKIP_KEYS[@]}"; then
    echo "skip   $key (workflow-local)"
    skipped=$((skipped+1))
    continue
  fi

  if is_in "$key" "${VAR_KEYS[@]}"; then
    echo "var    $key"
    gh variable set "$key" --body "$value" >/dev/null
    pushed_vars=$((pushed_vars+1))
  else
    echo "secret $key"
    gh secret set "$key" --body "$value" >/dev/null
    pushed_secrets=$((pushed_secrets+1))
  fi
done < "$ENV_FILE"

echo ""
echo "Done. ${pushed_secrets} secrets, ${pushed_vars} variables, ${skipped} skipped."
