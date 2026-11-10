"""Стык правила и hcpy: правило понимает то, что публикует hcpy, а hcpy принимает команды правила.

    python3 -m unittest discover -s tests

Используется hcpy из hcpy_wb7/app (тот, что ставится на WB) и фикстура tests/fixtures/smv4hvx31e.json.
Часть тестов запускает node (tests/dump_commands.js), часть — hc2mqtt (нужны зависимости из
hcpy_wb7/requirements-wb7.txt); без них эти тесты пропускаются.
"""
import contextlib
import copy
import hashlib
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "hcpy_wb7" / "app"
FIXTURE = ROOT / "tests" / "fixtures" / "smv4hvx31e.json"
for p in (str(APP), str(ROOT / "tools")):
    if p not in sys.path:
        sys.path.insert(0, p)

from HCDevice import HCDevice  # noqa: E402
import make_kit  # noqa: E402
import utils  # noqa: E402

try:
    import hc2mqtt  # noqa: E402
except ImportError:  # нет click / paho-mqtt / websocket-client
    hc2mqtt = None


def fixture():
    with open(FIXTURE, encoding="utf-8") as fh:
        return json.load(fh)[0]


def make_device():
    return HCDevice(None, copy.deepcopy(fixture()))


class ParseValues(unittest.TestCase):
    """Значения, которые hcpy кладёт в state/*: правило ждёт именно такие строки."""

    def setUp(self):
        self.dev = make_device()
        self.feats = {f["name"]: int(uid) for uid, f in fixture()["features"].items()}

    def parse(self, name, value):
        return self.dev.parse_values([{"uid": self.feats[name], "value": value}])[name]

    def test_enum_values_become_short_names(self):
        self.assertEqual(self.parse("BSH.Common.Status.OperationState", 3), "Run")
        self.assertEqual(self.parse("BSH.Common.Status.DoorState", 0), "Open")
        self.assertEqual(self.parse("BSH.Common.Setting.PowerState", 2), "On")
        self.assertEqual(self.parse("Dishcare.Dishwasher.Setting.SoundLevelSignal", 2), "Medium")

    def test_bool_published_as_python_bool(self):
        # hc2mqtt публикует str(True) == "True"; правило понимает "True"/"true"/"1"
        self.assertIs(self.parse("Dishcare.Dishwasher.Option.ExtraDry", 1), True)
        self.assertIs(self.parse("BSH.Common.Status.RemoteControlStartAllowed", 0), False)
        self.assertEqual(str(self.parse("Dishcare.Dishwasher.Option.ExtraDry", 1)), "True")

    def test_program_uid_becomes_program_key(self):
        # правило сравнивает с PROGRAMS[i].key: "Eco50", избранное — "001"
        self.assertEqual(self.parse("BSH.Common.Root.SelectedProgram", 8196), "Eco50")
        self.assertEqual(self.parse("BSH.Common.Root.ActiveProgram", 32828), "001")

    def test_topic_names_match_generator(self):
        # hc2mqtt: key.lower().replace(".", "_"); генератор делает так же
        for name in self.feats:
            self.assertEqual(make_kit.topic_key(name), name.lower().replace(".", "_"))

    def test_clean_name_matches_hcpy(self):
        for name in ["dishwasher", "Geschirrspüler", "Посудомойка", "Lave-vaisselle ", "SN65ZX49CE"]:
            self.assertEqual(make_kit.clean_name(name), utils.clean_international_text(name), name)


class ApplianceReadiness(unittest.TestCase):
    def test_ready_only_after_delivering_successful_mandatory_values(self):
        ws = Mock()
        device = HCDevice(ws, fixture())
        calls = []
        door = "BSH.Common.Status.DoorState"

        def exercise(on_message, on_open, on_close, on_error):
            on_open(ws)
            for reply in (
                {"resource": "/ro/values", "action": "NOTIFY", "data": [{"uid": 1527, "value": 0}]},
                {"resource": "/ro/allMandatoryValues", "action": "RESPONSE", "code": 404},
                {"resource": "/ro/allMandatoryValues", "action": "RESPONSE", "data": [{"uid": 1527, "value": 1}]},
                {"resource": "/ro/allMandatoryValues", "action": "RESPONSE", "data": [{"uid": 1527, "value": 1}]},
            ):
                on_message(ws, json.dumps(dict(reply, version=1)))
            on_close(ws, None, None)

        ws.run_forever.side_effect = exercise
        device.run_forever(
            on_message=lambda state: calls.append(state.get(door)),
            on_open=lambda ws: calls.append("socket open"),
            on_close=lambda ws, code, message: calls.append("socket closed"),
            on_ready=lambda: calls.append("ready"),
        )
        self.assertEqual(calls, ["socket open", "Open", None, "Closed", "ready", "Closed", "socket closed"])
        self.assertFalse(device.ready)
        self.assertFalse(device.connected)


