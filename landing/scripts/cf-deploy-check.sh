#!/usr/bin/env bash
# Cloudflare Pages deploy checker — verifies latest deployment and retries if skipped
# Usage: ./cf-deploy-check.sh [--retry]
# Requires: CF_PAGES_TOKEN and CF_ACCOUNT_ID env vars

set -euo pipefail

ACCOUNT_ID="${CF_ACCOUNT_ID:?Set CF_ACCOUNT_ID}"
API_TOKEN="${CF_PAGES_TOKEN:?Set CF_PAGES_TOKEN}"
PROJECT="neto-site"
API="https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/pages/projects/${PROJECT}"
AUTH="Authorization: Bearer ${API_TOKEN}"
MAX_WAIT=180  # max seconds to wait for deploy to finish
POLL_INTERVAL=10

# Get latest deployment
get_latest() {
  curl -s "${API}/deployments?sort_by=created_on&sort_order=desc&per_page=1" \
    -H "$AUTH"
}

# Retry a deployment
retry_deploy() {
  local deploy_id="$1"
  curl -s -X POST "${API}/deployments/${deploy_id}/retry" \
    -H "$AUTH"
}

# Extract field from JSON (portable, no jq dependency)
json_val() {
  python -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null
}

latest=$(get_latest)
deploy_id=$(echo "$latest" | json_val "d['result'][0]['id']")
short_id=$(echo "$latest" | json_val "d['result'][0]['short_id']")
stage_name=$(echo "$latest" | json_val "d['result'][0]['latest_stage']['name']")
stage_status=$(echo "$latest" | json_val "d['result'][0]['latest_stage']['status']")
created=$(echo "$latest" | json_val "d['result'][0]['created_on']")

echo "=== Cloudflare Pages Deploy Check ==="
echo "Deploy:  ${short_id}"
echo "Created: ${created}"
echo "Stage:   ${stage_name}"
echo "Status:  ${stage_status}"

if [ "$stage_status" = "success" ] && [ "$stage_name" = "deploy" ]; then
  echo ">>> Deploy successful!"
  exit 0
fi

if [ "$stage_status" = "skipped" ] || [ "$stage_status" = "failure" ]; then
  echo ">>> Deploy ${stage_status}! Retrying..."
  retry_result=$(retry_deploy "$deploy_id")
  retry_success=$(echo "$retry_result" | json_val "d.get('success', False)")

  if [ "$retry_success" = "True" ]; then
    echo ">>> Retry triggered. Waiting for completion..."
  else
    echo ">>> Retry via POST failed, trying new deployment..."
    # Trigger a fresh deployment by creating one
    fresh=$(curl -s -X POST "${API}/deployments" -H "$AUTH")
    deploy_id=$(echo "$fresh" | json_val "d['result']['id']")
    short_id=$(echo "$fresh" | json_val "d['result']['short_id']")
    echo ">>> New deploy: ${short_id}"
  fi

  # Poll until done or timeout
  elapsed=0
  while [ $elapsed -lt $MAX_WAIT ]; do
    sleep $POLL_INTERVAL
    elapsed=$((elapsed + POLL_INTERVAL))
    latest=$(get_latest)
    stage_name=$(echo "$latest" | json_val "d['result'][0]['latest_stage']['name']")
    stage_status=$(echo "$latest" | json_val "d['result'][0]['latest_stage']['status']")
    echo "  [$elapsed s] Stage: ${stage_name} — Status: ${stage_status}"

    if [ "$stage_status" = "success" ] && [ "$stage_name" = "deploy" ]; then
      echo ">>> Deploy successful after retry!"
      exit 0
    fi
    if [ "$stage_status" = "failure" ]; then
      echo ">>> Deploy failed after retry."
      exit 1
    fi
  done
  echo ">>> Timeout waiting for deploy (${MAX_WAIT}s)"
  exit 1
fi

# Still in progress
if [ "$stage_status" = "active" ] || [ "$stage_status" = "idle" ]; then
  echo ">>> Deploy in progress. Waiting..."
  elapsed=0
  while [ $elapsed -lt $MAX_WAIT ]; do
    sleep $POLL_INTERVAL
    elapsed=$((elapsed + POLL_INTERVAL))
    latest=$(get_latest)
    stage_name=$(echo "$latest" | json_val "d['result'][0]['latest_stage']['name']")
    stage_status=$(echo "$latest" | json_val "d['result'][0]['latest_stage']['status']")
    echo "  [$elapsed s] Stage: ${stage_name} — Status: ${stage_status}"

    if [ "$stage_status" = "success" ] && [ "$stage_name" = "deploy" ]; then
      echo ">>> Deploy successful!"
      exit 0
    fi
    if [ "$stage_status" = "failure" ] || [ "$stage_status" = "skipped" ]; then
      echo ">>> Deploy ${stage_status}. Run with --retry to retry."
      exit 1
    fi
  done
  echo ">>> Timeout waiting for deploy (${MAX_WAIT}s)"
  exit 1
fi

echo ">>> Unknown status: ${stage_status}"
exit 1
