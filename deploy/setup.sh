#!/usr/bin/env bash
# =============================================================================
# VPS bootstrap script for app_soldes (Hostinger / Ubuntu 22.04+ / Debian 12+)
#
# What it does (idempotent — safe to re-run):
#   1. Installs system deps (Node 20 LTS, git, nginx, certbot, build-essential)
#   2. Installs pm2 globally
#   3. Generates an SSH deploy key and prints the public key
#   4. Waits for you to add it as a Deploy Key on GitHub, then clones the repo
#   5. Installs npm deps (root + server)
#   6. Builds the Expo web bundle
#   7. Starts the API server + webhook listener via pm2
#   8. Drops an Nginx site config + enables it
#   9. Prints next steps (Certbot, GitHub webhook URL)
#
# Usage (as root or with sudo):
#   curl -fsSL https://raw.githubusercontent.com/baptisteapollo/app_soldes/claude/deploy-vercel-5TXlD/deploy/setup.sh | bash
# or:
#   sudo bash deploy/setup.sh
# =============================================================================
set -euo pipefail

# ---- CONFIG ------------------------------------------------------------------
REPO_SSH="${REPO_SSH:-git@github.com:baptisteapollo/app_soldes.git}"
BRANCH="${BRANCH:-claude/deploy-vercel-5TXlD}"
APP_USER="${APP_USER:-deploy}"
APP_DIR="${APP_DIR:-/home/${APP_USER}/app_soldes}"
DOMAIN="${DOMAIN:-}"                 # e.g. api.mondomaine.fr — leave empty to skip Nginx server_name
API_PORT="${API_PORT:-3000}"
WEBHOOK_PORT="${WEBHOOK_PORT:-9000}"
NODE_MAJOR="${NODE_MAJOR:-20}"

