"""Генератор tools/make_kit.py: devices.json → правило wb-rules и шаблон Sprut.hub.

    python3 -m unittest discover -s tests

Фикстуры в tests/fixtures — синтетические (ключи ненастоящие):
  smv4hvx31e.json  — Bosch SMV4HVX31E, из неё собран examples/SMV4HVX31E;
  other_model.json — духовка + посудомойка без отложенного старта и отмены, с кириллическим
                     именем, неизвестными программой и опцией, двумя «Избранными».
"""
import contextlib
import copy
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
FIXTURES = ROOT / "tests" / "fixtures"
EXAMPLE = ROOT / "examples" / "SMV4HVX31E"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

import make_kit  # noqa: E402


def load(name):
    with open(FIXTURES / name, encoding="utf-8") as fh:
        return json.load(fh)


def smv():
    return load("smv4hvx31e.json")[0]


def other():
    return [d for d in load("other_model.json") if d["name"] == "Посудомойка"][0]


def build(dev):
    return make_kit.build_model(copy.deepcopy(dev))


def run_cli(*args):
    env = dict(os.environ, PYTHONIOENCODING="utf-8")
    return subprocess.run([sys.executable, str(TOOLS / "make_kit.py")] + [str(a) for a in args],
                          capture_output=True, text=True, encoding="utf-8", env=env)


def rule_cells(rule_src, model):
    """Контролы, которые создаст правило (по defineVirtualDevice/c(...) и блоку МОДЕЛЬ)."""
    cells = set(re.findall(r'^\s*c\("([a-z0-9_]+)"', rule_src, re.M))
    cells |= {o["ctrl"] for o in model["options"]} | {s["ctrl"] for s in model["settings"]}
    cells |= {"prog_" + p["key"].lower() for p in model["programs"]}
    return cells


class Example(unittest.TestCase):
    def test_reproduces_example_byte_exact(self):
        with tempfile.TemporaryDirectory() as out:
            r = run_cli(FIXTURES / "smv4hvx31e.json", "--out", out)
            self.assertEqual(r.returncode, 0, r.stderr)
            for name in ("dishwasher.js", "spruthub_dishwasher.json"):
                self.assertEqual((Path(out) / name).read_bytes(), (EXAMPLE / name).read_bytes(),
                                 "%s отличается от примера — перегенерируйте examples/SMV4HVX31E" % name)

    def test_reproduces_compact_example_byte_exact(self):
        # python3 tools/make_kit.py tests/fixtures/smv4hvx31e.json --out <папка> --sprut-compact
        with tempfile.TemporaryDirectory() as out:
            r = run_cli(FIXTURES / "smv4hvx31e.json", "--out", out, "--sprut-compact")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertEqual((Path(out) / "spruthub_dishwasher.json").read_bytes(),
                             (EXAMPLE / "spruthub_dishwasher_compact.json").read_bytes(),
                             "компактный шаблон отличается от примера — перегенерируйте его")
            # параметры вида Sprut.hub правило не меняют
            self.assertEqual((Path(out) / "dishwasher.js").read_bytes(), (EXAMPLE / "dishwasher.js").read_bytes())

    def test_cli_summary(self):
        with tempfile.TemporaryDirectory() as out:
            r = run_cli(FIXTURES / "smv4hvx31e.json", "--out", out)
        self.assertIn("Модель: Bosch SMV4HVX31E, топики hcpy: homeconnect/dishwasher/...", r.stdout)
        self.assertIn("Программы (8): Эко 50° [Eco50], Авто 45–65° [Auto2],", r.stdout)
        self.assertNotIn("Внимание", r.stdout)
        self.assertNotIn("Sprut.hub:", r.stdout)

    def test_secrets_are_not_copied(self):
        with tempfile.TemporaryDirectory() as out:
            for fx in ("smv4hvx31e.json", "other_model.json"):
                run_cli(FIXTURES / fx, "--out", out)
                text = "".join(p.read_text(encoding="utf-8") for p in Path(out).iterdir())
                for d in load(fx):
                    self.assertNotIn(d["key"], text)
                    self.assertNotIn(d["host"], text)

    def test_rule_template_must_have_model_block(self):
        src = make_kit.RULE_SRC
        self.assertIn("// ===== BEGIN MODEL", Path(src).read_text(encoding="utf-8"))
        self.assertIn("// ===== END MODEL =====", Path(src).read_text(encoding="utf-8"))

    def test_rule_source_matches_example_outside_model_block(self):
        # rule/dishwasher.js и пример должны отличаться только выравниванием в блоке МОДЕЛЬ
        pat = re.compile(r"// ===== BEGIN MODEL.*?// ===== END MODEL =====\n", re.S)
        a = pat.sub("", (ROOT / "rule" / "dishwasher.js").read_text(encoding="utf-8"))
        b = pat.sub("", (EXAMPLE / "dishwasher.js").read_text(encoding="utf-8"))
        self.assertEqual(a, b, "правило изменено, а пример не перегенерирован")


