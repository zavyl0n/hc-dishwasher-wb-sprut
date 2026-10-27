"""Стык правила и hcpy: правило понимает то, что публикует hcpy, а hcpy принимает команды правила.

    python3 -m unittest discover -s tests

Используется hcpy из hcpy_wb7/app (тот, что ставится на WB) и фикстура tests/fixtures/smv4hvx31e.json.
Часть тестов запускает node (tests/dump_commands.js), часть — hc2mqtt (нужны зависимости из
hcpy_wb7/requirements-wb7.txt); без них эти тесты пропускаются.
"""
import contextlib
import copy
import io
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

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
except ImportError:  # нет click / paho-mqtt / websocket-client / yaml
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
        self.published = []

    def is_connected(self):
        return True

    def publish(self, topic, payload, retain=False, qos=0):
        self.published.append((topic, payload, retain))


@unittest.skipIf(hc2mqtt is None, "нет зависимостей hcpy (pip install -r hcpy_wb7/requirements-wb7.txt)")
class Hc2mqttPublishing(unittest.TestCase):
    """Топики и формат, в которых hc2mqtt публикует состояние и события."""

    def publish(self, msg):
        dev, client = make_device(), _Client()
        with contextlib.redirect_stdout(io.StringIO()):
            hc2mqtt.handle_device_message(msg, dev, {}, client, "homeconnect/dishwasher", "dishwasher")
        return {t: p for t, p, _ in client.published}, client

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
        dev, client, published = make_device(), _Client(), {}
        with contextlib.redirect_stdout(io.StringIO()):
            for _ in range(2):
                hc2mqtt.handle_device_message({"BSH.Common.Status.DoorState": "Closed"}, dev, published,
                                              client, "homeconnect/dishwasher", "dishwasher")
        self.assertEqual(len(client.published), 1)


if __name__ == "__main__":
    unittest.main()
