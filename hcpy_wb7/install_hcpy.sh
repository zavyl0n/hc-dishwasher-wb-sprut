#!/bin/bash
# Мост Home Connect -> MQTT (hcpy) для Wiren Board 7.
# Всё ставится в /mnt/data/hcpy; системный Python и прошивка WB не затрагиваются.
#
#   bash install_hcpy.sh            установка + пробное подключение к посудомойке (30 с)
#   bash install_hcpy.sh --service  включить автозапуск (systemd-служба hcpy)
#   bash install_hcpy.sh --remove   остановить службу и удалить всё, что поставлено
set -euo pipefail

BASE=${BASE:-/mnt/data/hcpy}
MQTT_HOST=${MQTT_HOST:-127.0.0.1}
PREFIX=homeconnect/
UV_VERSION=0.11.32
UV_TARGET=${UV_TARGET:-armv7-unknown-linux-gnueabihf}
UV_SHA256=${UV_SHA256:-593e0f6b92cef908b23e3e3e0da2fd8ae24392afdb70eed05651869fea4a1b02}
SRC=$(cd "$(dirname "$0")" && pwd)
UNIT=/etc/systemd/system/hcpy.service

say() { printf '\n== %s\n' "$*"; }
fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi
}

case "${1:-}" in
--remove)
    systemctl disable --now hcpy.service 2>/dev/null || true
    rm -f "$UNIT" && systemctl daemon-reload
    rm -rf "$BASE"
    echo "Удалено: служба hcpy и $BASE"
    exit 0
    ;;
--service)
    [ -x "$BASE/venv/bin/python" ] || { echo "Сначала запустите установку без параметров"; exit 1; }
    cat > "$UNIT" <<EOF
[Unit]
Description=hcpy: Home Connect -> MQTT (посудомойка)
After=network-online.target mosquitto.service
Wants=network-online.target
RequiresMountsFor=/mnt/data

[Service]
WorkingDirectory=$BASE/app
ExecStart=$BASE/venv/bin/python -u hc2mqtt.py -d $BASE/config/devices.json -h $MQTT_HOST -p $PREFIX
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now hcpy.service
    sleep 8
    systemctl --no-pager --lines=12 status hcpy.service || true
    exit 0
    ;;
"") ;;
*) echo "Неизвестный параметр: $1"; exit 1 ;;
esac

[ "$SRC" != "$BASE" ] || { echo "Установку запускайте из распакованного архива hcpy_wb7"; exit 1; }
mkdir -p "$BASE"/bin "$BASE"/config
cd "$BASE"
cp "$SRC/install_hcpy.sh" "$BASE/install_hcpy.sh"  # копия для --service / --remove
export UV_PYTHON_INSTALL_DIR="$BASE/python" UV_CACHE_DIR="$BASE/cache" UV_NO_PROGRESS=1 UV_PYTHON_PREFERENCE=only-managed

say "0/5 файл devices.json"
for f in "$SRC/devices.json" "$SRC/../devices.json" /tmp/devices.json; do
    if [ -f "$f" ]; then
        install -m 600 "$f" config/devices.json && rm -f "$f"
        echo "перенесён $f -> $BASE/config/devices.json"
        break
    fi
done
[ -f config/devices.json ] || { echo "Нет devices.json: скопируйте его в /tmp на WB7 и запустите снова"; exit 1; }

say "1/5 uv $UV_VERSION"
if ! bin/uv --version 2>/dev/null | grep -q " $UV_VERSION"; then
    fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TARGET.tar.gz" uv.tar.gz
    echo "$UV_SHA256  uv.tar.gz" | sha256sum -c -
    tar xzf uv.tar.gz --strip-components=1 -C bin
    rm -f uv.tar.gz
fi
bin/uv --version

say "2/5 Python 3.13"
bin/uv python install 3.13 --no-bin
[ -x venv/bin/python ] || bin/uv venv --python 3.13 venv
venv/bin/python -c "import ssl, sys; ok = ssl.HAS_PSK; print(sys.version.split()[0], ssl.OPENSSL_VERSION, '| TLS-PSK:', 'да' if ok else 'НЕТ'); sys.exit(0 if ok else 1)"

say "3/5 hcpy ($(cat "$SRC/app/VERSION" 2>/dev/null | head -1))"
rm -rf app && cp -r "$SRC/app" app
echo "файлы в $BASE/app"

say "4/5 зависимости"
bin/uv pip install --python venv/bin/python --require-hashes -r "$SRC/requirements-wb7.txt"
(cd app && ../venv/bin/python -c "import hc2mqtt" && echo "hcpy загружается без ошибок")

if systemctl is-active --quiet hcpy.service 2>/dev/null; then
    echo; echo "Служба hcpy уже работает - пробный запуск пропущен."
    systemctl restart hcpy.service && echo "Служба перезапущена с новыми файлами."
    exit 0
fi

say "5/5 пробное подключение к посудомойке (30 с). Посудомойка должна быть включена."
TMP=$(mktemp -d)
if command -v mosquitto_sub >/dev/null 2>&1; then
    timeout 34 mosquitto_sub -h "$MQTT_HOST" -t "${PREFIX}#" -v > "$TMP/mqtt.log" 2>&1 &
    SUB=$!
    sleep 1
fi
(cd app && timeout 30 ../venv/bin/python -u hc2mqtt.py -d "$BASE/config/devices.json" -h "$MQTT_HOST" -p "$PREFIX" > "$TMP/hcpy.log" 2>&1) || true
[ -n "${SUB:-}" ] && { wait "$SUB" 2>/dev/null || true; }

N=$(grep -c "/state/" "$TMP/mqtt.log" 2>/dev/null || true)
if [ "${N:-0}" -gt 0 ]; then
    echo "ПОЛУЧИЛОСЬ: от посудомойки пришло $N значений. Например:"
    grep -E "operationstate|doorstate|powerstate|remainingprogramtime|swversion|enumber" "$TMP/mqtt.log" | sort -u | head -12
    echo
    echo "Дальше: bash $BASE/install_hcpy.sh --service   (включит автозапуск)"
else
    echo "Данных от посудомойки нет. Последние строки журнала hcpy:"
    tail -n 25 "$TMP/hcpy.log"
fi
rm -rf "$TMP"
