#!/bin/bash
# Мост Home Connect -> MQTT (hcpy) для Wiren Board 7.
# Всё ставится в /mnt/data/hcpy; системный Python и прошивка WB не затрагиваются.
#
#   bash install_hcpy.sh            установка или обновление + пробное подключение к посудомойке (30 с)
#   bash install_hcpy.sh --service  включить автозапуск (systemd-служба hcpy)
#   bash install_hcpy.sh --remove   остановить службу и удалить всё, что поставлено
#
# Необязательные переменные:
#   MQTT_USER, MQTT_PASS  логин и пароль брокера, если на нём включена авторизация;
#                         сохраняются в /mnt/data/hcpy/config/hcpy.ini (читает только служба)
#   MQTT_HOST             адрес брокера, по умолчанию 127.0.0.1
#   HARDEN=0              запускать hcpy от root без ограничений systemd, как в прежних версиях
#                         (выбор запоминается; HARDEN=1 вернёт ограничения)
set -euo pipefail

BASE=${BASE:-/mnt/data/hcpy}
MQTT_HOST=${MQTT_HOST:-127.0.0.1}
PREFIX=homeconnect/
HCPY_USER=${HCPY_USER:-hcpy}
HARDEN=${HARDEN:-}
UV_VERSION=0.11.32
UV_TARGET=${UV_TARGET:-armv7-unknown-linux-gnueabihf}
UV_SHA256=${UV_SHA256:-593e0f6b92cef908b23e3e3e0da2fd8ae24392afdb70eed05651869fea4a1b02}
SRC=$(cd "$(dirname "$0")" && pwd)
UNIT=${UNIT:-/etc/systemd/system/hcpy.service}
INI=$BASE/config/hcpy.ini
USER_MARK=$BASE/config/.user-created
HARDEN_FILE=$BASE/.harden

say() { printf '\n== %s\n' "$*"; }
fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi
}

# параметры hc2mqtt для службы и пробного запуска
hcpy_args() {
    printf '%s' "-u hc2mqtt.py -d $BASE/config/devices.json -h $MQTT_HOST -p $PREFIX"
    if [ -f "$INI" ]; then printf ' --config %s' "$INI"; fi
}

# HARDEN из переменной (и запомнить) или из прошлой установки; по умолчанию 1
load_harden() {
    if [ -n "$HARDEN" ]; then
        echo "$HARDEN" > "$HARDEN_FILE"
    elif [ -f "$HARDEN_FILE" ]; then
        HARDEN=$(cat "$HARDEN_FILE")
    fi
    HARDEN=${HARDEN:-1}
}

# Служба работает от отдельного пользователя: ей нужны только чтение своих файлов и сеть.
setup_user() {
    [ "$HARDEN" != 0 ] || return 0
    if ! id -u "$HCPY_USER" >/dev/null 2>&1; then
        useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$HCPY_USER"
        touch "$USER_MARK"
        echo "создан системный пользователь $HCPY_USER"
    fi
    chown -R "$HCPY_USER:$HCPY_USER" "$BASE/config"
    chmod 700 "$BASE/config"
}

write_unit() {
    local service="" harden=""
    if [ "$HARDEN" != 0 ]; then
        service="User=$HCPY_USER
Group=$HCPY_USER"
        harden="# hcpy только читает свои файлы и ходит в сеть; HARDEN=0 при установке отключит ограничения
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes"
    fi
    cat > "$UNIT" <<EOF
[Unit]
Description=hcpy: Home Connect -> MQTT (посудомойка)
After=network-online.target mosquitto.service
Wants=network-online.target
RequiresMountsFor=/mnt/data

[Service]
$service
WorkingDirectory=$BASE/app
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart=$BASE/venv/bin/python $(hcpy_args)
Restart=always
RestartSec=15
$harden

[Install]
WantedBy=multi-user.target
EOF
}

