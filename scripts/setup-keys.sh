#!/usr/bin/env bash
#
# jafo — enter (or change) your own service credentials, interactively.
#
#   bash ~/jafo/scripts/setup-keys.sh
#
# Asks for each key in turn. Press Enter to keep what's already set. Keys are
# typed without echo, written only to this Pi (~/jafo/.env and
# ~/jafo-data/config/radioreference.json, both chmod 600), never printed in
# full and never sent anywhere except the service they belong to.
# Safe to re-run any time; restarts only the services whose keys changed.
#
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/jafo}"
DATA_DIR="${DATA_DIR:-$HOME/jafo-data}"
ENV_FILE="${ENV_FILE:-$INSTALL_DIR/.env}"
RR_FILE="${RR_FILE:-$DATA_DIR/config/radioreference.json}"
NO_RESTART="${NO_RESTART:-0}"

B='\033[1m'; G='\033[0;32m'; Y='\033[1;33m'; D='\033[2m'; N='\033[0m'

umask 077
mkdir -p "$(dirname "$ENV_FILE")" "$(dirname "$RR_FILE")"
[[ -f "$ENV_FILE" ]] || { [[ -f "$INSTALL_DIR/.env.example" ]] && cp "$INSTALL_DIR/.env.example" "$ENV_FILE" || : > "$ENV_FILE"; }
chmod 600 "$ENV_FILE"

get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/' || true; }
mask() { local v="$1"; [[ -z "$v" ]] && echo "not set" || echo "set (…${v: -4})"; }

# Replace KEY=… in place, or append it. Values go through the environment,
# so no shell or sed escaping can mangle them.
put() {
  local k="$1" v="$2" tmp
  tmp="$(mktemp "$ENV_FILE.XXXX")"
  K="$k" V="$v" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]; done=0}
    $0 ~ "^"k"=" { if (!done) { print k"="v; done=1 }; next }
    { print }
    END { if (!done) print k"="v }' "$ENV_FILE" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$ENV_FILE"
}

CHANGED=()
ask_secret() {   # key, label, where-to-get-it, required|optional
  local k="$1" label="$2" url="$3" need="$4" cur new
  cur="$(get "$k")"
  echo
  echo -e "${B}$label${N}  ${D}($need)${N}"
  echo -e "  Get one at: $url"
  echo -e "  Currently: $(mask "$cur")"
  read -rsp "  Paste key (Enter to keep): " new; echo
  new="$(echo -n "$new" | tr -d '[:space:]')"
  if [[ -n "$new" && "$new" != "$cur" ]]; then put "$k" "$new"; CHANGED+=("$k"); echo -e "  ${G}saved${N}"; fi
}
ask_plain() {    # key, label, hint
  local k="$1" label="$2" hint="$3" cur new
  cur="$(get "$k")"
  echo
  echo -e "${B}$label${N}  ${D}$hint${N}"
  read -rp "  Value [${cur:-none}]: " new
  if [[ -n "$new" && "$new" != "$cur" ]]; then
    [[ "$new" =~ [[:space:],] ]] && new="\"$new\""
    put "$k" "$new"; CHANGED+=("$k"); echo -e "  ${G}saved${N}"
  fi
}

cat <<'EOF'

  jafo — your credentials
  ───────────────────────
  JAFO uses a few outside services. Each needs YOUR OWN account and key:
  the keys are billed to you, stay on this Pi, and are never shared.
  Press Enter at any prompt to keep the current value.
EOF

ask_secret GROQ_API_KEY      "Groq — speech-to-text (Whisper)"       "https://console.groq.com/keys"           "required for transcripts"
ask_secret ANTHROPIC_API_KEY "Anthropic — Claude summaries"           "https://console.anthropic.com/settings/keys" "recommended"