class PickDevice(unittest.TestCase):
    def test_skips_non_dishwashers(self):
        self.assertEqual(make_kit.pick_device(load("other_model.json"), None)["name"], "Посудомойка")

    def test_several_dishwashers_need_name(self):
        devs = [smv(), dict(smv(), name="kitchen2")]
        with self.assertRaises(SystemExit) as cm:
            make_kit.pick_device(devs, None)
        self.assertIn("--name", str(cm.exception.code))
        self.assertEqual(make_kit.pick_device(devs, "kitchen2")["name"], "kitchen2")

    def test_unknown_name_lists_devices(self):
        with self.assertRaises(SystemExit) as cm:
            make_kit.pick_device(load("other_model.json"), "nope")
        self.assertIn("oven", str(cm.exception.code))

    def test_no_dishwasher(self):
        with self.assertRaises(SystemExit):
            make_kit.pick_device([load("other_model.json")[0]], None)

    def test_cli_accepts_single_object(self):
        with tempfile.TemporaryDirectory() as out:
            src = Path(out) / "one.json"
            src.write_text(json.dumps(smv()), encoding="utf-8")
            self.assertEqual(run_cli(src, "--out", out).returncode, 0)

    def test_cli_accepts_utf8_bom(self):
        # Блокнот Windows может сохранить devices.json с BOM
        with tempfile.TemporaryDirectory() as out:
            src = Path(out) / "bom.json"
            src.write_bytes(b"\xef\xbb\xbf" + json.dumps([smv()]).encode("utf-8"))
            r = run_cli(src, "--out", out)
            self.assertEqual(r.returncode, 0, r.stderr[-300:])