@unittest.skipIf(shutil.which("node") is None, "нужен node")
class RuleCommandsAcceptedByHcpy(unittest.TestCase):
    """Каждая команда правила (из эмулятора wb-rules) проходит проверки hcpy без исключений."""

    @classmethod
    def setUpClass(cls):
        rule = ROOT / "examples" / "SMV4HVX31E" / "dishwasher.js"
        out = subprocess.run(["node", str(ROOT / "tests" / "dump_commands.js"), str(rule)],
                             check=True, capture_output=True, text=True).stdout
        cls.commands = json.loads(out)

    def test_dump_is_not_empty(self):
        topics = {c["topic"] for c in self.commands}
        self.assertEqual(topics, {"set", "selectedProgram", "activeProgram"})
        self.assertGreater(len(self.commands), 30)

    def test_every_command_is_valid_for_hcpy(self):
        dev = make_device()
        for c in self.commands:
            with self.subTest(c["what"], data=c["data"]):
                data = copy.deepcopy(c["data"])
                with contextlib.redirect_stdout(io.StringIO()):
                    if c["topic"] == "set":
                        res = dev.test_feature([data])[0]
                        self.assertIsInstance(res["uid"], int)
                    else:
                        res = dev.test_program_data([data])[0]
                        self.assertIsInstance(res["program"], int)

    def test_enum_values_sent_as_indexes(self):
        power = [c["data"]["value"] for c in self.commands if c["topic"] == "set" and c["data"]["uid"] == 539]
        self.assertEqual(set(power), {"On", "Off"})
        dev = make_device()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(dev.test_feature([{"uid": 539, "value": "On"}])[0]["value"], 2)

    def test_hcpy_rejects_out_of_range_values(self):
        # убеждаемся, что проверка выше чего-то стоит
        dev = make_device()
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(Exception):
                dev.test_feature([{"uid": 4382, "value": 5940}])      # больше max 1800
            with self.assertRaises(Exception):
                dev.test_feature([{"uid": 4364, "value": 9}])         # нет такого значения
            with self.assertRaises(Exception):
                dev.test_program_data([{"program": 5121}])            # это опция, не программа


class _Client:
    def __init__(self):
        self.connected = True
        self.published = []
        self.subscribed = []
        self.fail_topic = None

    def is_connected(self):
        return self.connected

    def publish(self, topic, payload, retain=False, qos=0):
        if not self.connected or self.fail_topic == topic:
            return SimpleNamespace(rc=hc2mqtt.mqtt.MQTT_ERR_NO_CONN)
        self.published.append((topic, payload, retain))
        return SimpleNamespace(rc=hc2mqtt.mqtt.MQTT_ERR_SUCCESS)

    def subscribe(self, topic):
        self.subscribed.append(topic)
        return hc2mqtt.mqtt.MQTT_ERR_SUCCESS, len(self.subscribed)


