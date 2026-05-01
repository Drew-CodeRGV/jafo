#!/usr/bin/env bash
# jafo — pull latest, restart all services
set -euo pipefail
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info() { echo -e "${GREEN}[jafo-update]${NC} $*"; }
warn() { echo -e "${YELLOW}[jafo-update]${NC} $*"; }

INSTALL_DIR="/home/pi/jafo"
DATA_DIR="/home/pi/jafo-data"
cd "$INSTALL_DIR"

info "Pulling latest from GitHub..."
git pull --ff-only

info "Updating Python deps (services)..."
"$DATA_DIR/venv-services/bin/pip" install --quiet -r pi/services/requirements.txt
info "Updating Python deps (web)..."
"$DATA_DIR/venv-web/bin/pip" install --quiet -r pi/web/requirements.txt

# Update trunk-recorder config from the active profile
ACTIVE_PROFILE_FILE="$DATA_DIR/config/.active-profile"
if [[ -f "$ACTIVE_PROFILE_FILE" ]]; then
  PROFILE="$(cat "$ACTIVE_PROFILE_FILE")"
  PROFILE_PATH="$INSTALL_DIR/config/profiles/$PROFILE.json"
  if [[ -f "$PROFILE_PATH" ]]; then
    info "Updating trunk-recorder config from profile: $PROFILE"
    cp "$PROFILE_PATH" "$DATA_DIR/config/config.json"
  else
    warn "Active profile '$PROFILE' not found in repo — config.json unchanged."
  fi
else
  warn "No active profile recorded. Re-run installer to set one."
fi
# Note: talkgroups.csv NOT overwritten — user-curated.

info "Updating systemd units..."
sudo cp pi/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload

info "Updating nginx config..."
sudo cp pi/tools/nginx-jafo.conf /etc/nginx/sites-available/jafo
sudo nginx -t && sudo systemctl reload nginx

info "Restarting services..."
sudo systemctl restart jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web

sleep 2
echo ""
for svc in jafo-recorder jafo-processor jafo-transcriber jafo-enricher jafo-web; do
  STATUS="$(systemctl is-active $svc.service 2>/dev/null || echo inactive)"
  printf "  %-22s %s\n" "$svc" "$STATUS"
done
echo ""
info "Update complete."