class BuildModel(unittest.TestCase):
    def test_smv_model(self):
        m = build(smv())
        self.assertEqual((m["brand"], m["model"], m["name"]), ("Bosch", "SMV4HVX31E", "dishwasher"))
        self.assertEqual(m["uids"], {"PowerState": 539, "AbortProgram": 512, "StartInRelative": 558})
        self.assertEqual((m["delay_max"], m["delay_step"]), (86400, 0))
        self.assertEqual([p["key"] for p in m["programs"]],
                         ["Eco50", "Auto2", "Intensiv70", "Quick65", "NightWash", "PreRinse", "MachineCare", "001"])
        self.assertEqual(m["programs"][-1]["title"], "Избранное")
        self.assertEqual(m["programs"][-1]["dur"], 7200, "избранное — как неизвестная программа")
        self.assertEqual(m["warnings"], [])
        self.assertEqual(m["has"], {"door": True, "remoteStart": True})
        self.assertEqual(m["missing"], [], "фикстура описывает всё, что слушает правило")
        self.assertEqual(m["unknown_events"], [])

    def test_missing_features_give_warnings_and_null_uids(self):
        m = build(other())
        self.assertIsNone(m["uids"]["AbortProgram"], "available=false считается отсутствующим")
        self.assertIsNone(m["uids"]["StartInRelative"])
        w = "\n".join(m["warnings"])
        self.assertIn("AbortProgram", w)
        self.assertIn("StartInRelative", w)

    def test_missing_required_features(self):
        m = build(other())
        self.assertEqual(m["has"], {"door": False, "remoteStart": False})
        w = "\n".join(m["warnings"])
        for name in ("OperationState", "DoorState", "RemoteControlStartAllowed"):
            self.assertIn("BSH.Common.Status." + name, w)
        self.assertNotIn("Root.ActiveProgram", w)
        self.assertIn("bsh_common_event_aquastopoccured", m["missing"])
        self.assertNotIn("bsh_common_status_doorstate", m["missing"], "о нём уже предупредили")
        rule = make_kit.build_rule(m)
        self.assertIn("var HAS = { door: false, remoteStart: false };", rule)

    def test_unavailable_statuses_warn_and_are_not_used_for_start_checks(self):
        dev = smv()
        names = {"BSH.Common.Status.DoorState", "BSH.Common.Status.RemoteControlStartAllowed"}
        for feature in dev["features"].values():
            if feature.get("name") in names:
                feature["available"] = False
        model = build(dev)
        self.assertEqual(model["has"], {"door": False, "remoteStart": False})
        for name in names:
            self.assertTrue(any(name in warning for warning in model["warnings"]))

    def test_without_active_program_warns(self):
        dev = smv()
        dev["features"] = {k: v for k, v in dev["features"].items() if v["name"] != "BSH.Common.Root.ActiveProgram"}
        self.assertTrue(any("ActiveProgram" in w and "старт программы" in w for w in build(dev)["warnings"]))

    def test_unknown_events_are_listed(self):
        dev = smv()
        dev["features"]["99999"] = {"name": "Dishcare.Dishwasher.Event.NewThing", "available": "true",
                                    "values": {"0": "Off", "1": "Present"}}
        self.assertEqual(build(dev)["unknown_events"], ["Dishcare.Dishwasher.Event.NewThing"])

    def test_rule_known_keys(self):
        keys = make_kit.rule_known_keys()
        self.assertIn("bsh_common_status_operationstate", keys)
        self.assertIn("bsh_common_event_aquastopoccured", keys)
        self.assertIn("dishcare_dishwasher_event_saltlack", keys)

    def test_unknown_program_and_option_kept_as_is(self):
        m = build(other())
        prog = {p["key"]: p for p in m["programs"]}
        self.assertEqual(prog["LearningDishwasher"]["title"], "LearningDishwasher")
        self.assertEqual(prog["LearningDishwasher"]["dur"], 7200)
        opt = {o["ctrl"]: o for o in m["options"]}
        self.assertEqual(opt["opt_turbodry"]["title"], "Опция: TurboDry")
        w = "\n".join(m["warnings"])
        self.assertIn("LearningDishwasher", w)
        self.assertIn("TurboDry", w)

    def test_unavailable_readonly_and_unknown_are_skipped(self):
        m = build(other())
        self.assertNotIn("Kurz60", [p["key"] for p in m["programs"]], "available=false")
        ctrls = [o["ctrl"] for o in m["options"]]
        self.assertNotIn("opt_halfload", ctrls, "опция только для чтения")
        self.assertNotIn("opt_somelevel", ctrls, "не логическая опция")
        sctrls = [s["ctrl"] for s in m["settings"]]
        self.assertNotIn("set_infolight", sctrls, "настройка только для чтения")
        self.assertEqual(sctrls, ["set_hardness", "set_silencetime", "set_remotelevel"],
                         "ChildLock не в списке безопасных настроек")

    def test_program_order_and_favorites(self):
        m = build(other())
        self.assertEqual([p["key"] for p in m["programs"]], ["Eco50", "Auto2", "LearningDishwasher", "001", "002"])
        self.assertEqual([p["title"] for p in m["programs"][-2:]], ["Избранное 1", "Избранное 2"])

    def test_setting_kinds(self):
        s = {x["ctrl"]: x for x in build(smv())["settings"]}
        self.assertEqual(s["set_infolight"]["kind"], "bool")
        self.assertEqual(s["set_sound"]["kind"], "enum")
        self.assertEqual(s["set_sound"]["values"][2], ["Medium", "Средне"])
        self.assertEqual(s["set_hardness"]["values"][0], ["H00", "0 (без соли)"])
        self.assertEqual(s["set_rinseaid"]["values"][3], ["R03", "3"])
        self.assertEqual((s["set_silencetime"]["scale"], s["set_silencetime"]["units"]), (60, "min"))
        o = {x["ctrl"]: x for x in build(other())["settings"]}
        self.assertEqual((o["set_silencetime"]["scale"], o["set_silencetime"]["units"]), (1, ""))

    def test_non_latin_name(self):
        m = build(other())
        self.assertTrue(any("латиницей" in w for w in m["warnings"]))
        rule = make_kit.build_rule(m)
        self.assertIn('base: "homeconnect/",', rule, "топик так же, как его посчитает hcpy")

    def test_delay_limits_from_devices_json(self):
        dev = smv()
        sir = [f for f in dev["features"].values() if f["name"] == "BSH.Common.Option.StartInRelative"][0]
        sir.update({"max": "43200", "stepSize": "3600"})
        m = build(dev)
        self.assertEqual((m["delay_max"], m["delay_step"]), (43200, 3600))
        rule = make_kit.build_rule(m)
        self.assertRegex(rule, r"var DELAY_MAX = 43200;")
        self.assertRegex(rule, r"var DELAY_STEP = 3600;")

    def test_power_state_is_required(self):
        dev = smv()
        dev["features"] = {k: v for k, v in dev["features"].items() if v["name"] != "BSH.Common.Setting.PowerState"}
        with self.assertRaises(SystemExit):
            build(dev)

    def test_programs_are_required(self):
        dev = smv()
        dev["features"] = {k: v for k, v in dev["features"].items() if ".Program." not in v["name"]}
        with self.assertRaises(SystemExit):
            build(dev)