@unittest.skipIf(hc2mqtt is None, "нет зависимостей hcpy (pip install -r hcpy_wb7/requirements-wb7.txt)")
class Hc2mqttPublishing(unittest.TestCase):
    """Топики и формат, в которых hc2mqtt публикует состояние и события."""

    def setUp(self):
        self.client = _Client()
        self.bridge = hc2mqtt.MQTTBridge(self.client, "homeconnect/", [fixture()])
        self.channel = self.bridge.channels[0]
        self.device = make_device()
        self.device.connected = True
        self.device.get = Mock()
        self.channel.attach(self.device)
        self.bridge.on_connect(self.client, None, None, 0)

    def publish(self, msg):
        self.channel.mark_ready(self.device)
        self.client.published.clear()
        self.channel.receive(self.device, msg)
        return {t: p for t, p, _ in self.client.published}, self.client

    def command(self, payload, *, retain=False, topic="homeconnect/dishwasher/activeProgram"):
        message = SimpleNamespace(topic=topic, payload=payload, retain=retain)
        with contextlib.redirect_stderr(io.StringIO()):
            self.bridge.on_message(self.client, None, message)

    def test_state_topics_and_payloads(self):
        pub, client = self.publish({
            "BSH.Common.Status.OperationState": "Run",
            "Dishcare.Dishwasher.Option.ExtraDry": True,
            "BSH.Common.Option.RemainingProgramTime": 3600,
            "BSH.Common.Status.ErrorCodesList": {"list": ["E:24"]},
        })
        self.assertEqual(pub["homeconnect/dishwasher/state/bsh_common_status_operationstate"], "Run")
        self.assertEqual(pub["homeconnect/dishwasher/state/dishcare_dishwasher_option_extradry"], "True")
        self.assertEqual(pub["homeconnect/dishwasher/state/bsh_common_option_remainingprogramtime"], "3600")
        self.assertEqual(json.loads(pub["homeconnect/dishwasher/state/bsh_common_status_errorcodeslist"]),
                         {"list": ["E:24"]})
        self.assertTrue(all(r for _, _, r in client.published), "всё публикуется с retain")

    def test_events_published_as_json(self):
        pub, _ = self.publish({"BSH.Common.Event.AquaStopOccured": "Present"})
        self.assertEqual(json.loads(pub["homeconnect/dishwasher/event/bsh_common_event_aquastopoccured"]),
                         {"event_type": "Present"})

    def test_unchanged_values_not_republished(self):
        self.publish({"BSH.Common.Status.DoorState": "Closed"})
        self.channel.receive(self.device, {"BSH.Common.Status.DoorState": "Closed"})
        self.assertEqual(len(self.client.published), 1)

    def test_reconnect_restores_latest_state_lwt_and_alarm(self):
        door = "BSH.Common.Status.DoorState"
        alarm = "BSH.Common.Event.AquaStopOccured"
        self.publish({door: "Closed", alarm: "Off", "swVersion": "1.2"})
        self.client.connected = False
        self.bridge.on_disconnect(self.client, None, 1)
        self.client.published.clear()
        self.channel.receive(self.device, {door: "Open", alarm: "Present"})
        self.assertEqual(self.client.published, [])

        self.client.connected = True
        self.bridge.on_connect(self.client, None, None, 0)
        sent = self.client.published
        self.assertEqual(sent[0], ("homeconnect/LWT", "offline", True))
        self.assertEqual(sent[1], ("homeconnect/dishwasher/LWT", "offline", True))
        self.assertIn(("homeconnect/dishwasher/state/bsh_common_status_doorstate", "Open", True), sent)
        self.assertIn(("homeconnect/dishwasher/state/swversion", "1.2", True), sent)
        self.assertIn(("homeconnect/dishwasher/event/bsh_common_event_aquastopoccured",
                       '{"event_type": "Present"}', True), sent)
        self.assertEqual(sent[-2], ("homeconnect/dishwasher/LWT", "online", True))
        self.assertEqual(sent[-1], ("homeconnect/LWT", "online", True))

    def test_next_appliance_session_clears_stale_state_and_announces_ready_after_snapshot(self):
        door = "BSH.Common.Status.DoorState"
        power = "BSH.Common.Setting.PowerState"
        self.publish({door: "Closed"})
        self.client.published.clear()
        self.channel.detach(self.device)
        self.channel.mark_ready(self.device)
        replacement = make_device()
        self.channel.attach(replacement)
        self.channel.receive(replacement, {power: "On"})
        self.channel.mark_ready(replacement)
        sent = self.client.published
        self.assertEqual(sent[0], ("homeconnect/dishwasher/LWT", "offline", True))
        self.assertIn(("homeconnect/dishwasher/state/bsh_common_status_doorstate", "", True), sent)
        self.assertNotIn(("homeconnect/dishwasher/LWT", "online", True), sent)
        self.assertNotIn(("homeconnect/dishwasher/state/bsh_common_setting_powerstate", "On", True), sent)
        replacement.connected = True
        self.channel.mark_ready(replacement)
        self.assertEqual(sent[-2], ("homeconnect/dishwasher/state/bsh_common_setting_powerstate", "On", True))
        self.assertEqual(sent[-1], ("homeconnect/dishwasher/LWT", "online", True))

    def test_failed_publish_is_not_considered_synced(self):
        self.client.published.clear()
        topic = "homeconnect/dishwasher/state/bsh_common_status_doorstate"
        self.client.fail_topic = topic
        self.channel.receive(self.device, {"BSH.Common.Status.DoorState": "Open"})
        self.channel.mark_ready(self.device)
        self.assertEqual(self.client.published, [])
        self.command(b'{"program":8196}')
        self.device.get.assert_not_called()
        self.client.fail_topic = None
        self.channel.receive(self.device, {"BSH.Common.Status.DoorState": "Open"})
        self.assertEqual(self.client.published, [
            (topic, "Open", True), ("homeconnect/dishwasher/LWT", "online", True),
        ])

    def test_initializing_and_retained_commands_are_ignored(self):
        valid = b'{"program":8196}'
        self.command(valid)
        self.channel.mark_ready(self.device)
        self.bridge.on_connect(self.client, None, None, 0)
        self.assertIn("homeconnect/dishwasher/activeProgram", self.client.subscribed)
        self.command(valid, retain=True)
        self.command(valid, topic="other/dishwasher/activeProgram")
        self.device.get.assert_not_called()
        self.command(valid)
        self.device.get.assert_called_once_with("/ro/activeProgram", 1, "POST", {"program": 8196})

    def test_malformed_commands_do_not_stop_bridge(self):
        self.channel.mark_ready(self.device)
        for invalid in (
            b"\xff", b"{", b"null", b"[]", b"[5]", b"{}", b'{"program":NaN}',
            b'{"program":8196,"options":[{"uid":558}]}',
            b'{"program":8196,"options":[{"uid":558,"value":1e999}]}',
            b" " * (hc2mqtt.MAX_COMMAND_BYTES + 1),
        ):
            self.command(invalid)
        invalid_topic = hc2mqtt.mqtt.MQTTMessage(topic=b"\xff")
        with contextlib.redirect_stderr(io.StringIO()):
            self.bridge.on_message(self.client, None, invalid_topic)
        self.device.get.assert_not_called()
        self.command(b'[{"uid":539,"value":"On"}]', topic="homeconnect/dishwasher/set")
        self.device.get.assert_called_once_with("/ro/values", 1, "POST", [{"uid": 539, "value": "On"}])