log()  { printf "\033[1;34m[setup]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]\033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[err ]\033[0m %s\n" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run this script as root (sudo bash deploy/setup.sh)"

# ---- 1. System packages ------------------------------------------------------
log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates build-essential nginx ufw
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2

# Certbot via snap is most up-to-date, but apt works fine too
apt-get install -y certbot python3-certbot-nginx || warn "certbot install skipped"

# ---- 2. App user -------------------------------------------------------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  log "Creating user $APP_USER"
  adduser --disabled-password --gecos "" "$APP_USER"
  usermod -aG sudo "$APP_USER"
fi

# ---- 3. SSH deploy key -------------------------------------------------------
SSH_DIR="/home/${APP_USER}/.ssh"
KEY_PATH="${SSH_DIR}/id_ed25519_app_soldes"
sudo -u "$APP_USER" mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
if [[ ! -f "$KEY_PATH" ]]; then
  log "Generating SSH deploy key"
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N "" -C "deploy@$(hostname)" -f "$KEY_PATH"
fi

# Pin github.com host key
sudo -u "$APP_USER" bash -c "ssh-keyscan -t ed25519 github.com >> ${SSH_DIR}/known_hosts 2>/dev/null"
sudo -u "$APP_USER" sort -u "${SSH_DIR}/known_hosts" -o "${SSH_DIR}/known_hosts"

# SSH config so git uses the deploy key
CONFIG_FILE="${SSH_DIR}/config"
if ! grep -q "Host github-app_soldes" "$CONFIG_FILE" 2>/dev/null; then
  cat >>"$CONFIG_FILE" <<EOF
Host github-app_soldes
  HostName github.com
  User git
  IdentityFile ${KEY_PATH}
  IdentitiesOnly yes
EOF
  chown "$APP_USER:$APP_USER" "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
fi

echo
echo "=========================================================================="
echo " Add this PUBLIC KEY as a Deploy Key on GitHub (read-only is enough):"
echo "   https://github.com/baptisteapollo/app_soldes/settings/keys/new"
echo "--------------------------------------------------------------------------"
cat "${KEY_PATH}.pub"
echo "=========================================================================="
read -r -p "Press ENTER once the key is added to GitHub... " _

# Rewrite repo URL to use the configured Host alias
REPO_ALIAS="${REPO_SSH/git@github.com:/git@github-app_soldes:}"

# ---- 4. Clone or pull --------------------------------------------------------
if [[ -d "$APP_DIR/.git" ]]; then
  log "Repo already cloned — pulling latest"
  sudo -u "$APP_USER" git -C "$APP_DIR" fetch origin "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" checkout "$BRANCH"
  sudo -u "$APP_USER" git -C "$APP_DIR" reset --hard "origin/$BRANCH"
else
  log "Cloning $REPO_ALIAS into $APP_DIR"
  sudo -u "$APP_USER" git clone --branch "$BRANCH" "$REPO_ALIAS" "$APP_DIR"
fi

# ---- 5. .env -----------------------------------------------------------------
ENV_FILE="${APP_DIR}/deploy/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Creating $ENV_FILE (edit secrets after setup!)"
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
  JWT_SECRET="$(openssl rand -hex 48)"
  cat >"$ENV_FILE" <<EOF
# Edit these values, then: pm2 restart all --update-env
NODE_ENV=production
API_PORT=${API_PORT}
WEBHOOK_PORT=${WEBHOOK_PORT}
WEBHOOK_SECRET=${WEBHOOK_SECRET}
WEBHOOK_BRANCH=${BRANCH}
JWT_SECRET=${JWT_SECRET}
EOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

# ---- 6. Install deps + first build ------------------------------------------
log "Installing npm deps (this can take a minute)"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci || npm install"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR/server' && npm ci || npm install"

log "Building Expo web bundle"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npx expo export -p web" || \
  warn "Expo web build failed — the API will still work; fix and re-run deploy/update.sh"

# ---- 7. pm2 ------------------------------------------------------------------
log "Starting services under pm2"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && pm2 startOrReload deploy/ecosystem.config.js --update-env"
sudo -u "$APP_USER" bash -lc "pm2 save"
# Enable pm2 on boot (systemd unit)
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER" | tail -n1 | bash || true

# ---- 8. Nginx ----------------------------------------------------------------
log "Writing Nginx site"
NGINX_CONF="/etc/nginx/sites-available/app_soldes"
SERVER_NAME_LINE="server_name ${DOMAIN:-_};"
sed \
  -e "s|__SERVER_NAME__|${SERVER_NAME_LINE}|g" \
  -e "s|__API_PORT__|${API_PORT}|g" \
  -e "s|__WEBHOOK_PORT__|${WEBHOOK_PORT}|g" \
  -e "s|__WEB_ROOT__|${APP_DIR}/dist|g" \
  "${APP_DIR}/deploy/nginx.conf.example" >"$NGINX_CONF"
ln -sf "$NGINX_CONF" /etc/nginx/sites-enabled/app_soldes
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

# ---- 9. Firewall -------------------------------------------------------------
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  yes | ufw enable >/dev/null 2>&1 || true
fi

# ---- Done --------------------------------------------------------------------
WEBHOOK_SECRET_VAL="$(grep ^WEBHOOK_SECRET= "$ENV_FILE" | cut -d= -f2-)"
cat <<EOF

==============================================================================
 Setup complete.

 Next steps:
   1. (Optional) Point your DNS A record to this server, then run:
        sudo certbot --nginx -d ${DOMAIN:-your.domain.tld}
   2. Add a GitHub webhook:
        URL:          http${DOMAIN:+s}://${DOMAIN:-<server-ip>}/__hooks/github
        Content type: application/json
        Secret:       ${WEBHOOK_SECRET_VAL}
        Events:       Just the push event
      -> https://github.com/baptisteapollo/app_soldes/settings/hooks/new
   3. Edit ${ENV_FILE} if you need to change secrets, then:
        sudo -u ${APP_USER} pm2 restart all --update-env

 Useful commands:
   sudo -u ${APP_USER} pm2 status
   sudo -u ${APP_USER} pm2 logs app_soldes-api
   sudo -u ${APP_USER} pm2 logs app_soldes-webhook
==============================================================================
EOF