echo
echo -e "${B}RadioReference — finds your radio system's frequencies and talkgroups${N}  ${D}(recommended)${N}"
echo    "  Needs a RadioReference Premium subscription and an API app key."
echo    "  Sign up at https://www.radioreference.com, then request an app key under My Account."
rr_user=""; rr_have=no
[[ -s "$RR_FILE" ]] && rr_have=yes
echo -e "  Currently: $([[ $rr_have == yes ]] && echo set || echo 'not set')"
read -rp "  Set or change it now? [y/N]: " yn
if [[ "${yn,,}" == y* ]]; then
  read -rp  "  RadioReference username: " rr_user
  read -rsp "  RadioReference password: " rr_pass; echo
  read -rsp "  API app key: " rr_key; echo
  RU="$rr_user" RP="$rr_pass" RK="$rr_key" python3 - "$RR_FILE" <<'PY'
import json, os, sys
json.dump({"appKey": os.environ["RK"].strip(), "username": os.environ["RU"].strip(),
           "password": os.environ["RP"]}, open(sys.argv[1], "w"))
PY
  chmod 600 "$RR_FILE"; CHANGED+=(RADIOREFERENCE); echo -e "  ${G}saved${N}"
fi

ask_plain JAFO_REGION "Your area, for placing addresses on the map" "e.g. McAllen, Hidalgo County, Texas"

echo
echo -e "${B}jafo.live — share your station on the public map${N}  ${D}(optional)${N}"
echo    "  Without this your station runs on its own at http://$(hostname).local"
echo    "  To feed jafo.live, ask the JAFO team for a node token, then paste it here."
ask_secret JAFO_NODE_TOKEN "jafo.live node token" "the JAFO team (see the Build guide)" "optional"
if [[ " ${CHANGED[*]} " == *" JAFO_NODE_TOKEN "* ]]; then
  [[ -n "$(get JAFO_HUB_URL)" ]] || put JAFO_HUB_URL "https://jafo.live"
  ask_plain JAFO_NODE_SLUG "Node name the JAFO team gave you" "e.g. jafo-phoenix-07"
fi

echo
echo -e "${B}Optional extras${N}"
ask_secret JAFO_TOMTOM_KEY "TomTom — live traffic layer" "https://developer.tomtom.com" "optional"

echo
if [[ ${#CHANGED[@]} -eq 0 ]]; then
  echo -e "${G}Nothing changed.${N}"; exit 0
fi
echo -e "${G}Saved:${N} ${CHANGED[*]}  →  $ENV_FILE (only you can read it)"
[[ "$NO_RESTART" == 1 ]] && exit 0

svcs=()
for k in "${CHANGED[@]}"; do case "$k" in
  GROQ_API_KEY) svcs+=(jafo-transcriber) ;;
  ANTHROPIC_API_KEY|JAFO_REGION) svcs+=(jafo-enricher jafo-web) ;;
  JAFO_NODE_TOKEN|JAFO_NODE_SLUG) svcs+=(jafo-uploader jafo-web) ;;
  JAFO_TOMTOM_KEY) svcs+=(jafo-web) ;;
esac; done
mapfile -t svcs < <(printf '%s\n' "${svcs[@]}" | sort -u)
for s in "${svcs[@]}"; do
  if systemctl list-unit-files "$s.service" --no-legend 2>/dev/null | grep -q .; then
    sudo systemctl restart "$s" && echo "  restarted $s"
  fi
done
if [[ " ${CHANGED[*]} " == *" JAFO_NODE_TOKEN "* ]] && [[ -f "$INSTALL_DIR/pi/systemd/jafo-uploader.service" ]]; then
  [[ -f /etc/systemd/system/jafo-uploader.service ]] || { sudo cp "$INSTALL_DIR/pi/systemd/jafo-uploader.service" /etc/systemd/system/ && sudo systemctl daemon-reload; }
  sudo systemctl enable --now jafo-uploader && echo "  jafo-uploader on: your station now feeds jafo.live"
fi
if [[ " ${CHANGED[*]} " == *" RADIOREFERENCE "* ]] && [[ -f "$INSTALL_DIR/pi/tools/relocate.py" ]]; then
  echo -e "${Y}Next:${N} look up your local radio system with"
  echo    "  python3 ~/jafo/pi/tools/relocate.py"
fi
