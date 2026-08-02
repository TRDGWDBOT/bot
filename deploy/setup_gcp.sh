#!/usr/bin/env bash
# ============================================================
# XAUBot — Setup automatico su Google Cloud Always Free (e2-micro)
# Ubuntu 22.04 LTS — esegue tutto: dipendenze, MongoDB, backend,
# frontend buildato, Nginx con HTTPS auto (Caddy in alternativa)
# ============================================================
# Uso (sulla VM appena creata, come utente normale con sudo):
#   curl -fsSL https://raw.githubusercontent.com/TUO_USER/TUO_REPO/main/deploy/setup_gcp.sh | bash
# Oppure: scp del file e ./setup_gcp.sh
# ============================================================
set -euo pipefail

# ---- CONFIG (modifica se necessario) ------------------------
APP_DIR="/opt/xaubot"
REPO_URL="${REPO_URL:-}"          # opzionale: git clone se valorizzato
BACKEND_PORT=8001
NODE_VERSION="20"
DOMAIN="${DOMAIN:-}"              # se imposti un dominio -> HTTPS automatico via Caddy
# -------------------------------------------------------------

log()  { echo -e "\033[1;32m[XAUBOT]\033[0m $*"; }
err()  { echo -e "\033[1;31m[ERRORE]\033[0m $*" >&2; }

if [[ $EUID -eq 0 ]]; then
  err "Non eseguire come root. Usa un utente normale con sudo."
  exit 1
fi

log "1/7  Aggiorno il sistema..."
sudo apt-get update -y
sudo apt-get upgrade -y

log "2/7  Installo dipendenze base (python, git, build tools, nginx/caddy)..."
sudo apt-get install -y \
  python3 python3-pip python3-venv \
  git curl wget gnupg ca-certificates lsb-release \
  build-essential ufw

# Node.js LTS via NodeSource
if ! command -v node >/dev/null 2>&1; then
  log "   Installo Node.js ${NODE_VERSION}..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# Yarn
if ! command -v yarn >/dev/null 2>&1; then
  sudo npm install -g yarn
fi

log "3/7  Installo MongoDB Community 7.0..."
if ! command -v mongod >/dev/null 2>&1; then
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | \
    sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
  UBUNTU_CODENAME="$(lsb_release -cs)"
  # MongoDB 7 supporta jammy (22.04) e noble (24.04)
  case "$UBUNTU_CODENAME" in
    noble) REPO_CODENAME="jammy" ;;  # repo jammy funziona anche su 24.04
    *)     REPO_CODENAME="$UBUNTU_CODENAME" ;;
  esac
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${REPO_CODENAME}/mongodb-org/7.0 multiverse" | \
    sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
  sudo apt-get update -y
  sudo apt-get install -y mongodb-org
  sudo systemctl enable --now mongod
fi

log "4/7  Preparo la cartella applicazione in ${APP_DIR}..."
sudo mkdir -p "${APP_DIR}"
sudo chown -R "$USER:$USER" "${APP_DIR}"

if [[ -n "${REPO_URL}" && ! -d "${APP_DIR}/.git" ]]; then
  log "   Clono ${REPO_URL}..."
  git clone "${REPO_URL}" "${APP_DIR}"
else
  log "   ⚠️  Copia manualmente i file del progetto in ${APP_DIR} (cartella backend/ e frontend/)"
  log "      Esempio: scp -r xaubot/* utente@IP:${APP_DIR}/"
  read -p "   Premi INVIO quando i file sono stati copiati..." _
fi

log "5/7  Installo backend (Python venv + requirements)..."
cd "${APP_DIR}/backend"
python3 -m venv venv
# shellcheck disable=SC1091
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
deactivate

# .env del backend (se non esiste)
if [[ ! -f "${APP_DIR}/backend/.env" ]]; then
  cat > "${APP_DIR}/backend/.env" <<EOF
MONGO_URL=mongodb://localhost:27017
DB_NAME=xaubot
DERIV_DEFAULT_APP_ID=1089
EOF
fi

log "6/7  Build frontend (React → static)..."
cd "${APP_DIR}/frontend"
if [[ -z "${DOMAIN}" ]]; then
  # Se non c'è dominio, il frontend chiama il backend sullo stesso host
  EXTERNAL_IP="$(curl -s ifconfig.me || echo localhost)"
  BACKEND_PUBLIC_URL="http://${EXTERNAL_IP}"
else
  BACKEND_PUBLIC_URL="https://${DOMAIN}"
fi
cat > .env <<EOF
REACT_APP_BACKEND_URL=${BACKEND_PUBLIC_URL}
EOF
yarn install --frozen-lockfile || yarn install
yarn build

log "7/7  Configuro systemd + reverse proxy..."
# --- systemd service per il backend ---
sudo tee /etc/systemd/system/xaubot-backend.service >/dev/null <<EOF
[Unit]
Description=XAUBot FastAPI backend
After=network.target mongod.service
Requires=mongod.service

[Service]
Type=simple
User=${USER}
WorkingDirectory=${APP_DIR}/backend
EnvironmentFile=${APP_DIR}/backend/.env
ExecStart=${APP_DIR}/backend/venv/bin/uvicorn server:app --host 127.0.0.1 --port ${BACKEND_PORT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now xaubot-backend

# --- Reverse proxy: Caddy se c'è dominio (HTTPS auto), altrimenti Nginx HTTP ---
if [[ -n "${DOMAIN}" ]]; then
  log "   Installo Caddy (HTTPS automatico per ${DOMAIN})..."
  if ! command -v caddy >/dev/null 2>&1; then
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | \
      sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | \
      sudo tee /etc/apt/sources.list.d/caddy-stable.list
    sudo apt-get update -y
    sudo apt-get install -y caddy
  fi
  sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
${DOMAIN} {
    encode gzip
    handle /api/* {
        reverse_proxy 127.0.0.1:${BACKEND_PORT}
    }
    handle {
        root * ${APP_DIR}/frontend/build
        try_files {path} /index.html
        file_server
    }
}
EOF
  sudo systemctl enable --now caddy
  sudo systemctl reload caddy
else
  log "   Installo Nginx (HTTP — nessun dominio impostato)..."
  sudo apt-get install -y nginx
  sudo tee /etc/nginx/sites-available/xaubot >/dev/null <<EOF
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    root ${APP_DIR}/frontend/build;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:${BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
  sudo ln -sf /etc/nginx/sites-available/xaubot /etc/nginx/sites-enabled/xaubot
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl enable --now nginx
  sudo systemctl reload nginx
fi

log "Configuro firewall UFW..."
sudo ufw --force enable
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload || true

echo
log "✅ INSTALLAZIONE COMPLETATA"
echo
if [[ -n "${DOMAIN}" ]]; then
  echo "   🌐 Frontend: https://${DOMAIN}"
  echo "   🔧 API:      https://${DOMAIN}/api/"
else
  EXTERNAL_IP="$(curl -s ifconfig.me || echo IP-PUBBLICO)"
  echo "   🌐 Frontend: http://${EXTERNAL_IP}"
  echo "   🔧 API:      http://${EXTERNAL_IP}/api/"
fi
echo
echo "   📋 Comandi utili:"
echo "      sudo systemctl status  xaubot-backend"
echo "      sudo journalctl -u xaubot-backend -f"
echo "      sudo systemctl restart xaubot-backend"
echo
