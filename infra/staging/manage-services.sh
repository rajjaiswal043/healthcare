#!/usr/bin/env bash
set -euo pipefail

test "$(id -u)" -eq 0
test "$(hostname)" = "healthcloud-staging"

ACTION="${1:-}"
ROOT="/opt/healthcloud-staging"

case "$ACTION" in
  install)
    cat > /etc/systemd/system/healthcloud-staging-api.service <<'EOF'
[Unit]
Description=HealthCloud Staging API
After=network.target postgresql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/healthcloud-staging/current/apps/api
EnvironmentFile=/opt/healthcloud-staging/shared/.env
Environment=NODE_ENV=production
Environment=API_HOST=127.0.0.1
ExecStart=/usr/bin/node dist/src/main.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

    cat > /etc/systemd/system/healthcloud-staging-web.service <<'EOF'
[Unit]
Description=HealthCloud Staging Web
After=network.target healthcloud-staging-api.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/healthcloud-staging/current/apps/web
EnvironmentFile=/opt/healthcloud-staging/shared/.env
Environment=NODE_ENV=production
Environment=HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node scripts/next-with-dist.mjs .next-build start --port 3000
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable healthcloud-staging-api.service
    systemctl enable healthcloud-staging-web.service
    ;;

  restart)
    systemctl restart healthcloud-staging-api.service
    systemctl restart healthcloud-staging-web.service
    ;;

  *)
    echo "Usage: $0 install|restart"
    exit 2
    ;;
esac
