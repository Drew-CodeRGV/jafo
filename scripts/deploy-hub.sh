#!/usr/bin/env bash
# deploy-hub.sh — push the latest main to the jafo.live hub and restart the web
# service, in one command. Run it from the Pi:
#
#     ~/jafo/scripts/deploy-hub.sh
#
# (or, inside a Claude Code session, prefix with `! ` so it runs as you.)
#
# It fetches origin, hard-resets the hub to origin/main, restarts jafo-web, and
# prints the resulting commit + service state so you can confirm it took.
#
# Override the target with env vars if the host ever changes:
#     JAFO_HUB_SSH=ubuntu@1.2.3.4 JAFO_HUB_DIR='~/jafo' ~/jafo/scripts/deploy-hub.sh
set -euo pipefail

HUB="${JAFO_HUB_SSH:-ubuntu@52.206.80.232}"
DIR="${JAFO_HUB_DIR:-~/jafo}"
SERVICE="${JAFO_HUB_SERVICE:-jafo-web}"

echo "▶ deploying to ${HUB} (${DIR}) …"

# 1. Update the checkout to the pushed tip of main.
ssh -o ConnectTimeout=20 "${HUB}" \
  "cd ${DIR} && git fetch origin && git reset --hard origin/main && git log -1 --oneline"

# 2. Restart the web service so the new code loads.
ssh -o ConnectTimeout=20 "${HUB}" "sudo systemctl restart ${SERVICE}"

# 3. Confirm it came back up.
echo "▶ ${SERVICE} status:"
ssh -o ConnectTimeout=20 "${HUB}" "systemctl is-active ${SERVICE} && systemctl --no-pager -l status ${SERVICE} | head -n 5"

echo "✓ deploy complete."
