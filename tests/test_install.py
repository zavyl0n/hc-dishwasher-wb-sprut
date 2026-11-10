"""Установщик hcpy_wb7/install_hcpy.sh без Wiren Board.

    python3 -m unittest discover -s tests

Внешние команды (uv, curl, systemctl, journalctl, useradd, userdel, id, chown, sleep, mosquitto_sub)
подменены заглушками: каждая записывает свой вызов в журнал. Настоящие — bash, Python и
зависимости hcpy: venv создаётся тем Python, который запускает тесты (нужен 3.13+ с TLS-PSK
и пакеты из hcpy_wb7/requirements-wb7.txt), иначе тесты пропускаются.
"""
import configparser
import hashlib
import io
import json
import os
import shutil
import site
import ssl
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REAL_ID = shutil.which("id") or "/usr/bin/id"


def why_skip():
    if os.name != "posix" or shutil.which("bash") is None:
        return "нужен bash"
    if sys.version_info < (3, 13) or not getattr(ssl, "HAS_PSK", False):
        return "нужен Python 3.13+ с TLS-PSK"
    try:
        import click, click_config_file, configobj, paho.mqtt.client, websocket  # noqa: F401
    except ImportError:
        return "нет зависимостей hcpy (pip install --require-hashes -r hcpy_wb7/requirements-wb7.txt)"
    return None


SKIP = why_skip()

STUBS = {
    "systemctl": 'echo "systemctl $*" >> "$STUB_LOG"\n'
                 'if [ "$1" = "is-active" ]; then\n'
                 'if [ -f "$STUB_DIR/restarted" ]; then exit "${STUB_ACTIVE_AFTER_RESTART:-${STUB_ACTIVE_EXIT:-3}}"; fi\n'
                 'exit "${STUB_ACTIVE_EXIT:-3}"; fi\n'
                 'if [ "$1" = "restart" ]; then touch "$STUB_DIR/restarted"; fi\n'
                 'if [ "$1" = "restart" ] && [ "${STUB_RESTART_FAIL:-0}" = 1 ] '
                 '&& [ ! -f "$STUB_DIR/restart-failed" ]; then\n'
                 'touch "$STUB_DIR/restart-failed"; exit 1; fi\nexit 0',
    "useradd": 'echo "useradd $*" >> "$STUB_LOG"\nfor u; do :; done\ntouch "$STUB_DIR/user-$u"',
    "userdel": 'echo "userdel $*" >> "$STUB_LOG"\nrm -f "$STUB_DIR/user-$1"',
    "id": 'if [ "$1" = "-u" ]; then [ -f "$STUB_DIR/user-$2" ] && { echo 999; exit 0; }; exit 1; fi\n'
          'exec "%s" "$@"' % REAL_ID,
    "chown": 'echo "chown $*" >> "$STUB_LOG"',
    "journalctl": 'echo "journalctl $*" >> "$STUB_LOG"\necho "запись журнала hcpy"',
    "sleep": "exit 0",
    "timeout": 'exec /bin/sleep 35',
    "mosquitto_sub": 'echo "mosquitto_sub $*" >> "$STUB_LOG"\n'
                     'if [ -f "$XDG_CONFIG_HOME/mosquitto_sub" ]; then\n'
                     'stat -c %a "$XDG_CONFIG_HOME/mosquitto_sub" >> "$STUB_LOG"; fi\n'
                     'topic=""\nwhile [ "$#" -gt 0 ]; do\n'
                     'if [ "$1" = -t ]; then topic=$2; shift; fi; shift; done\n'
                     'case "${STUB_MQTT:-fresh}" in\n'
                     'fresh) printf "%s offline\\n%s online\\n" "$topic" "$topic";;\n'
                     'offline) printf "%s offline\\n" "$topic";;\n'
                     'stale) printf "%s online\\n%s offline\\n" "$topic" "$topic";;\n'
                     'wrong) printf "homeconnect/washer/LWT online\\n";;\n'
                     '*) exit 1;;\nesac',
    "curl": 'echo "curl $*" >> "$STUB_LOG"\nout=""\n'
            'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done\n'
            'cp "$FAKE_UV_TGZ" "$out"',
}

