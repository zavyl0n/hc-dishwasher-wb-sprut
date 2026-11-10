#!/bin/bash
# Мост Home Connect -> MQTT (hcpy) для Wiren Board 7.
# Всё ставится в /mnt/data/hcpy; системный Python и прошивка WB не затрагиваются.
#
#   bash install_hcpy.sh --devices /путь/devices.json [--device имя]  установка
#   bash install_hcpy.sh            обновление с сохранённым профилем
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
MQTT_HOST_FILE=$BASE/.mqtt-host
MQTT_HOST=${MQTT_HOST:-$(cat "$MQTT_HOST_FILE" 2>/dev/null || printf 127.0.0.1)}
RUN_DIR=$BASE/current

say() { printf '\n== %s\n' "$*"; }
lock_install() {
    exec 9>"$BASE/.install.lock"
    flock -n 9 || { echo "Установка hcpy уже выполняется"; exit 1; }
}
fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi
}

# HARDEN из переменной или из прошлой установки; по умолчанию 1
load_harden() {
    if [ -z "$HARDEN" ] && [ -f "$HARDEN_FILE" ]; then
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
    local service="" harden="" auth=""
    if [ -f "$INI" ]; then auth=" --config \"$INI\""; fi
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
    cat > "$1" <<EOF
[Unit]
Description=hcpy: Home Connect -> MQTT (посудомойка)
After=network-online.target mosquitto.service
Wants=network-online.target
RequiresMountsFor=/mnt/data

[Service]
$service
WorkingDirectory=$RUN_DIR/app
Environment=PYTHONDONTWRITEBYTECODE=1
ExecStart="$RUN_DIR/venv/bin/python" -u hc2mqtt.py -d "$BASE/config/devices.json" -h "$MQTT_HOST" -p "$PREFIX"$auth
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
    MQTT_USER="$MQTT_USER" MQTT_PASS="${MQTT_PASS:-}" "$1" - "$2" <<'PY'
import os, sys

def quote(v):
    if "\n" in v or "\r" in v or ('"' in v and "'" in v):
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
}

case "${1:-}" in
--remove)
    if [ -d "$BASE" ]; then lock_install; fi
    systemctl disable --now hcpy.service 2>/dev/null || true
    rm -f "$UNIT" && systemctl daemon-reload
    if [ -f "$USER_MARK" ] && id -u "$HCPY_USER" >/dev/null 2>&1; then
        if userdel "$HCPY_USER"; then echo "удалён пользователь $HCPY_USER"; fi
    fi
    rm -rf "$BASE"
    echo "Удалено: служба hcpy и $BASE"
    exit 0
    ;;
--service)
    # Сохраняем возможность управлять службой до обновления старой установки.
    if [ ! -x "$RUN_DIR/venv/bin/python" ]; then RUN_DIR=$BASE; fi
    [ -x "$RUN_DIR/venv/bin/python" ] || { echo "Сначала запустите установку с --devices"; exit 1; }
    lock_install
    load_harden
    setup_user
    write_unit "$UNIT"
    systemctl daemon-reload
    if systemctl is-active --quiet hcpy.service; then
        systemctl enable hcpy.service
        systemctl restart hcpy.service
    else
        systemctl enable --now hcpy.service
    fi
    printf '%s\n' "$HARDEN" > "$HARDEN_FILE"
    systemctl --no-pager --lines=12 status hcpy.service
    exit 0
    ;;
esac

PROFILE=
DEVICE=
while [ "$#" -gt 0 ]; do
    case "$1" in
    --devices) [ "$#" -ge 2 ] || { echo "Укажите путь после --devices"; exit 1; }; PROFILE=$2 ;;
    --device) [ "$#" -ge 2 ] || { echo "Укажите имя после --device"; exit 1; }; DEVICE=$2 ;;
    *) echo "Неизвестный параметр: $1"; exit 1 ;;
    esac
    shift 2