class Packaging(unittest.TestCase):
    """Что именно ставится на контроллер: зависимости по хешам и hcpy с описанными отличиями."""

    PIN = re.compile(r"^[a-z0-9-]+==[0-9][0-9a-z.]*$")
    HASH = re.compile(r"^--hash=sha256:[0-9a-f]{64}$")

    def pins(self, name):
        """{пакет: число хешей}; каждая запись — точная версия и хотя бы один SHA-256."""
        text = (ROOT / "hcpy_wb7" / name).read_text(encoding="utf-8")
        lines = [ln for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
        entries = " ".join(ln.rstrip("\\").strip() for ln in lines)
        found = {}
        current = None
        for word in entries.split():
            if self.PIN.match(word):
                current = word.split("==")[0]
                found[current] = 0
            else:
                self.assertRegex(word, self.HASH, "%s: непонятная запись" % name)
                self.assertIsNotNone(current)
                found[current] += 1
        self.assertTrue(found and all(found.values()), "%s: пакет без хеша" % name)
        return found

    def test_runtime_requirements_are_pinned_and_need_no_yaml(self):
        self.assertEqual(sorted(self.pins("requirements-wb7.txt")),
                         ["click", "click-config-file", "configobj", "paho-mqtt", "websocket-client"])

    def test_build_requirements_are_pinned(self):
        # paho-mqtt 1.6.1 собирается на контроллере из исходников: его сборщик тоже закреплён
        self.assertEqual(sorted(self.pins("build-constraints-wb7.txt")), ["setuptools"])
        installer = (ROOT / "hcpy_wb7" / "install_hcpy.sh").read_text(encoding="utf-8")
        self.assertRegex(installer, r'--require-hashes \\\n\s+--build-constraints "\$SRC/build-constraints-wb7\.txt"')

    @unittest.skipIf(hc2mqtt is None, "нет зависимостей hcpy (pip install -r hcpy_wb7/requirements-wb7.txt)")
    def test_bridge_starts_without_yaml(self):
        code = ("import sys; sys.modules['yaml'] = None; sys.path.insert(0, sys.argv[1]); "
                "import hc2mqtt; assert 'HADiscovery' not in sys.modules")
        r = subprocess.run([sys.executable, "-c", code, str(APP)], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)

    def upstream_hashes(self):
        lines = (APP / "UPSTREAM.sha256").read_text(encoding="utf-8").splitlines()
        return {name: digest for digest, name in (ln.split("  ", 1) for ln in lines)}

    def test_vendored_files_are_listed(self):
        files = {p.name for p in APP.iterdir() if p.is_file()}
        self.assertEqual(files, set(self.upstream_hashes()) | {"VERSION", "UPSTREAM.sha256", "wb7-changes.patch"})

    @unittest.skipIf(shutil.which("git") is None, "нужен git")
    def test_patch_is_the_whole_difference_from_upstream(self):
        """VERSION + wb7-changes.patch описывают hcpy полностью: откат патча даёт исходные файлы."""
        expected = self.upstream_hashes()
        with tempfile.TemporaryDirectory() as tmp:
            for name in expected:
                shutil.copy(str(APP / name), tmp)
            r = subprocess.run(["git", "apply", "-R", "--whitespace=nowarn", str(APP / "wb7-changes.patch")],
                               cwd=tmp, capture_output=True, text=True, timeout=60)
            self.assertEqual(r.returncode, 0, r.stderr)
            actual = {name: hashlib.sha256((Path(tmp) / name).read_bytes()).hexdigest() for name in expected}
        self.assertEqual(actual, expected, "hcpy_wb7/app изменён, а wb7-changes.patch не обновлён")
        patched = set(re.findall(r"^diff --git a/(\S+) ", (APP / "wb7-changes.patch").read_text(encoding="utf-8"), re.M))
        version = (APP / "VERSION").read_text(encoding="utf-8")
        for name in patched:
            self.assertIn(name + ":", version, "VERSION не упоминает изменённый файл")


if __name__ == "__main__":
    unittest.main()