FAKE_UV = """#!/bin/sh
echo "uv $*" >> "$STUB_LOG"
case "$1" in
  --version) echo "uv 0.11.32 (заглушка)";;
  venv) for last; do :; done; "$TEST_PYTHON" -m venv "$last";;
  pip) [ "${STUB_PIP_FAIL:-0}" = 0 ] || exit 1;;
esac
exit 0
"""

DEVICES = [{"name": "dishwasher", "host": "192.0.2.10", "key": "dGVzdC1ub3QtYS1yZWFsLWtleQ",
            "description": {"model": "SMV4HVX31E"}, "features": {}}]


@unittest.skipIf(SKIP, SKIP)
class Installer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hcpy-install-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = self.tmp / "kit" / "hcpy_wb7"
        shutil.copytree(ROOT / "hcpy_wb7", self.src)
        self.profile = self.src / "devices.json"
        self.base = self.tmp / "base"
        self.unit = self.tmp / "hcpy.service"
        stubs = self.tmp / "stubs"
        stubs.mkdir()
        for name, body in STUBS.items():
            p = stubs / name
            p.write_text("#!/bin/sh\n" + body + "\n", encoding="utf-8")
            p.chmod(0o755)
        # «релиз uv» — архив с заглушкой, как настоящий: uv-<target>/uv
        tgz = self.tmp / "uv.tar.gz"
        with tarfile.open(tgz, "w:gz") as tf:
            data = FAKE_UV.encode()
            info = tarfile.TarInfo("uv-armv7-unknown-linux-gnueabihf/uv")
            info.size, info.mode = len(data), 0o755
            tf.addfile(info, io.BytesIO(data))
        self.log = self.tmp / "calls.log"
        self.env = dict(os.environ,
                        PATH="%s%s%s" % (stubs, os.pathsep, os.environ.get("PATH", "")),
                        BASE=str(self.base), UNIT=str(self.unit),
                        STUB_LOG=str(self.log), STUB_DIR=str(stubs), FAKE_UV_TGZ=str(tgz),
                        UV_SHA256=hashlib.sha256(tgz.read_bytes()).hexdigest(),
                        TEST_PYTHON=sys.executable,
                        PYTHONPATH=os.pathsep.join(site.getsitepackages()),
                        MQTT_HOST="127.0.0.1")
        for k in ("MQTT_USER", "MQTT_PASS", "HARDEN", "HCPY_USER"):
            self.env.pop(k, None)

    def put_devices(self, data=DEVICES, raw=None, bom=False):
        body = raw if raw is not None else json.dumps(data).encode()
        self.profile.write_bytes((b"\xef\xbb\xbf" if bom else b"") + body)

    def run_sh(self, *args, script=None, **env):
        e = dict(self.env, **env)
        r = subprocess.run(["bash", str(script or self.src / "install_hcpy.sh")] + list(args),
                           env=e, capture_output=True, text=True, timeout=180)
        return r

    def calls(self):
        return self.log.read_text(encoding="utf-8") if self.log.exists() else ""

    def mode(self, p):
        return stat.S_IMODE(p.stat().st_mode)

    def install(self, **env):
        self.put_devices(bom=True)
        r = self.run_sh("--devices", str(self.profile), **env)
        self.assertEqual(r.returncode, 0, r.stdout[-2000:] + r.stderr[-2000:])
        return r

    # ------------------------------------------------------------------
    def test_full_cycle_with_mqtt_login(self):
        password = 'p"a#ss $x 1'
        r = self.install(MQTT_USER="wb user", MQTT_PASS=password)
        out = r.stdout + r.stderr
        # Исходный файл не удалён, BOM в установленной копии убран.
        dj = self.base / "config" / "devices.json"
        self.assertTrue(self.profile.exists())
        self.assertEqual(self.mode(dj), 0o600)
        self.assertFalse(dj.read_bytes().startswith(b"\xef\xbb\xbf"))
        self.assertEqual(json.loads(dj.read_text(encoding="utf-8"))[0]["host"], "192.0.2.10")
        self.assertIn("devices.json: dishwasher (192.0.2.10)", out)
        self.assertIn("hcpy загружается без ошибок", out)
        self.assertIn("передала актуальные данные", out)
        self.assertTrue((self.base / "current" / "app" / "hc2mqtt.py").exists())
        self.assertTrue((self.base / "install_hcpy.sh").exists())
        calls = self.calls()
        self.assertIn("/0.11.32/uv-armv7-unknown-linux-gnueabihf.tar.gz", calls)
        self.assertIn("uv python install 3.13 --no-bin", calls)
        self.assertIn("--require-hashes --build-constraints %s/build-constraints-wb7.txt -r %s/requirements-wb7.txt\n"
                      % (self.src, self.src), calls)
        self.assertIn("uv cache clean", calls)
        self.assertIn("mosquitto_sub -h 127.0.0.1 -R -W 32 -t homeconnect/dishwasher/LWT -v\n600\n", calls)
        self.assertNotIn(password, calls)
        # логин MQTT: файл 600, hcpy (configobj) читает ровно то, что задали
        import configobj
        ini = self.base / "config" / "hcpy.ini"
        self.assertEqual(self.mode(ini), 0o600)
        cfg = configobj.ConfigObj(str(ini))
        self.assertEqual((cfg["mqtt_username"], cfg["mqtt_password"]), ("wb user", password))

        # автозапуск: пользователь hcpy, ограничения, --config с логином
        r = self.run_sh("--service", script=self.base / "install_hcpy.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = self.calls()
        self.assertIn("useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin hcpy", calls)
        self.assertIn("chown -R hcpy:hcpy %s/config" % self.base, calls)
        self.assertIn("systemctl daemon-reload", calls)
        self.assertIn("systemctl enable --now hcpy.service", calls)
        unit = configparser.ConfigParser(interpolation=None, strict=True)
        unit.optionxform = str
        unit.read_string(self.unit.read_text(encoding="utf-8"))
        svc = unit["Service"]
        self.assertEqual(svc["User"], "hcpy")
        self.assertEqual(svc["ProtectSystem"], "strict")
        self.assertEqual(svc["NoNewPrivileges"], "yes")
        self.assertEqual(svc["WorkingDirectory"], "%s/current/app" % self.base)
        self.assertEqual(svc["ExecStart"],
                         '"{b}/current/venv/bin/python" -u hc2mqtt.py -d "{b}/config/devices.json" '
                         '-h "127.0.0.1" -p "homeconnect/" --config "{b}/config/hcpy.ini"'.format(b=self.base))
        self.assertEqual(unit["Install"]["WantedBy"], "multi-user.target")

        # удаление: служба, файлы и созданный пользователь
        r = self.run_sh("--remove", script=self.base / "install_hcpy.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(self.base.exists())
        self.assertFalse(self.unit.exists())
        self.assertIn("systemctl disable --now hcpy.service", self.calls())
        self.assertIn("userdel hcpy", self.calls())

    def test_mqtt_password_that_configobj_cannot_read_is_refused(self):
        self.put_devices()
        r = self.run_sh("--devices", str(self.profile), MQTT_USER="u", MQTT_PASS="a%(b)s")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("не должны содержать «%(»", r.stdout + r.stderr)
        self.assertFalse((self.base / "config" / "hcpy.ini").exists())

    def test_harden_off_keeps_old_unit(self):
        self.install()
        self.assertFalse((self.base / "config" / "hcpy.ini").exists())
        r = self.run_sh("--service", script=self.base / "install_hcpy.sh", HARDEN="0")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        text = self.unit.read_text(encoding="utf-8")
        self.assertNotIn("User=", text)
        self.assertNotIn("ProtectSystem", text)
        self.assertNotIn("--config", text)
        self.assertNotIn("useradd", self.calls())

    def test_harden_choice_is_remembered_on_update(self):
        self.install()
        self.run_sh("--service", script=self.base / "install_hcpy.sh", HARDEN="0")
        r = self.run_sh(STUB_ACTIVE_EXIT="0")            # обновление без HARDEN
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertNotIn("User=", self.unit.read_text(encoding="utf-8"))
        self.run_sh("--service", script=self.base / "install_hcpy.sh", HARDEN="1")
        self.assertIn("User=hcpy", self.unit.read_text(encoding="utf-8"))

    def test_existing_user_is_not_recreated_or_removed(self):
        self.install()
        (Path(self.env["STUB_DIR"]) / "user-hcpy").touch()      # пользователь уже был
        self.run_sh("--service", script=self.base / "install_hcpy.sh")
        self.run_sh("--remove", script=self.base / "install_hcpy.sh")
        self.assertNotIn("useradd", self.calls())
        self.assertNotIn("userdel", self.calls())

    def test_update_while_service_runs(self):
        self.install()
        before = self.calls().count("uv venv")
        current = (self.base / "current").resolve()
        r = self.run_sh(STUB_ACTIVE_EXIT="0")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Служба hcpy уже работает", r.stdout)
        self.assertNotIn("5/5", r.stdout)
        self.assertIn("systemctl restart hcpy.service", self.calls())
        self.assertIn("ПОЛУЧИЛОСЬ: служба hcpy перезапущена", r.stdout)
        # подписка на готовность машины открыта до перезапуска службы
        tail = self.calls().split("systemctl daemon-reload\n")[-1]
        self.assertRegex(tail, r"(?s)^mosquitto_sub -h 127\.0\.0\.1 -R -W 40 -t homeconnect/dishwasher/LWT -v\n"
                               r".*systemctl restart hcpy\.service\n")
        self.assertIn("User=hcpy", self.unit.read_text(encoding="utf-8"), "юнит обновлён")
        self.assertEqual(self.calls().count("uv venv"), before + 1, "новый venv готовится отдельно")
        self.assertNotEqual((self.base / "current").resolve(), current)

    def test_bad_devices_json(self):
        for raw, msg in [(b"{not json", "не читается как JSON"),
                         (json.dumps(DEVICES[0]).encode(), "должен быть списком"),
                         (json.dumps([{"name": "x", "host": "1.2.3.4"}]).encode(), "нет key или host у приборов: x")]:
            with self.subTest(msg):
                self.put_devices(raw=raw)
                r = self.run_sh("--devices", str(self.profile))
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(msg, r.stdout + r.stderr)

    def test_probe_requires_fresh_ready_status_for_selected_device(self):
        self.put_devices()
        for reply in ("wrong", "offline"):
            with self.subTest(reply=reply):
                r = self.run_sh("--devices", str(self.profile), STUB_MQTT=reply)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("Данных от посудомойки нет", r.stdout)
                self.assertFalse((self.base / "current").exists())
                self.assertTrue(self.profile.exists())

    def test_update_requires_fresh_ready_status_after_restart(self):
        """Служба запустилась, но машина не ответила (или «online» осталось от прежнего процесса) — откат."""
        self.install(MQTT_USER="old-user", MQTT_PASS="old-password")
        r = self.run_sh("--service", script=self.base / "install_hcpy.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        current = (self.base / "current").resolve()
        paths = [self.base / "config" / "devices.json", self.base / "config" / "hcpy.ini", self.unit]
        previous_files = [p.read_bytes() for p in paths]
        self.put_devices([dict(DEVICES[0], host="192.0.2.11")])
        for n, reply in enumerate(("offline", "stale", "wrong", "no-broker"), 1):
            with self.subTest(reply=reply):
                r = self.run_sh("--devices", str(self.profile), STUB_ACTIVE_EXIT="0", STUB_MQTT=reply,
                                MQTT_USER="new-user", MQTT_PASS="new-password")
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("служба hcpy не получила данные от посудомойки", r.stdout)
                self.assertIn("запись журнала hcpy", r.stdout)
                self.assertIn("Откат установки hcpy", r.stdout)
                self.assertEqual((self.base / "current").resolve(), current)
                self.assertEqual([p.read_bytes() for p in paths], previous_files)
                self.assertTrue(self.profile.exists())
                # перезапуск с новой версией и ещё один — после отката
                self.assertEqual(self.calls().count("systemctl restart hcpy.service"), 2 * n)
                self.assertNotIn("new-password", self.calls() + r.stdout + r.stderr)

    def test_update_fails_when_service_stops_after_restart(self):
        self.install()
        current = (self.base / "current").resolve()
        r = self.run_sh(STUB_ACTIVE_EXIT="0", STUB_ACTIVE_AFTER_RESTART="3", STUB_MQTT="offline")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("служба hcpy не получила данные от посудомойки", r.stdout)
        self.assertEqual((self.base / "current").resolve(), current)

    def test_only_selected_device_is_installed_and_aes_is_rejected(self):
        self.put_devices(DEVICES + [dict(DEVICES[0], name="washer", iv="test")])
        r = self.run_sh("--devices", str(self.profile))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--device", r.stderr)
        r = self.run_sh("--devices", str(self.profile), "--device", "washer")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("AES", r.stderr)
        r = self.run_sh("--devices", str(self.profile), "--device", "dishwasher")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(json.loads((self.base / "config" / "devices.json").read_bytes()), DEVICES)

    def test_update_failure_keeps_previous_version_profile_and_unit(self):
        self.install(MQTT_USER="old-user", MQTT_PASS="old-password")
        r = self.run_sh("--service", script=self.base / "install_hcpy.sh")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        current = (self.base / "current").resolve()
        paths = [self.base / "config" / "devices.json", self.base / "config" / "hcpy.ini", self.unit]
        previous_files = [p.read_bytes() for p in paths]

        for failure in ("profile", "key", "dependencies", "restart"):
            with self.subTest(failure=failure):
                if failure == "profile":
                    self.put_devices(raw=b"{invalid")
                elif failure == "key":
                    self.put_devices([dict(DEVICES[0], key="!!!")])
                else:
                    self.put_devices([dict(DEVICES[0], host="192.0.2.11")])
                r = self.run_sh("--devices", str(self.profile), STUB_ACTIVE_EXIT="0",
                                STUB_PIP_FAIL=str(int(failure == "dependencies")),
                                STUB_RESTART_FAIL=str(int(failure == "restart")),
                                MQTT_USER="new-user", MQTT_PASS="new-password")
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual((self.base / "current").resolve(), current)
                self.assertEqual([p.read_bytes() for p in paths], previous_files)
                self.assertTrue(self.profile.exists())
        self.assertEqual(self.calls().count("systemctl restart hcpy.service"), 2)

    def test_no_devices_json(self):
        self.put_devices()
        r = self.run_sh()
        self.assertEqual(r.returncode, 1)
        self.assertIn("Нет devices.json", r.stdout)

    def test_uv_checksum_mismatch_stops(self):
        self.put_devices()
        r = self.run_sh("--devices", str(self.profile), UV_SHA256="0" * 64)
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.base / "bin" / "uv").exists())
        self.assertNotIn("uv python", self.calls())

    def test_service_needs_install_first(self):
        r = self.run_sh("--service")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Сначала запустите установку", r.stdout)

    def test_unknown_argument(self):
        r = self.run_sh("--bogus")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Неизвестный параметр", r.stdout)


if __name__ == "__main__":
    unittest.main()