done
PROFILE=${PROFILE:-$BASE/config/devices.json}
[ -f "$PROFILE" ] || { echo "Нет devices.json: укажите путь через --devices"; exit 1; }
[ "$SRC" != "$BASE" ] || { echo "Установку запускайте из распакованного архива hcpy_wb7"; exit 1; }
umask 077
mkdir -p "$BASE" "$BASE"/bin "$BASE"/config "$BASE"/releases
chmod 755 "$BASE" "$BASE"/releases
lock_install
load_harden
TX=$(mktemp -d "$BASE/.install.XXXXXXXX")
RELEASE=
PREVIOUS=
ACTIVATING=0
ACTIVE=0
COMMITTED=0
SUB=

cleanup() {
    local rc=$?
    trap - EXIT
    set +e
    if [ -n "$SUB" ]; then kill "$SUB" 2>/dev/null; fi
    if [ "$COMMITTED" -eq 0 ] && [ "$ACTIVATING" -eq 1 ]; then
        say "Откат установки hcpy"
        if [ -n "$PREVIOUS" ]; then
            ln -s "$PREVIOUS" "$TX/previous" && mv -Tf "$TX/previous" "$RUN_DIR"
        else
            rm -f "$RUN_DIR"
        fi
        for item in "$BASE/config/devices.json" "$INI" "$HARDEN_FILE" "$MQTT_HOST_FILE" "$UNIT"; do
            if [ -e "$TX/backup/${item##*/}" ]; then
                cp -a --remove-destination "$TX/backup/${item##*/}" "$item"
            else
                rm -f "$item"
            fi
        done
        systemctl daemon-reload || true
        if [ "$ACTIVE" -eq 1 ]; then systemctl restart hcpy.service || true; fi
    fi
    if [ "$COMMITTED" -eq 0 ] && [ -n "$RELEASE" ]; then rm -rf "$RELEASE"; fi
    rm -rf "$TX"
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export UV_PYTHON_INSTALL_DIR="$BASE/python" UV_CACHE_DIR="$BASE/cache" UV_NO_PROGRESS=1 UV_PYTHON_PREFERENCE=only-managed
UV=$BASE/bin/uv

say "1/5 uv $UV_VERSION"
if ! "$UV" --version 2>/dev/null | grep -q " $UV_VERSION"; then
    fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TARGET.tar.gz" "$TX/uv.tar.gz"
    printf '%s  %s\n' "$UV_SHA256" "$TX/uv.tar.gz" | sha256sum -c -
    tar xzf "$TX/uv.tar.gz" --strip-components=1 -C "$BASE/bin"
fi
"$UV" --version

say "2/5 Python 3.13"
"$UV" python install 3.13 --no-bin
RELEASE=$(mktemp -d "$BASE/releases/release.XXXXXXXX")
"$UV" venv --python 3.13 "$RELEASE/venv"
PYTHON=$RELEASE/venv/bin/python
"$PYTHON" -c "import ssl, sys; ok = ssl.HAS_PSK; print(sys.version.split()[0], ssl.OPENSSL_VERSION, '| TLS-PSK:', 'да' if ok else 'НЕТ'); sys.exit(0 if ok else 1)"
NAME=$("$PYTHON" - "$PROFILE" "$DEVICE" "$TX/devices.json" <<'PY'
import base64, json, re, sys

try:
    with open(sys.argv[1], encoding="utf-8-sig") as fh:
        devices = json.load(fh)
except ValueError:
    sys.exit("devices.json не читается как JSON")
if not isinstance(devices, list) or not devices or any(not isinstance(d, dict) for d in devices):
    sys.exit("devices.json должен быть списком с хотя бы одним профилем прибора")
if sys.argv[2]:
    devices = [d for d in devices if d.get("name") == sys.argv[2]]
if len(devices) != 1:
    sys.exit("Укажите уникальное имя посудомойки из devices.json через --device")
device = devices[0]
name = device.get("name")
if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
    sys.exit("В devices.json имя посудомойки должно состоять из латинских букв, цифр, точки, дефиса или подчёркивания")
if any(not isinstance(device.get(k), str) or not device[k] for k in ("host", "key")):
    sys.exit("в devices.json нет key или host у приборов: " + name)
if not isinstance(device.get("features"), dict) or any(not isinstance(f, dict) for f in device["features"].values()):
    sys.exit("В профиле посудомойки отсутствует описание features")
if device.get("iv"):
    sys.exit("Этот профиль использует AES (порт 80). Комплект для WB7 поддерживает профили TLS-PSK (порт 443)")
key = device["key"]
try:
    if not re.fullmatch(r"[A-Za-z0-9_+/-]+={0,2}", key):
        raise ValueError()
    base64.b64decode(key + "=" * (-len(key) % 4), altchars=b"-_", validate=True)
except ValueError:
    sys.exit("В профиле посудомойки некорректный ключ TLS-PSK")
with open(sys.argv[3], "w", encoding="utf-8") as fh:
    json.dump(devices, fh, ensure_ascii=False)
print("devices.json: %s (%s)" % (name, device["host"]), file=sys.stderr)
print(name)
PY
)

say "3/5 hcpy ($(head -1 "$SRC/app/VERSION" 2>/dev/null))"
cp -r "$SRC/app" "$RELEASE/app"
say "4/5 зависимости"
"$UV" pip install --python "$PYTHON" --require-hashes \
    --build-constraints "$SRC/build-constraints-wb7.txt" -r "$SRC/requirements-wb7.txt"
"$UV" cache clean >/dev/null 2>&1 || true
(cd "$RELEASE/app" && "$PYTHON" -c "import hc2mqtt")
echo "hcpy загружается без ошибок"
chmod -R go+rX "$RELEASE/app" "$RELEASE/venv"
if [ -d "$BASE/python" ]; then chmod -R go+rX "$BASE/python"; fi
if [ -f "$INI" ]; then install -m 600 "$INI" "$TX/hcpy.ini"; fi
write_ini "$PYTHON" "$TX/hcpy.ini"

command -v mosquitto_sub >/dev/null || { echo "Нужен mosquitto_sub из пакета mosquitto-clients"; exit 1; }
ARGS=()
if [ -f "$TX/hcpy.ini" ]; then
    ARGS=(--config "$TX/hcpy.ini")
    "$PYTHON" - "$TX/hcpy.ini" "$TX/mosquitto_sub" <<'PY'
from configobj import ConfigObj
import sys

cfg = ConfigObj(sys.argv[1])
with open(sys.argv[2], "w", encoding="utf-8") as fh:
    for flag, key in (("-u", "mqtt_username"), ("-P", "mqtt_password")):
        value = cfg.get(key)
        if value:
            if "\n" in value or "\r" in value or len(value.encode("utf-8")) > 1000:
                sys.exit("Логин или пароль не подходят для диагностики MQTT")
            fh.write(f"{flag} {value}\n")
PY
fi
unset MQTT_USER MQTT_PASS
TOPIC="${PREFIX}${NAME}/LWT"

# Подписка на признак готовности машины. Сохранённые брокером значения не выводятся (-R).
watch_lwt() {
    XDG_CONFIG_HOME="$TX" mosquitto_sub -h "$MQTT_HOST" -R -W "$1" -t "$TOPIC" -v > "$TX/mqtt.log" 2>&1 &
    SUB=$!
    sleep 1
}
stop_watch() {
    kill "$SUB" 2>/dev/null || true
    wait "$SUB" 2>/dev/null || true
    SUB=
}
lwt_online() { grep -Fxq "$TOPIC online" "$TX/mqtt.log"; }
# После перезапуска службы «online» считается только после «offline» нового процесса:
# прежний мог опубликовать своё «online» перед самой остановкой.
lwt_online_after_restart() {
    awk -v t="$TOPIC" '$0 == t " offline" { off = 1 } $0 == t " online" && off { ok = 1 } END { exit !ok }' "$TX/mqtt.log"
}
# Ждать готовности до 30 с. $1 — проверка готовности, остальное — команда «hcpy ещё работает».
wait_online() {
    local ready=$1 attempt
    shift
    for ((attempt=0; attempt<30; attempt++)); do
        if "$ready"; then return 0; fi
        if ! "$@" 2>/dev/null; then break; fi
        if ! kill -0 "$SUB" 2>/dev/null; then break; fi
        sleep 1
    done
    "$ready"   # подписчик мог записать ответ и завершиться
}

if systemctl is-active --quiet hcpy.service 2>/dev/null; then
    ACTIVE=1
    echo "Служба hcpy уже работает. Новый экземпляр во время обновления не запускается:"
    echo "связь с посудомойкой проверяется после перезапуска службы."
else
    say "5/5 пробное подключение к $NAME (до 30 с). Посудомойка должна быть включена."
    watch_lwt 32
    (cd "$RELEASE/app" && exec timeout 30 "$PYTHON" -u hc2mqtt.py -d "$TX/devices.json" \
        -h "$MQTT_HOST" -p "$PREFIX" "${ARGS[@]}") > "$TX/hcpy.log" 2>&1 &
    PROBE=$!
    FRESH=0
    if wait_online lwt_online kill -0 "$PROBE"; then FRESH=1; fi
    stop_watch
    kill "$PROBE" 2>/dev/null || true
    wait "$PROBE" 2>/dev/null || true
    if [ "$FRESH" -eq 1 ]; then
        echo "ПОЛУЧИЛОСЬ: $NAME передала актуальные данные и готова к работе."
    else
        echo "Данных от посудомойки нет. Последние строки журнала hcpy и MQTT:"
        tail -n 25 "$TX/hcpy.log" "$TX/mqtt.log"
        exit 1
    fi
fi

mkdir "$TX/backup"
for item in "$BASE/config/devices.json" "$INI" "$HARDEN_FILE" "$MQTT_HOST_FILE" "$UNIT"; do
    if [ -e "$item" ]; then cp -a "$item" "$TX/backup/"; fi
done
if [ -L "$RUN_DIR" ]; then PREVIOUS=$(readlink "$RUN_DIR"); fi
chmod 755 "$RELEASE"
ln -s "$RELEASE" "$TX/current"
ACTIVATING=1
mv -fT "$TX/devices.json" "$BASE/config/devices.json"
if [ -f "$TX/hcpy.ini" ]; then mv -fT "$TX/hcpy.ini" "$INI"; fi
mv -fT "$TX/current" "$RUN_DIR"
printf '%s\n' "$HARDEN" > "$HARDEN_FILE"
printf '%s\n' "$MQTT_HOST" > "$MQTT_HOST_FILE"
if [ "$ACTIVE" -eq 1 ] || [ -f "$UNIT" ]; then
    setup_user
    write_unit "$UNIT"
    systemctl daemon-reload
    if [ "$ACTIVE" -eq 1 ]; then
        say "Перезапуск службы hcpy и проверка связи с $NAME (до 30 с). Посудомойка должна быть в сети."
        watch_lwt 40
        systemctl restart hcpy.service
        FRESH=0
        if wait_online lwt_online_after_restart systemctl is-active --quiet hcpy.service; then FRESH=1; fi
        stop_watch
        if [ "$FRESH" -eq 1 ]; then
            echo "ПОЛУЧИЛОСЬ: служба hcpy перезапущена, $NAME передала актуальные данные."
        else
            echo "После перезапуска служба hcpy не получила данные от посудомойки. Последние строки журналов:"
            journalctl -u hcpy.service -n 25 --no-pager 2>/dev/null || true
            tail -n 25 "$TX/mqtt.log" || true
            exit 1
        fi
    fi
fi
install -m 755 "$SRC/install_hcpy.sh" "$TX/install_hcpy.sh"
mv -fT "$TX/install_hcpy.sh" "$BASE/install_hcpy.sh"
COMMITTED=1
if [[ "$PREVIOUS" == "$BASE"/releases/release.* && "${PREVIOUS#"$BASE/releases/"}" != */* ]]; then
    rm -rf "$PREVIOUS"
fi
echo "Дальше: bash $BASE/install_hcpy.sh --service   (включит автозапуск)"
