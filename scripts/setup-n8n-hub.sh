#!/usr/bin/env bash
# setup-n8n-hub.sh — stand up n8n (TLS via nginx + Let's Encrypt) and the
# Claude Code CLI on the jafo.live hub, in one idempotent pass.
#
# Run it ON the hub as a sudo-capable user (e.g. ubuntu):
#
#     cd ~/jafo && git pull
#     CERTBOT_EMAIL=you@example.com bash scripts/setup-n8n-hub.sh
#
# DNS FIRST: point an A record  n8n.jafo.live -> <this box's public IP>  before
# running, or the cert step is skipped (everything else still installs and you
# can run certbot later — the script prints the exact command).
#
# Re-runnable and safe: it will NOT regenerate n8n's encryption key and will NOT
# clobber an existing nginx vhost, so a cert added by certbot survives a re-run.
#
# Steps:
#   1. Node 20 (NodeSource)              — both n8n and Claude Code need it
#   2. 2 GB swapfile                     — only if the box has no swap
#   3. n8n (global npm) + systemd unit   — bound to 127.0.0.1:5678, memory-capped
#   4. nginx vhost + HTTPS (certbot)     — n8n.jafo.live, websocket-aware
#   5. Claude Code CLI                   — installed; auth is a manual one-time step
#
# Override any default via env (N8N_DOMAIN, CERTBOT_EMAIL, N8N_TZ, SWAP_SIZE, …).
set -euo pipefail

# ── config (override via env) ───────────────────────────────────────────────
N8N_DOMAIN="${N8N_DOMAIN:-n8n.jafo.live}"
N8N_SERVICE_USER="${N8N_SERVICE_USER:-ubuntu}"
N8N_BIND="${N8N_BIND:-127.0.0.1}"
N8N_PORT="${N8N_PORT:-5678}"
N8N_TZ="${N8N_TZ:-America/Chicago}"
N8N_MEM_MAX="${N8N_MEM_MAX:-1200M}"
N8N_HEAP_MB="${N8N_HEAP_MB:-768}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
NODE_MAJOR="${NODE_MAJOR:-20}"

SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }

# ── 1. Node ─────────────────────────────────────────────────────────────────
say "Node ${NODE_MAJOR}"
if command -v node >/dev/null 2>&1 && \
   [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -ge "$NODE_MAJOR" ] 2>/dev/null; then
  ok "node $(node -v) already present"
else
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
  ok "installed node $(node -v)"
fi

# ── 2. Swap (OOM insurance on a shared box) ─────────────────────────────────
say "Swap"
if [ -n "$(swapon --show --noheadings 2>/dev/null || true)" ]; then
  ok "swap already active"
elif [ -f /swapfile ]; then
  $SUDO swapon /swapfile || true
  ok "enabled existing /swapfile"
else
  $SUDO fallocate -l "$SWAP_SIZE" /swapfile
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || \
    echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
  ok "created + enabled ${SWAP_SIZE} swapfile"
fi

# ── 3. n8n: package, env, service ───────────────────────────────────────────
say "n8n install"
if command -v n8n >/dev/null 2>&1; then
  ok "n8n already installed ($(n8n --version 2>/dev/null || echo '?'))"
else
  $SUDO npm install -g n8n
  ok "installed n8n ($(n8n --version 2>/dev/null || echo '?'))"
fi
N8N_BIN="$(command -v n8n)"

say "n8n env (/etc/default/n8n)"
# Preserve an existing encryption key across re-runs (losing it orphans every
# stored credential), but refresh all other settings to the current config.
KEY=""
if [ -f /etc/default/n8n ]; then
  KEY="$(grep '^N8N_ENCRYPTION_KEY=' /etc/default/n8n | cut -d= -f2- || true)"
fi
NEWKEY=0
if [ -z "$KEY" ]; then KEY="$(openssl rand -hex 24)"; NEWKEY=1; fi
$SUDO tee /etc/default/n8n >/dev/null <<EOF
N8N_HOST=${N8N_DOMAIN}
N8N_PORT=${N8N_PORT}
N8N_LISTEN_ADDRESS=${N8N_BIND}
N8N_PROTOCOL=https
WEBHOOK_URL=https://${N8N_DOMAIN}/
N8N_EDITOR_BASE_URL=https://${N8N_DOMAIN}/
N8N_PROXY_HOPS=1
N8N_SECURE_COOKIE=true
N8N_RUNNERS_ENABLED=true
GENERIC_TIMEZONE=${N8N_TZ}
N8N_DIAGNOSTICS_ENABLED=false
NODE_OPTIONS=--max-old-space-size=${N8N_HEAP_MB}
N8N_ENCRYPTION_KEY=${KEY}
EOF
$SUDO chmod 640 /etc/default/n8n
[ "$NEWKEY" = 1 ] && ok "wrote env (new encryption key)" || ok "wrote env (preserved encryption key)"