OLD_RULE = """var CFG = {
  id: "dishwasher",
  base: "homeconnect/old",           // генератор задаёт сам — не переносится
  powerOnDelayMs: 5000,
  unloadReminderMin: 30,             // свой комментарий
  notifyStart: false,
  removedOption: 1,
  tgToken: "123456:SECRET,with,commas",
  tgChatId: "-100200"
};
"""


class KeepCfg(unittest.TestCase):
    def test_values_carried_over(self):
        new = make_kit.build_rule(build(smv()))
        src, kept, added, gone = make_kit.keep_cfg(new, OLD_RULE)
        cfg = make_kit.cfg_values(src)
        self.assertEqual(cfg["tgToken"], '"123456:SECRET,with,commas"')
        self.assertEqual(cfg["tgChatId"], '"-100200"')
        self.assertEqual(cfg["unloadReminderMin"], "30")
        self.assertEqual(cfg["notifyStart"], "false")
        self.assertEqual(cfg["base"], '"homeconnect/dishwasher"', "base всегда из devices.json")
        self.assertEqual(sorted(kept), ["notifyStart", "tgChatId", "tgToken", "unloadReminderMin"])
        self.assertIn("resetDelayOnStart", added)
        self.assertEqual(gone, ["removedOption"])
        # остальное правило не тронуто, комментарии нового правила на месте
        self.assertEqual(src.replace(make_kit.cfg_block(src).group(1), ""),
                         new.replace(make_kit.cfg_block(new).group(1), ""))
        self.assertIn("unloadReminderMin: 30,             // напомнить", src)

    def test_no_cfg_in_old_rule(self):
        with self.assertRaises(SystemExit):
            make_kit.keep_cfg(make_kit.build_rule(build(smv())), "// not a rule")

    def test_cli_does_not_print_secrets(self):
        with tempfile.TemporaryDirectory() as out:
            old = Path(out) / "old.js"
            old.write_text(OLD_RULE, encoding="utf-8")
            r = run_cli(FIXTURES / "smv4hvx31e.json", "--out", out, "--keep-cfg", old)
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("перенесено: ", r.stdout)
            self.assertIn("tgToken", r.stdout)
            self.assertNotIn("SECRET", r.stdout)
            self.assertIn('tgToken: "123456:SECRET,with,commas"',
                          (Path(out) / "dishwasher.js").read_text(encoding="utf-8"))

    def test_roundtrip_with_example(self):
        # перенос из самого себя ничего не меняет
        ex = (EXAMPLE / "dishwasher.js").read_text(encoding="utf-8")
        src, kept, added, gone = make_kit.keep_cfg(ex, ex)
        self.assertEqual((src, kept, added, gone), (ex, [], [], []))


# Поля, которые шаблон вправе использовать (по схеме редактора шаблонов Sprut.hub).
TOP_KEYS = {"name", "manufacturer", "model", "modelIds", "services", "options"}
SERVICE_KEYS = {"name", "type", "visible", "characteristics"}
CHAR_KEYS = {"type", "name", "unit", "link", "minValue", "maxValue", "minStep"}
OPTION_KEYS = CHAR_KEYS | {"inputType", "write", "value", "values"}
LINK_KEYS = {"type", "topicGet", "topicSet", "map"}
# в сервисе «Параметр» (C_Option) — не больше одной характеристики каждого типа
C_OPTION_CHARS = {"C_String", "C_Integer", "C_Boolean", "C_Double", "C_Long", "Name"}

