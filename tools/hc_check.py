#!/usr/bin/env python3
"""Проверка ключа посудомойки Home Connect по локальной сети (без облака).

Нужен Python 3.13 или новее, сторонние пакеты не нужны.
Запуск (в папке, где лежат этот файл и devices.json):
    py hc_check.py 192.168.1.50

Скрипт открывает TLS-PSK соединение с прибором на порт 443, делает
WebSocket-рукопожатие и печатает первое сообщение от посудомойки.
Ничего не отправляет прибору и ничего в нём не меняет.
"""
import base64
import json
import os
import socket
import ssl
import struct
import sys


def b64url(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("прибор закрыл соединение")
        buf += chunk
    return buf


def read_frame(sock):
    """Read one complete WebSocket message (handles fragmentation)."""
    payload = b""
    while True:
        b1, b2 = recv_exact(sock, 2)
        fin, opcode = b1 & 0x80, b1 & 0x0F
        length = b2 & 0x7F
        if length == 126:
            length = struct.unpack(">H", recv_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack(">Q", recv_exact(sock, 8))[0]
        mask = recv_exact(sock, 4) if b2 & 0x80 else None
        data = recv_exact(sock, length)
        if mask:
            data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
        if opcode == 0x8:
            raise ConnectionError(f"прибор закрыл WebSocket: {data!r}")
        if opcode in (0x9, 0xA):  # ping/pong - ignore
            continue
        payload += data
        if fin:
            return payload


def is_dishwasher(dev):
    return any(str(f.get("name", "")).startswith("Dishcare.Dishwasher.")
               for f in dev.get("features", {}).values())


def pick_device(devices, host):
    """Прибор с этим IP; если host в devices.json другой (например, имя) — единственная посудомойка."""
    for d in devices:
        if d.get("host") == host:
            return d
    if len(devices) == 1:
        return devices[0]
    dish = [d for d in devices if is_dishwasher(d)]
    if len(dish) == 1:
        return dish[0]
    sys.exit(f"В devices.json нет прибора с host={host!r}. Приборы: "
             + ", ".join(f"{d.get('name')} ({d.get('host')})" for d in devices))


def main():
    if len(sys.argv) < 2:
        sys.exit("Использование: py hc_check.py <IP посудомойки> [devices.json]")
    host = sys.argv[1]
    devfile = sys.argv[2] if len(sys.argv) > 2 else "devices.json"

    if sys.version_info < (3, 13) or not getattr(ssl, "HAS_PSK", False):
        sys.exit(f"Нужен Python 3.13+ с поддержкой TLS-PSK. Сейчас: {sys.version.split()[0]}, "
                 f"HAS_PSK={getattr(ssl, 'HAS_PSK', None)}")

    with open(devfile, encoding="utf-8-sig") as f:   # -sig: файл мог сохраниться с BOM
        data = json.load(f)
    dev = pick_device(data if isinstance(data, list) else [data], host)
    print(f"Прибор из devices.json: {dev.get('name')} (host {dev.get('host')})", flush=True)
    if "iv" in dev:
        sys.exit("Этот прибор работает по AES (порт 80), скрипт проверяет только TLS-приборы.")
    psk = b64url(dev["key"])

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.maximum_version = ssl.TLSVersion.TLSv1_2
    ctx.set_ciphers("PSK")
    ctx.set_psk_client_callback(lambda hint: ("HCCOM_Local_App", psk))

    print(f"1. TCP {host}:443 ...", flush=True)
    try:
        raw = socket.create_connection((host, 443), timeout=10)
    except OSError as e:
        sys.exit(f"   НЕ УДАЛОСЬ: {e}\n   Проверьте IP, что посудомойка включена и компьютер в той же сети.")

    print("2. TLS-PSK рукопожатие ...", flush=True)
    try:
        s = ctx.wrap_socket(raw, server_hostname=host)
    except ssl.SSLError as e:
        sys.exit(f"   НЕ УДАЛОСЬ: {e}\n   Скорее всего, ключ не подходит (прибор сбрасывали или переподключали).")
    except OSError as e:     # таймаут или разрыв во время рукопожатия
        sys.exit(f"   НЕ УДАЛОСЬ: {e or 'нет ответа'}\n   Прибор не завершил рукопожатие — проверьте IP и что это Home Connect.")
    print(f"   OK, шифр {s.cipher()[0]}", flush=True)

    try:
        websocket_hello(s, host)
    except OSError as e:   # таймаут и разрыв соединения — тоже OSError
        sys.exit(f"   НЕ УДАЛОСЬ: {e or 'нет ответа'}\n   Ключ подошёл, но прибор не ответил по WebSocket. "
                 "Попробуйте ещё раз; если повторяется — перезапустите посудомойку.")
    finally:
        s.close()
    print("\nКЛЮЧ РАБОТАЕТ: посудомойка отвечает по локальной сети.")


def websocket_hello(s, host):
    print("3. WebSocket /homeconnect ...", flush=True)
    wskey = base64.b64encode(os.urandom(16)).decode()
    s.sendall((f"GET /homeconnect HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {wskey}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
    head = b""
    while b"\r\n\r\n" not in head:
        head += recv_exact(s, 1)
    status = head.split(b"\r\n", 1)[0].decode(errors="replace")
    if " 101 " not in status + " ":
        sys.exit(f"   Неожиданный ответ: {status}")
    print("   OK", flush=True)

    print("4. Первое сообщение от посудомойки:", flush=True)
    msg = read_frame(s).decode("utf-8", errors="replace")
    try:
        print(json.dumps(json.loads(msg), ensure_ascii=False, indent=2))
    except ValueError:
        print(msg)


if __name__ == "__main__":
    main()