# Логин и пароль MQTT -> hcpy.ini (формат configobj, его читает hc2mqtt --config), права 600
write_ini() {
    [ -n "${MQTT_USER:-}" ] || return 0
    MQTT_USER="$MQTT_USER" MQTT_PASS="${MQTT_PASS:-}" venv/bin/python - "$INI" <<'PY'
import os, sys

def quote(v):
    if "\n" in v or ('"' in v and "'" in v):
        sys.exit("логин и пароль MQTT не должны содержать перевод строки или обе кавычки сразу")
    if "%(" in v:   # configobj, которым hcpy читает файл, понимает %(имя)s как подстановку
        sys.exit("логин и пароль MQTT не должны содержать «%(»")
    return "'%s'" % v if '"' in v else '"%s"' % v

text = ("# логин и пароль MQTT для hcpy (install_hcpy.sh, переменные MQTT_USER и MQTT_PASS)\n"
        "mqtt_username = %s\nmqtt_password = %s\n"
        % (quote(os.environ["MQTT_USER"]), quote(os.environ["MQTT_PASS"])))   # сначала проверка, потом запись
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(text)
PY
    echo "логин MQTT сохранён в $INI"
}

case "${1:-}" in
--remove)
    systemctl disable --now hcpy.service 2>/dev/null || true
    rm -f "$UNIT" && systemctl daemon-reload
    if [ -f "$USER_MARK" ] && id -u "$HCPY_USER" >/dev/null 2>&1; then
        userdel "$HCPY_USER" && echo "удалён пользователь $HCPY_USER" || true
    fi
    rm -rf "$BASE"
    echo "Удалено: служба hcpy и $BASE"
    exit 0
    ;;
--service)
    [ -x "$BASE/venv/bin/python" ] || { echo "Сначала запустите установку без параметров"; exit 1; }
    load_harden
    setup_user
    write_unit
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
load_harden
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
sed -i '1s/^\xEF\xBB\xBF//' config/devices.json   # BOM от Блокнота Windows мешает hcpy

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
venv/bin/python - config/devices.json <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        devs = json.load(fh)
except ValueError as e:
    sys.exit("devices.json не читается как JSON: %s" % e)
if not isinstance(devs, list):
    sys.exit("devices.json должен быть списком приборов: [ { ... } ]")
bad = [str(d.get("name")) if isinstance(d, dict) else repr(d)
       for d in devs if not isinstance(d, dict) or not d.get("key") or not d.get("host")]
if bad:
    sys.exit("в devices.json нет key или host у приборов: " + ", ".join(bad))
print("devices.json: " + ", ".join("%s (%s)" % (d.get("name"), d.get("host")) for d in devs))
PY

say "3/5 hcpy ($(head -1 "$SRC/app/VERSION" 2>/dev/null))"
rm -rf app && cp -r "$SRC/app" app
echo "файлы в $BASE/app"

say "4/5 зависимости"
bin/uv pip install --python venv/bin/python --require-hashes -r "$SRC/requirements-wb7.txt"
bin/uv cache clean >/dev/null 2>&1 || true          # кэш пакетов больше не нужен, место на /mnt/data
(cd app && ../venv/bin/python -c "import hc2mqtt" && echo "hcpy загружается без ошибок")
chmod -R go+rX app venv python 2>/dev/null || true  # служба работает не от root
write_ini

if systemctl is-active --quiet hcpy.service 2>/dev/null; then
    echo; echo "Служба hcpy уже работает - пробный запуск пропущен."
    setup_user
    write_unit
    systemctl daemon-reload
    systemctl restart hcpy.service && echo "Служба перезапущена с новыми файлами."
    exit 0
fi

say "5/5 пробное подключение к посудомойке (30 с). Посудомойка должна быть включена."
if [ -z "${MQTT_USER:-}" ] && [ -f "$INI" ]; then   # логин сохранён при прошлой установке
    MQTT_USER=$(venv/bin/python -c 'import configobj, sys; print(configobj.ConfigObj(sys.argv[1]).get("mqtt_username", ""))' "$INI")
    MQTT_PASS=$(venv/bin/python -c 'import configobj, sys; print(configobj.ConfigObj(sys.argv[1]).get("mqtt_password", ""))' "$INI")
fi
TMP=$(mktemp -d)
if command -v mosquitto_sub >/dev/null 2>&1; then
    auth=()
    if [ -n "${MQTT_USER:-}" ]; then auth=(-u "$MQTT_USER" -P "${MQTT_PASS:-}"); fi
    timeout 34 mosquitto_sub -h "$MQTT_HOST" "${auth[@]}" -t "${PREFIX}#" -v > "$TMP/mqtt.log" 2>&1 &
    SUB=$!
    sleep 1
fi
# shellcheck disable=SC2046  # hcpy_args — несколько параметров без пробелов внутри
(cd app && timeout 30 ../venv/bin/python $(hcpy_args) > "$TMP/hcpy.log" 2>&1) || true
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