VARIANTS = [
    {},
    {"compact": True},
    {"settings_options": True},
    {"compact": True, "settings_options": True},
]


class Template(unittest.TestCase):
    def check_links(self, dev, **view):
        m = build(dev)
        rule = make_kit.build_rule(m)
        cells = rule_cells(rule, m)
        tpl = make_kit.build_template(m, **view)
        used = set()
        linked = [c for s in tpl["services"] for c in s["characteristics"]] + tpl["options"]
        for c in linked:
            self.assertEqual(len(c["link"]), 1)
            for lk in c["link"]:
                self.assertEqual(set(lk) - LINK_KEYS, set())
                ctrl = lk["topicGet"].rsplit("/", 1)[1]
                used.add(ctrl)
                self.assertTrue(lk["topicGet"].startswith("/devices/(1)/controls/"))
                if "topicSet" in lk:
                    self.assertEqual(lk["topicSet"], lk["topicGet"] + "/on")
        self.assertEqual(used - cells, set(), "шаблон ссылается на контролы, которых нет в правиле")
        return m, tpl

    def controls(self, tpl):
        """Контрол WB -> сколько раз он привязан в шаблоне."""
        seen = {}
        for c in [c for s in tpl["services"] for c in s["characteristics"]] + tpl["options"]:
            ctrl = c["link"][0]["topicGet"].rsplit("/", 1)[1]
            seen[ctrl] = seen.get(ctrl, 0) + 1
        return seen

    def test_all_links_point_to_rule_controls(self):
        for view in VARIANTS:
            self.check_links(smv(), **view)
            self.check_links(other(), **view)

    def test_structure_in_every_variant(self):
        for dev in (smv(), other()):
            for view in VARIANTS:
                _, tpl = self.check_links(dev, **view)
                self.assertEqual(set(tpl) - TOP_KEYS, set())
                for s in tpl["services"]:
                    self.assertEqual(set(s) - SERVICE_KEYS, set(), s["name"])
                    types = [c["type"] for c in s["characteristics"]]
                    self.assertEqual(len(types), len(set(types)), "%s: тип характеристики повторяется" % s["name"])
                    for c in s["characteristics"]:
                        self.assertEqual(set(c) - CHAR_KEYS, set(), s["name"])
                    if s["type"] == "C_Option":
                        self.assertEqual(set(types) - C_OPTION_CHARS, set(), s["name"])
                        if len(types) > 1:
                            # общий сервис: без подписей характеристики неразличимы
                            names = [c.get("name") for c in s["characteristics"]]
                            self.assertTrue(all(names), s["name"])
                            self.assertEqual(len(names), len(set(names)), s["name"])
                for o in tpl["options"]:
                    self.assertEqual(set(o) - OPTION_KEYS, set(), o["name"])
                    self.assertIn(o["type"], ("String", "Integer", "Boolean"))
                    self.assertEqual(o["write"], "topicSet" in o["link"][0], o["name"])
                    if "values" in o:
                        # редактор Sprut.hub требует value вместе с values
                        self.assertIn(o["value"], [v["value"] for v in o["values"]])
                        self.assertTrue(all(isinstance(v["name"], str) and v["name"] for v in o["values"]))
                names = [o["name"] for o in tpl["options"]]
                self.assertEqual(len(names), len(set(names)))

    def test_views_bind_the_same_controls(self):
        # параметры вида меняют раскладку, но не набор данных
        for dev in (smv(), other()):
            base = self.controls(self.check_links(dev)[1])
            # дважды привязаны только уровни соли и ополаскивателя (индикатор и процент)
            self.assertEqual({c for c, n in base.items() if n != 1} - {"salt_level", "rinse_level"}, set())
            for view in VARIANTS[1:]:
                self.assertEqual(self.controls(self.check_links(dev, **view)[1]), base, view)

    def test_main_services(self):
        _, tpl = self.check_links(smv())
        self.assertEqual(tpl["modelIds"], ["/devices/(dishwasher)/controls/run/meta/type"])
        valve = tpl["services"][0]
        self.assertEqual((valve["name"], valve["type"]), ("Мойка", "Valve"))
        active = [c for c in valve["characteristics"] if c["type"] == "Active"][0]
        self.assertEqual(active["link"][0]["topicSet"], "/devices/(1)/controls/run/on")

    def test_countdown_limit_covers_delay_plus_program(self):
        # «До окончания» = задержка старта + время программы: сутки задержки и «Эко» — уже 99900 с
        def limit(dev):
            valve = make_kit.build_template(build(dev))["services"][0]
            return [c for c in valve["characteristics"] if c["type"] == "RemainingDuration"][0]["maxValue"]
        self.assertEqual(limit(smv()), 86400 + 6 * 3600)
        self.assertGreater(limit(smv()), 86400 + max(d for _, d in make_kit.PROGRAM_INFO.values()))
        dev = smv()
        sir = [f for f in dev["features"].values() if f["name"] == "BSH.Common.Option.StartInRelative"][0]
        sir["max"] = "21600"
        self.assertEqual(limit(dev), 21600 + 6 * 3600)

    def test_sensor_services_require_available_telemetry(self):
        _, full = self.check_links(smv())
        _, limited = self.check_links(other())
        sensor_names = {"Дверь", "AquaStop", "Соль", "Ополаскиватель", "Уход за машиной",
                        "Фильтр", "Циклов до ухода за машиной", "Удалённый старт разрешён"}
        self.assertTrue(sensor_names <= {service["name"] for service in full["services"]})
        self.assertFalse(sensor_names & {service["name"] for service in limited["services"]})

        dev = smv()
        for feature in dev["features"].values():
            if feature.get("name") == "BSH.Common.Event.AquaStopOccured":
                feature["available"] = "false"
        _, unavailable = self.check_links(dev)
        self.assertNotIn("AquaStop", {service["name"] for service in unavailable["services"]})

    def test_settings_are_hidden(self):
        _, tpl = self.check_links(smv())
        settings = [s for s in tpl["services"] if s["name"].startswith("Настройка:")]
        self.assertEqual(len(settings), 11)
        self.assertTrue(all(s.get("visible") is False for s in settings))

    def test_two_value_enum_becomes_switch(self):
        _, tpl = self.check_links(smv())
        by_name = {s["name"]: s for s in tpl["services"]}
        self.assertEqual(by_name["Настройка: горячая вода"]["type"], "Switch")
        self.assertEqual(by_name["Настройка: Эко при включении"]["type"], "Switch")
        sound = by_name["Настройка: громкость сигнала (0–3)"]["characteristics"][0]
        self.assertEqual((sound["minValue"], sound["maxValue"]), (0, 3))

    def test_sparse_enum_lists_allowed_values(self):
        _, tpl = self.check_links(other())
        names = [s["name"] for s in tpl["services"]]
        self.assertIn("Настройка: удалённое управление (0, 2)", names)
        self.assertIn("Настройка: жёсткость воды (0–3)", names)

    def test_units_are_fields_not_parts_of_names(self):
        _, tpl = self.check_links(smv())
        by_name = {s["name"]: s["characteristics"][0] for s in tpl["services"]}
        self.assertEqual(by_name["Прогресс"]["unit"], "%")
        self.assertEqual(by_name["Отложить старт"]["unit"], "ч")
        silence = by_name["Настройка: длительность тихого режима"]
        self.assertEqual((silence["unit"], silence["minValue"], silence["maxValue"]), ("мин", 1, 30))
        # у другой модели та же настройка без единиц (не время)
        _, tpl = self.check_links(other())
        silence = [s for s in tpl["services"] if s["name"] == "Настройка: длительность тихого режима"][0]
        self.assertNotIn("unit", silence["characteristics"][0])

    def test_delay_slider_follows_machine_limit(self):
        dev = smv()
        sir = [f for f in dev["features"].values() if f["name"] == "BSH.Common.Option.StartInRelative"][0]
        sir["max"] = "21600"
        tpl = make_kit.build_template(build(dev))
        delay = [s for s in tpl["services"] if s["name"] == "Отложить старт"][0]["characteristics"][0]
        self.assertEqual(delay["maxValue"], 6)
        tpl = make_kit.build_template(build(dev), compact=True)
        delay = [s for s in tpl["services"] if s["name"] == "Отложенный старт"][0]["characteristics"][0]
        self.assertEqual((delay["type"], delay["maxValue"]), ("C_Integer", 6))

    def test_no_delay_services_without_start_in_relative(self):
        for view in ({}, {"compact": True}):
            _, tpl = self.check_links(other(), **view)
            self.assertNotIn("delay_h", self.controls(tpl))
            self.assertNotIn("finish_at", self.controls(tpl))
        _, tpl = self.check_links(smv())
        names = [s["name"] for s in tpl["services"]]
        self.assertIn("Отложить старт", names)
        self.assertIn("Завершить к (ЧЧ:ММ)", names)

    def test_service_names_unique(self):
        for dev in (smv(), other()):
            for view in VARIANTS:
                names = [s["name"] for s in make_kit.build_template(build(dev), **view)["services"]]
                self.assertEqual(len(names), len(set(names)))

    def test_diagnostics_are_read_only_device_options(self):
        _, tpl = self.check_links(smv())
        opts = {o["name"]: o for o in tpl["options"]}
        self.assertEqual(list(opts), ["Прошивка", "Доступно обновление ПО", "Wi-Fi, dBm", "Всего запусков",
                                      "Как завершилась последняя программа", "Тихий режим: осталось, мин",
                                      "Прогноз расхода энергии, %", "Прогноз расхода воды, %"])
        for o in opts.values():
            self.assertEqual((o["inputType"], o["write"]), ("STATUS", False))
            self.assertNotIn("topicSet", o["link"][0])
        self.assertEqual((opts["Прошивка"]["type"], opts["Прошивка"]["link"][0]["type"]), ("String", "String"))
        # переключатель WB публикует 0/1
        update = opts["Доступно обновление ПО"]
        self.assertEqual((update["type"], update["link"][0]["type"]), ("Boolean", "Integer"))
        # диагностика больше не занимает сервисы; скрытым остаётся только число минут для сценариев
        hidden = [s["name"] for s in tpl["services"]
                  if s.get("visible") is False and not s["name"].startswith("Настройка:")]
        self.assertEqual(hidden, ["Осталось, мин"])


