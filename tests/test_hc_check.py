"""Проверка ключа tools/hc_check.py: выбор прибора, разбор WebSocket и TLS-PSK с поддельной машиной.

    python3 -m unittest discover -s tests

Сквозной тест поднимает локальный TLS-PSK сервер, который отвечает как посудомойка
(рукопожатие WebSocket и первое сообщение /ei/initialValues). Нужен Python 3.13+ с TLS-PSK.
"""
import base64
import contextlib
import io
import json
import socket
import ssl
import struct
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"
if str(ROOT / "tools") not in sys.path:
    sys.path.insert(0, str(ROOT / "tools"))

import hc_check  # noqa: E402

HAS_PSK = sys.version_info >= (3, 13) and getattr(ssl, "HAS_PSK", False)


def devices():
    with open(FIXTURES / "other_model.json", encoding="utf-8") as fh:
        return json.load(fh)


def frame(payload, opcode=0x1, fin=True, mask=None):
    head = bytes([(0x80 if fin else 0) | opcode])
    n = len(payload)
    m = 0x80 if mask else 0
    if n < 126:
        head += bytes([m | n])
    elif n < 65536:
        head += bytes([m | 126]) + struct.pack(">H", n)
    else:
        head += bytes([m | 127]) + struct.pack(">Q", n)
    if mask:
        payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
        head += mask
    return head + payload


class FakeSock:
    def __init__(self, data, chunk=3):
        self.data, self.chunk = data, chunk

    def recv(self, n):
        out, self.data = self.data[:min(n, self.chunk)], self.data[min(n, self.chunk):]
        return out


class PickDevice(unittest.TestCase):
    def test_by_ip(self):
        devs = devices()
        self.assertEqual(hc_check.pick_device(devs, "192.0.2.20")["name"], "oven")
        smv = json.loads((FIXTURES / "smv4hvx31e.json").read_text(encoding="utf-8"))
        self.assertEqual(hc_check.pick_device(devs + smv, "192.0.2.10")["name"], "dishwasher")

    def test_host_is_a_name_falls_back_to_the_only_dishwasher(self):
        # в other_model.json host посудомойки — имя, а не IP
        self.assertEqual(hc_check.pick_device(devices(), "192.0.2.77")["name"], "Посудомойка")

    def test_single_device(self):
        self.assertEqual(hc_check.pick_device(devices()[:1], "x")["name"], "oven")

    def test_ambiguous(self):
        devs = devices()
        devs.append(dict(devs[1], name="second", host="192.0.2.30"))
        with self.assertRaises(SystemExit) as cm:
            hc_check.pick_device(devs, "192.0.2.99")
        self.assertIn("second (192.0.2.30)", str(cm.exception.code))


class Frames(unittest.TestCase):
    def test_b64url_padding(self):
        for raw in (b"a", b"ab", b"abc", b"abcd"):
            enc = base64.urlsafe_b64encode(raw).decode().rstrip("=")
            self.assertEqual(hc_check.b64url(enc), raw)

    def test_text_frame(self):
        self.assertEqual(hc_check.read_frame(FakeSock(frame(b'{"a":1}'))), b'{"a":1}')

    def test_fragmented_with_ping_in_between(self):
        data = frame(b"hel", fin=False) + frame(b"", opcode=0x9) + frame(b"lo", opcode=0x0)
        self.assertEqual(hc_check.read_frame(FakeSock(data)), b"hello")

    def test_masked_and_long(self):
        body = b"x" * 300
        self.assertEqual(hc_check.read_frame(FakeSock(frame(body, mask=b"\x01\x02\x03\x04"), chunk=64)), body)

    def test_close_and_eof(self):
        with self.assertRaises(ConnectionError):
            hc_check.read_frame(FakeSock(frame(b"\x03\xe8bye", opcode=0x8)))
        with self.assertRaises(ConnectionError):
            hc_check.read_frame(FakeSock(b"\x81"))


class FakeAppliance(threading.Thread):
    """TLS-PSK сервер, отвечающий как посудомойка Home Connect."""

    def __init__(self, psk, silent=False):
        super().__init__(daemon=True)
        self.psk, self.silent = psk, silent
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.error = None

    def run(self):
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        ctx.set_ciphers("PSK")
        ctx.set_psk_server_callback(lambda identity: self.psk if identity == "HCCOM_Local_App" else b"")
        conn, _ = self.sock.accept()
        try:
            with ctx.wrap_socket(conn, server_side=True) as s:
                if self.silent:              # рукопожатие прошло, а дальше прибор молчит
                    while s.recv(1024):
                        pass
                    return
                req = b""
                while b"\r\n\r\n" not in req:
                    req += s.recv(1024)
                assert req.startswith(b"GET /homeconnect HTTP/1.1"), req
                s.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
                msg = {"sID": 1, "msgID": 2, "resource": "/ei/initialValues", "version": 2, "action": "POST",
                       "data": [{"edMsgID": 100}]}
                s.sendall(frame(json.dumps(msg).encode()))
        except (ssl.SSLError, OSError) as exc:
            self.error = exc
        finally:
            self.sock.close()


@unittest.skipUnless(HAS_PSK, "нужен Python 3.13+ с TLS-PSK")
class EndToEnd(unittest.TestCase):
    KEY = "dGVzdC1kaXNoMi1rZXk"     # ключ «Посудомойки» из other_model.json

    def run_check(self, server_psk, silent=False, timeout=5, devfile=FIXTURES / "other_model.json"):
        server = FakeAppliance(server_psk, silent)
        server.start()
        real = socket.create_connection
        out = io.StringIO()
        t = timeout
        argv = ["hc_check.py", "127.0.0.1", str(devfile)]
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.object(hc_check.socket, "create_connection",
                                  lambda addr, timeout=None: real(("127.0.0.1", server.port), timeout=t)), \
                contextlib.redirect_stdout(out):
            try:
                hc_check.main()
                code = 0
            except SystemExit as exc:
                code = exc.code
        server.join(5)
        return code, out.getvalue()

    def test_right_key(self):
        code, out = self.run_check(hc_check.b64url(self.KEY))
        self.assertEqual(code, 0, out)
        self.assertIn("Прибор из devices.json: Посудомойка", out)
        self.assertIn('"resource": "/ei/initialValues"', out)
        self.assertIn("КЛЮЧ РАБОТАЕТ", out)

    def test_wrong_key(self):
        code, out = self.run_check(b"some-other-key")
        self.assertIn("ключ не подходит", str(code))

    def test_appliance_silent_after_handshake(self):
        code, out = self.run_check(hc_check.b64url(self.KEY), silent=True, timeout=1)
        self.assertIn("не ответил по WebSocket", str(code))
        self.assertNotIn("Traceback", out)

    def test_devices_json_with_bom(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            bom = Path(d) / "devices.json"
            bom.write_bytes(b"\xef\xbb\xbf" + (FIXTURES / "other_model.json").read_bytes())
            code, out = self.run_check(hc_check.b64url(self.KEY), devfile=bom)
        self.assertEqual(code, 0, out)


if __name__ == "__main__":
    unittest.main()