say "n8n systemd service"
$SUDO tee /etc/systemd/system/n8n.service >/dev/null <<EOF
[Unit]
Description=n8n workflow automation
After=network.target

[Service]
Type=simple
User=${N8N_SERVICE_USER}
Environment=HOME=/home/${N8N_SERVICE_USER}
EnvironmentFile=/etc/default/n8n
ExecStart=${N8N_BIN} start
Restart=on-failure
RestartSec=5
MemoryMax=${N8N_MEM_MAX}

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable n8n >/dev/null 2>&1 || true
$SUDO systemctl restart n8n
sleep 8
if curl -s -o /dev/null -w '%{http_code}' "http://${N8N_BIND}:${N8N_PORT}/" | grep -qE '^(200|302|401)$'; then
  ok "n8n responding on ${N8N_BIND}:${N8N_PORT}"
else
  warn "n8n not responding yet — check: journalctl -u n8n -n 40 --no-pager"
fi

# ── 4. nginx vhost + HTTPS ──────────────────────────────────────────────────
say "nginx vhost"
VHOST="/etc/nginx/sites-available/${N8N_DOMAIN}"
if [ -f "$VHOST" ]; then
  ok "vhost exists — leaving intact (preserves any certbot edits)"
else
  $SUDO tee "$VHOST" >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${N8N_DOMAIN};
    location / {
        proxy_pass http://${N8N_BIND}:${N8N_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
  ok "wrote $VHOST"
fi
$SUDO ln -sf "$VHOST" "/etc/nginx/sites-enabled/${N8N_DOMAIN}"
$SUDO nginx -t && $SUDO systemctl reload nginx
ok "nginx reloaded"

say "HTTPS (certbot)"
if [ -d "/etc/letsencrypt/live/${N8N_DOMAIN}" ]; then
  ok "cert already present for ${N8N_DOMAIN}"
else
  RESOLVED="$(getent hosts "${N8N_DOMAIN}" | awk '{print $1}' | tail -n1 || true)"
  MYIP="$(curl -s --max-time 10 https://checkip.amazonaws.com || true)"
  if [ -z "$RESOLVED" ]; then
    warn "DNS for ${N8N_DOMAIN} does not resolve yet — skipping cert."
    warn "Add an A record -> ${MYIP:-this box}, then run:"
    warn "  sudo certbot --nginx -d ${N8N_DOMAIN}"
  elif [ -n "$MYIP" ] && [ "$RESOLVED" != "$MYIP" ]; then
    warn "DNS ${N8N_DOMAIN} -> ${RESOLVED} but this box is ${MYIP} — skipping cert."
    warn "Fix the A record, then run: sudo certbot --nginx -d ${N8N_DOMAIN}"
  elif [ -z "$CERTBOT_EMAIL" ]; then
    warn "DNS OK (${RESOLVED}) but CERTBOT_EMAIL not set — skipping auto-issue."
    warn "Run: sudo certbot --nginx -d ${N8N_DOMAIN}"
  else
    $SUDO certbot --nginx -d "${N8N_DOMAIN}" --non-interactive --agree-tos -m "$CERTBOT_EMAIL" --redirect
    ok "issued + installed cert for ${N8N_DOMAIN}"
  fi
fi

# ── 5. Claude Code CLI ──────────────────────────────────────────────────────
say "Claude Code CLI"
if command -v claude >/dev/null 2>&1; then
  ok "claude already installed ($(claude --version 2>/dev/null || echo '?'))"
else
  $SUDO npm install -g @anthropic-ai/claude-code
  ok "installed claude ($(claude --version 2>/dev/null || echo '?'))"
fi

# ── done ────────────────────────────────────────────────────────────────────
say "Done — manual one-time steps remaining"
cat <<EOF
  1. n8n login:   open  https://${N8N_DOMAIN}  and create the owner account.
  2. Claude in n8n: add your Anthropic API key as an n8n credential.
       (Workflow nodes hit the API locally at http://127.0.0.1:8080/api/news/...
        — same host, no public round-trip. Claude calls bill your Anthropic balance.)
  3. Claude Code auth (pick one):
       export ANTHROPIC_API_KEY=sk-ant-...        # headless, bills API credits
       claude   then  /login                       # your Claude subscription (browser)
  4. Memory check (you're watching capacity):
       free -h ; systemctl status n8n jafo-web --no-pager | grep -Ei 'Active|Memory'
EOF