class TemplateViews(unittest.TestCase):
    """Необязательные параметры вида Sprut.hub: --sprut-compact, --sprut-settings-options, --sprut-programs."""

    def tpl(self, dev=None, **view):
        return make_kit.build_template(build(dev or smv()), **view)

    def test_default_view_is_not_affected(self):
        m = build(smv())
        self.assertEqual(make_kit.build_template(m),
                         make_kit.build_template(m, compact=False, settings_options=False, programs=None))

    def test_compact_merges_related_values(self):
        by_name = {s["name"]: s for s in self.tpl(compact=True)["services"]}

        def chars(name):
            return [(c["type"], c["name"], c["link"][0]["topicGet"].rsplit("/", 1)[1])
                    for c in by_name[name]["characteristics"]]
        self.assertEqual(chars("Состояние"), [("C_String", "Состояние", "state"),
                                              ("C_Integer", "Прогресс", "progress"),
                                              ("C_Boolean", "Связь с машиной", "online")])
        self.assertEqual(chars("Осталось"), [("C_String", "Осталось", "remaining"),
                                             ("C_Integer", "Осталось минут", "remaining_min")])
        self.assertEqual(chars("Старт через"), [("C_String", "Старт через", "start_in"),
                                                ("C_Boolean", "Удалённый старт разрешён", "remote_start")])
        self.assertEqual(chars("Отложенный старт"), [("C_Integer", "Отложить на", "delay_h"),
                                                     ("C_String", "Завершить к (ЧЧ:ММ)", "finish_at")])
        for c in by_name["Отложенный старт"]["characteristics"]:
            self.assertIn("topicSet", c["link"][0])
        for gone in ("Прогресс", "Связь с машиной", "Удалённый старт разрешён", "Осталось, мин",
                     "Отложить старт", "Завершить к (ЧЧ:ММ)"):
            self.assertNotIn(gone, by_name)

    def test_compact_has_fewer_tiles(self):
        def visible(tpl):
            return sum(1 for s in tpl["services"] if s.get("visible", True))
        self.assertEqual(visible(self.tpl()) - visible(self.tpl(compact=True)), 4)

    def test_compact_without_remote_start_and_delay(self):
        by_name = {s["name"]: s for s in self.tpl(other(), compact=True)["services"]}
        self.assertNotIn("Отложенный старт", by_name)
        self.assertEqual([c["type"] for c in by_name["Старт через"]["characteristics"]], ["C_String"])
        self.assertNotIn("name", by_name["Старт через"]["characteristics"][0])

    def test_settings_as_options_have_value_names(self):
        tpl = self.tpl(settings_options=True)
        self.assertFalse([s for s in tpl["services"] if s["name"].startswith("Настройка:")])
        opts = {o["name"]: o for o in tpl["options"]}
        self.assertEqual(len(opts), 8 + 11)
        hardness = opts["Жёсткость воды"]
        self.assertEqual(hardness["type"], "Integer")
        self.assertEqual(hardness["values"][0], {"value": 0, "name": "0 (без соли)"})
        self.assertEqual([v["value"] for v in hardness["values"]], list(range(8)))
        self.assertEqual(hardness["link"], [{"type": "Integer",
                                             "topicGet": "/devices/(1)/controls/set_hardness",
                                             "topicSet": "/devices/(1)/controls/set_hardness/on"}])
        # два значения — тоже список с названиями, а не выключатель
        self.assertEqual([v["name"] for v in opts["Подключение воды"]["values"]], ["Холодная", "Горячая"])
        self.assertEqual(opts["InfoLight (луч на полу)"]["type"], "Boolean")
        silence = opts["Длительность тихого режима"]
        self.assertEqual((silence["minValue"], silence["maxValue"], silence["unit"]), (1, 30, "мин"))
        for name, o in opts.items():
            if o["write"]:
                # начальные значения хаб не должен ни читать, ни записывать при старте
                self.assertNotIn("init", o)
                self.assertNotIn("inputType", o)

    def test_settings_as_options_keep_sparse_values(self):
        opts = {o["name"]: o for o in self.tpl(other(), settings_options=True)["options"]}
        self.assertEqual([v["value"] for v in opts["Удалённое управление"]["values"]], [0, 2])

    def test_selected_programs_come_first_others_hidden(self):
        m = build(smv())
        picked = make_kit.pick_programs(m, " quick65, Eco50 ,quick65")
        self.assertEqual(picked, ["Quick65", "Eco50"])
        progs = [s for s in make_kit.build_template(m, programs=picked)["services"]
                 if s["name"].startswith("Программа: ")]
        self.assertEqual(len(progs), 8)
        self.assertEqual([s["name"] for s in progs[:2]], ["Программа: Быстрая 65°", "Программа: Эко 50°"])
        self.assertEqual([s.get("visible", True) for s in progs], [True, True] + [False] * 6)
        # без параметра плитки есть у всех программ
        self.assertTrue(all(s.get("visible", True) for s in make_kit.build_template(m)["services"]
                            if s["name"].startswith("Программа: ")))

    def test_unknown_or_empty_program_list_is_rejected(self):
        m = build(smv())
        for spec, text in (("Eco50,Turbo", "нет программы Turbo"), (" , ", "не указано ни одной программы")):
            with self.assertRaises(SystemExit) as cm:
                make_kit.pick_programs(m, spec)
            self.assertIn(text, str(cm.exception))
            self.assertIn("Quick65 (Быстрая 65°)", str(cm.exception))

    def test_cli_flags(self):
        with tempfile.TemporaryDirectory() as out:
            r = run_cli(FIXTURES / "smv4hvx31e.json", "--out", out, "--sprut-compact",
                        "--sprut-settings-options", "--sprut-programs", "eco50,001")
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn("Sprut.hub: плитки программ — Eco50, 001; остальные скрыты", r.stdout)
            self.assertIn("сверьте их с Wiren Board", r.stdout)
            got = json.loads((Path(out) / "spruthub_dishwasher.json").read_text(encoding="utf-8"))
            m = build(smv())
            self.assertEqual(got, make_kit.build_template(m, compact=True, settings_options=True,
                                                          programs=["Eco50", "001"]))
            r = run_cli(FIXTURES / "smv4hvx31e.json", "--out", out, "--sprut-programs", "Turbo")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("нет программы Turbo", r.stderr)


if __name__ == "__main__":
    unittest.main()
