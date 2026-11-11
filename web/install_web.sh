#!/bin/bash
# Веб-страница посудомойки для Wiren Board: http://<адрес контроллера>/dishwasher/
# Страница — обычные файлы; с правилом dishwasher.js она говорит через MQTT контроллера
# (тот же /mqtt, которым пользуется штатный веб-интерфейс). Ничего постороннего не ставится.
#
#   bash install_web.sh            установить или обновить
#   bash install_web.sh --remove   убрать страницу и её настройку nginx
#
# Запускать на контроллере от root, из папки web репозитория.
# Свой config.js (id устройства, адрес MQTT) при обновлении сохраняется.
set -euo pipefail

SRC=$(cd "$(dirname "$0")" && pwd)
NAME=dishwasher
WWW=${WWW:-/var/www/static/$NAME}
CONF_DIR=${CONF_DIR:-/etc/nginx/includes/default.wb.d}
CONF=$CONF_DIR/$NAME.conf
NGINX=${NGINX:-nginx}
RELOAD=${RELOAD:-systemctl reload nginx}

say() { printf '\n== %s\n' "$*"; }
die() { echo "Ошибка: $*" >&2; exit 1; }

# nginx проверяет всю настройку целиком; при ошибке возвращаем то, что было, и ничего не перезапускаем
apply_nginx() {
    local backup=$1
    if $NGINX -t >/dev/null 2>&1; then
        $RELOAD
        return 0
    fi
    $NGINX -t || true
    if [ -n "$backup" ] && [ -f "$backup" ]; then mv -f "$backup" "$CONF"; else rm -f "$CONF"; fi
    die "nginx не принял настройку, прежнее состояние возвращено"
}

remove() {
    say "Удаление страницы"
    rm -f "$CONF"
    rm -rf "$WWW"
    if $NGINX -t >/dev/null 2>&1; then $RELOAD; fi
    echo "Удалено: $WWW, $CONF"
}

install() {
    [ -f "$SRC/app/index.html" ] || die "рядом со скриптом нет папки app — запускайте из папки web репозитория"
    [ -d "$CONF_DIR" ] || die "нет $CONF_DIR — это не Wiren Board или слишком старая прошивка"
    command -v "${NGINX%% *}" >/dev/null 2>&1 || die "nginx не найден"

    say "Файлы страницы -> $WWW"
    local tmp keep=""
    mkdir -p "${WWW%/*}"
    tmp=$(mktemp -d "${WWW%/*}/.$NAME.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    cp -R "$SRC/app/." "$tmp/"
    if [ -f "$WWW/config.js" ]; then
        cp -p "$WWW/config.js" "$tmp/config.js"
        keep=1
    fi
    chmod -R a+rX "$tmp"
    # замена одним переименованием: страница не остаётся наполовину обновлённой
    if [ -d "$WWW" ]; then
        rm -rf "$WWW.old"
        mv "$WWW" "$WWW.old"
    fi
    mv "$tmp" "$WWW"
    rm -rf "$WWW.old"
    trap - EXIT
    [ -z "$keep" ] || echo "config.js оставлен прежний"

    say "Настройка nginx -> $CONF"
    local backup=""
    if [ -f "$CONF" ]; then
        backup=$(mktemp)
        cp -p "$CONF" "$backup"
    fi
    sed "s#/var/www/static/dishwasher/#$WWW/#" "$SRC/nginx/dishwasher.conf" > "$CONF"
    apply_nginx "$backup"
    rm -f "$backup"

    local ip
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    say "Готово"
    echo "Страница: http://${ip:-<адрес контроллера>}/$NAME/"
    echo "Если на веб-интерфейс контроллера стоит пароль — сначала войдите в него в том же браузере."
}

case ${1:-} in
    '') install ;;
    --remove) remove ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) die "неизвестный параметр: $1 (см. --help)" ;;
esac
