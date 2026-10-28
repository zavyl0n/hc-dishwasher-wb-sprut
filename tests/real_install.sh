#!/bin/bash
# Настоящая установка hcpy в чистом Debian — как на контроллере, только без systemd:
# скачивает uv, Python 3.13 и пакеты (нужен интернет), создаёт пользователя hcpy, пишет в /mnt/data.
# Поэтому — только в одноразовом контейнере. В CI (.github/workflows/install.yml) идёт под qemu:
#   docker run --rm --platform linux/arm64 -v "$PWD:/kit:ro" debian:bullseye bash /kit/tests/real_install.sh
set -euo pipefail

[ -f /.dockerenv ] || [ "${REAL_INSTALL_OK:-}" = 1 ] || {
    echo "Скрипт меняет систему — запускайте в контейнере (или REAL_INSTALL_OK=1)"
    exit 1
}
KIT=${KIT:-/kit}
BASE=/mnt/data/hcpy

# shellcheck disable=SC1091
echo "== система: $(dpkg --print-architecture), ядро $(uname -m), $(. /etc/os-release && echo "$PRETTY_NAME")"
if ! command -v curl >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null
fi

rm -rf /tmp/kit && mkdir -p /tmp/kit && cp -r "$KIT/hcpy_wb7" /tmp/kit/
cat > /tmp/kit/devices.json <<'EOF'
[{"name": "dishwasher", "host": "192.0.2.10", "key": "dGVzdC1ub3QtYS1yZWFsLWtleQ", "features": {}}]
EOF

echo "== 1. установка (брокера MQTT нет — пробный запуск покажет «Данных от посудомойки нет»)"
bash /tmp/kit/hcpy_wb7/install_hcpy.sh 2>&1 | tee /tmp/install.log
grep -q "uv.tar.gz: OK" /tmp/install.log
grep -q "TLS-PSK: да" /tmp/install.log
grep -q "hcpy загружается без ошибок" /tmp/install.log
grep -q "Данных от посудомойки нет" /tmp/install.log

echo "== 2. автозапуск: systemd в контейнере нет (заглушка), пользователь hcpy и юнит настоящие"
# shellcheck disable=SC2016  # $* и $1 — буквально, для заглушки
printf '#!/bin/sh\necho "systemctl $*"\n[ "$1" = is-active ] && exit 3\nexit 0\n' > /usr/local/bin/systemctl
chmod +x /usr/local/bin/systemctl
mkdir -p /etc/systemd/system
bash "$BASE/install_hcpy.sh" --service
grep -q "^User=hcpy$" /etc/systemd/system/hcpy.service
grep -q "^ProtectSystem=strict$" /etc/systemd/system/hcpy.service

echo "== 3. hcpy от пользователя hcpy: файлы читаются, процесс доходит до подключения к MQTT"
cd "$BASE/app"
# shellcheck disable=SC2046  # параметры — как в ExecStart юнита
timeout 30 runuser -u hcpy -- env PYTHONDONTWRITEBYTECODE=1 \
    $(sed -n 's/^ExecStart=//p' /etc/systemd/system/hcpy.service) > /tmp/hcpy.log 2>&1 || true
tail -n 3 /tmp/hcpy.log
grep -q "Hello devices_file=" /tmp/hcpy.log
grep -q "Connection refused" /tmp/hcpy.log
if grep -qE "PermissionError|Permission denied" /tmp/hcpy.log; then
    echo "ОШИБКА: пользователю hcpy не хватает прав"
    exit 1
fi

echo "== 4. удаление"
bash "$BASE/install_hcpy.sh" --remove
[ ! -e "$BASE" ] || { echo "ОШИБКА: $BASE не удалён"; exit 1; }
if id -u hcpy >/dev/null 2>&1; then echo "ОШИБКА: пользователь hcpy не удалён"; exit 1; fi

echo "== ГОТОВО: $(dpkg --print-architecture) — установка, запуск от hcpy и удаление работают"
