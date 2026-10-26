#!/usr/bin/env python3
"""make_kit.py — собирает правило wb-rules и шаблон Sprut.hub под вашу посудомойку.

    python make_kit.py путь/к/devices.json [--name dishwasher] [--out out]

На выходе в папке out/:
    dishwasher.js             — правило для /etc/wb-rules/ (программы, опции и настройки вашей модели)
    spruthub_dishwasher.json  — шаблон для Каталога Sprut.hub (контроллер MQTT)

Из devices.json читаются только описание возможностей машины (features),
модель (description) и имя (name). Ключи доступа (key, iv) не читаются
и никуда не записываются. Нужен Python 3.8+, сторонние пакеты не нужны.
"""
import argparse
import io
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
RULE_SRC = os.path.normpath(os.path.join(HERE, "..", "rule", "dishwasher.js"))
WB_DEVICE = "dishwasher"            # id виртуального устройства WB (CFG.id в правиле)

# key программы -> (название, примерная длительность в секундах).
# Длительность нужна только для «Завершить к» до первого запуска: потом правило
# берёт точное время, которое сообщает машина.
PROGRAM_INFO = {
    "Eco50": ("Эко 50°", 13500),
    "Auto1": ("Авто 35–45°", 7200),
    "Auto2": ("Авто 45–65°", 8400),
    "Auto3": ("Авто 65–75°", 8400),
    "AutoHalfLoad": ("Авто, половинная загрузка", 7200),
    "Intensiv70": ("Интенсивная 70°", 7300),
    "Intensiv45": ("Интенсивная 45°", 7200),
    "IntensivPower": ("Интенсивная Power", 7800),
    "Normal65": ("Нормальная 65°", 7200),
    "Normal45": ("Нормальная 45°", 7200),
    "Quick65": ("Быстрая 65°", 3600),
    "Quick45": ("Быстрая 45°", 1800),
    "Kurz60": ("Короткая 60°", 3600),
    "Super60": ("Super 60°", 5400),
    "ExpressSparkle65": ("Экспресс 65°", 3600),
    "MagicDaily": ("Magic Daily", 5400),
    "NightWash": ("Тихая (ночная)", 12000),
    "Glas40": ("Деликатная 40°", 6600),
    "GlassCare": ("Бережная для стекла", 6600),
    "MixedLoad": ("Смешанная загрузка", 7200),
    "MaximumCleaning": ("Максимальная очистка", 9000),
    "SteamFresh": ("Освежение паром", 1800),
    "PreRinse": ("Предварительное ополаскивание", 900),
    "MachineCare": ("Уход за машиной", 7200),
}
PROGRAM_ORDER = list(PROGRAM_INFO)

# key опции -> (контрол WB, подпись)
OPTION_INFO = {
    "VarioSpeedPlus": ("opt_variospeed", "VarioSpeed+ (быстрее)"),
    "HalfLoad": ("opt_halfload", "половинная загрузка"),
    "ExtraDry": ("opt_extradry", "Extra Dry (доп. сушка)"),
    "SilenceOnDemand": ("opt_silence", "тихий режим (Silence on demand)"),
    "IntensivZone": ("opt_intensivzone", "IntensiveZone (усиленная нижняя корзина)"),
    "HygienePlus": ("opt_hygieneplus", "HygienePlus (гигиена)"),
    "BrillianceDry": ("opt_brilliancedry", "BrillianceDry (блеск)"),
    "ZeoliteDry": ("opt_zeolitedry", "сушка цеолитом"),
    "EcoDry": ("opt_ecodry", "EcoDry (сушка с открытием двери)"),
}

# Настройки, которые безопасно показывать: (имя у машины, контрол WB, подпись,
# подпись выключателя в Sprut.hub для настроек с двумя значениями).
# Команды вроде сброса к заводским сюда намеренно не входят.
KNOWN_SETTINGS = [
    ("Dishcare.Dishwasher.Setting.InfoLight", "set_infolight", "InfoLight (луч на полу)", None),
    ("Dishcare.Dishwasher.Setting.ExtraDry", "set_extradry", "Extra Dry всегда", None),
    ("Dishcare.Dishwasher.Setting.SpeedOnDemand", "set_speedondemand", "Speed on demand", None),
    ("Dishcare.Dishwasher.Setting.SoundLevelSignal", "set_sound", "громкость сигнала", None),
    ("Dishcare.Dishwasher.Setting.RinseAid", "set_rinseaid", "дозировка ополаскивателя", None),
    ("Dishcare.Dishwasher.Setting.WaterHardness", "set_hardness", "жёсткость воды", None),
    ("Dishcare.Dishwasher.Setting.HotWater", "set_hotwater", "подключение воды", "горячая вода"),
    ("Dishcare.Dishwasher.Setting.SensitivityTurbidity", "set_turbidity", "датчик загрязнения", None),
    ("Dishcare.Dishwasher.Setting.EcoAsDefault", "set_ecodefault", "программа при включении", "Эко при включении"),
    ("Dishcare.Dishwasher.Setting.SilenceOnDemandDefaultTime", "set_silencetime", "длительность тихого режима", None),
    ("BSH.Common.Setting.RemoteControlLevel", "set_remotelevel", "удалённое управление", None),
    ("BSH.Common.Setting.AllowBackendConnection", "set_cloud", "связь с облаком Home Connect", None),
]

VALUE_RU = {
    "Off": "Выкл", "On": "Вкл", "Low": "Тихо", "Medium": "Средне", "High": "Громко",
    "ColdWater": "Холодная", "HotWater": "Горячая",
    "Standard": "Стандарт", "Sensitive": "Чувствительный", "VerySensitive": "Очень чувствительный",
    "LastProgram": "Последняя", "EcoAsDefault": "Эко 50°",
    "Monitoring": "Только мониторинг", "ManualRemoteStart": "Старт по кнопке на машине",
    "PermanentRemoteStart": "Постоянный удалённый старт",
}


def value_ru(name):
    m = re.fullmatch(r"R(\d\d)", name)
    if m:
        return str(int(m.group(1)))
    m = re.fullmatch(r"H(\d\d)", name)
    if m:
        return "0 (без соли)" if int(m.group(1)) == 0 else str(int(m.group(1)))
    return VALUE_RU.get(name, name)


def topic_key(name):
    """Так hcpy называет топик состояния: homeconnect/<машина>/state/<topic_key>."""
    return name.lower().replace(".", "_")


def clean_name(text):
    """Как utils.clean_international_text в hcpy: имя машины -> часть MQTT-топика."""
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")


def available(f):
    return str(f.get("available", "true")).lower() == "true"


def writable(f):
    return str(f.get("access", "")).lower() in ("readwrite", "writeonly")


def pick_device(devices, name):
    if name:
        for d in devices:
            if d.get("name") == name:
                return d
        sys.exit("В devices.json нет машины с name=%r. Есть: %s" % (name, [d.get("name") for d in devices]))
    dish = [d for d in devices
            if any(str(f.get("name", "")).startswith("Dishcare.Dishwasher.") for f in d.get("features", {}).values())]
    if not dish:
        sys.exit("В devices.json не найдено посудомоечных машин (нет функций Dishcare.Dishwasher.*)")
    if len(dish) > 1:
        sys.exit("Посудомоек несколько: %s. Укажите нужную через --name" % [d.get("name") for d in dish])
    return dish[0]


def build_model(dev):
    feats = {}
    for uid, f in dev.get("features", {}).items():
        if str(uid).isdigit() and "name" in f:
            feats[f["name"]] = (int(uid), f)

    warnings = []

    def uid_of(name):
        item = feats.get(name)
        return item[0] if item and available(item[1]) else None

    uids = {
        "PowerState": uid_of("BSH.Common.Setting.PowerState"),
        "AbortProgram": uid_of("BSH.Common.Command.AbortProgram"),
        "StartInRelative": uid_of("BSH.Common.Option.StartInRelative"),
    }
    if not uids["PowerState"]:
        sys.exit("У машины нет BSH.Common.Setting.PowerState — правило рассчитано на управление питанием")
    if not uids["AbortProgram"]:
        warnings.append("нет команды AbortProgram — отмена программы будет только на самой машине")
    if not uids["StartInRelative"]:
        warnings.append("нет StartInRelative — отложенный старт работать не будет")
    sir = feats.get("BSH.Common.Option.StartInRelative", (0, {}))[1]
    delay_max = int(sir.get("max", 86400))
    delay_step = int(sir.get("stepSize", 0) or 0)

    # программы
    programs, favorites = [], []
    for name, (uid, f) in feats.items():
        if not available(f):
            continue
        if name.startswith("Dishcare.Dishwasher.Program."):
            key = name.rsplit(".", 1)[1]
            title, dur = PROGRAM_INFO.get(key, (key, 7200))
            if key not in PROGRAM_INFO:
                warnings.append("программа %s без русского названия — будет показана как есть" % key)
            programs.append({"uid": uid, "key": key, "title": title, "dur": dur})
        elif name.startswith("BSH.Common.Program.Favorite."):
            key = name.rsplit(".", 1)[1]
            favorites.append({"uid": uid, "key": key, "title": "Избранное " + key.lstrip("0"), "dur": 900})
    order = {k: i for i, k in enumerate(PROGRAM_ORDER)}
    programs.sort(key=lambda p: (order.get(p["key"], len(order)), p["key"]))
    favorites.sort(key=lambda p: p["key"])
    if len(favorites) == 1:
        favorites[0]["title"] = "Избранное"
    programs += favorites
    if not programs:
        sys.exit("В devices.json не найдено ни одной программы")

    # опции программ (логические, доступные на запись)
    options = []
    for name, (uid, f) in feats.items():
        if not name.startswith("Dishcare.Dishwasher.Option.") or not available(f) or not writable(f):
            continue
        if f.get("refCID") != "01":
            continue
        key = name.rsplit(".", 1)[1]
        ctrl, title = OPTION_INFO.get(key, ("opt_" + key.lower(), key))
        if key not in OPTION_INFO:
            warnings.append("опция %s без русского названия — будет показана как есть" % key)
        options.append({"ctrl": ctrl, "uid": uid, "key": topic_key(name), "title": "Опция: " + title})
    known_opt_order = [v[0] for v in OPTION_INFO.values()]
    options.sort(key=lambda o: known_opt_order.index(o["ctrl"]) if o["ctrl"] in known_opt_order else len(known_opt_order))

    # настройки
    settings = []
    for name, ctrl, title, switch_title in KNOWN_SETTINGS:
        item = feats.get(name)
        if not item or not available(item[1]) or not writable(item[1]):
            continue
        uid, f = item
        s = {"ctrl": ctrl, "uid": uid, "key": topic_key(name), "title": "Настройка: " + title}
        if "values" in f:
            s["kind"] = "enum"
            s["values"] = {int(k): [v, value_ru(v)] for k, v in sorted(f["values"].items(), key=lambda kv: int(kv[0]))}
            s["_switch_title"] = switch_title
        elif f.get("refCID") == "01":
            s["kind"] = "bool"
        elif "min" in f and "max" in f:
            scale = 60 if f.get("refCID") == "10" else 1
            s.update({"kind": "num", "scale": scale, "min": int(f["min"]), "max": int(f["max"]),
                      "units": "min" if scale == 60 else ""})
        else:
            continue
        settings.append(s)

    topic = clean_name(dev.get("name", ""))
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", topic):
        warnings.append("имя машины %r в топиках hcpy станет %r — переименуйте её в devices.json латиницей "
                        "(например dishwasher) и перезапустите hcpy" % (dev.get("name"), topic))

    desc = dev.get("description", {})
    return {
        "name": dev.get("name", "dishwasher"),
        "brand": str(desc.get("brand", "Bosch")).title(),
        "model": desc.get("model") or "unknown",
        "uids": uids, "delay_max": delay_max, "delay_step": delay_step,
        "programs": programs, "options": options, "settings": settings,
        "warnings": warnings,
    }


# ---------------------------------------------------------------------------
#  Правило wb-rules
# ---------------------------------------------------------------------------
def js(v):
    return json.dumps(v, ensure_ascii=False)


def model_block(m):
    out = ["// ===== BEGIN MODEL (сгенерировано tools/make_kit.py — правьте через генератор) =====",
           "var MODEL = %s;" % js(m["model"]),
           "var DELAY_MAX = %d;               // максимум отложенного старта, сек (из devices.json)" % m["delay_max"],
           "var DELAY_STEP = %d;                  // шаг отложенного старта из devices.json; 0 — брать CFG.delayStepSec" % m["delay_step"],
           "var UID = {"]
    out.append(",\n".join("  %s: %s" % (k, "null" if v is None else v) for k, v in m["uids"].items()))
    out += ["};", "",
            "// dur — примерная длительность (сек), пока машина сама не сообщит точную",
            "var PROGRAMS = ["]
    out.append(",\n".join("  { uid: %d, key: %s, title: %s, dur: %d }" % (p["uid"], js(p["key"]), js(p["title"]), p["dur"])
                          for p in m["programs"]))
    out += ["];", "", "var OPTIONS = ["]
    out.append(",\n".join("  { ctrl: %s, uid: %d, key: %s, title: %s }" % (js(o["ctrl"]), o["uid"], js(o["key"]), js(o["title"]))
                          for o in m["options"]))
    out += ["];", "",
            "// values: ключ — числовое значение для машины, [имя у машины, подпись]",
            "var SETTINGS = ["]
    rows = []
    for s in m["settings"]:
        head = "  { ctrl: %s, uid: %d, key: %s, kind: %s,\n    title: %s" % (
            js(s["ctrl"]), s["uid"], js(s["key"]), js(s["kind"]), js(s["title"]))
        if s["kind"] == "enum":
            vals = ", ".join("%d: [%s, %s]" % (k, js(v[0]), js(v[1])) for k, v in s["values"].items())
            head += ",\n    values: { %s }" % vals
        elif s["kind"] == "num":
            head += ", scale: %d, min: %d, max: %d, units: %s" % (s["scale"], s["min"], s["max"], js(s["units"]))
        rows.append(head + " }")
    out.append(",\n".join(rows))
    out += ["];", "// ===== END MODEL ====="]
    return "\n".join(out) + "\n"


def build_rule(m):
    src = io.open(RULE_SRC, encoding="utf-8").read()
    pat = re.compile(r"// ===== BEGIN MODEL.*?// ===== END MODEL =====\n", re.S)
    if not pat.search(src):
        sys.exit("В %s не найден блок BEGIN MODEL / END MODEL" % RULE_SRC)
    src = pat.sub(lambda _: model_block(m), src, count=1)
    base = "homeconnect/" + clean_name(m["name"])
    src, n = re.subn(r'(\bbase:\s*)"[^"]*"', lambda mm: mm.group(1) + js(base), src, count=1)
    if n != 1:
        sys.exit("В правиле не найдено поле CFG.base")
    return src


# ---------------------------------------------------------------------------
#  Шаблон Sprut.hub
# ---------------------------------------------------------------------------
DEV = "/devices/(1)/controls/"


def link(ctrl, lt="Integer", writable_=False, mp=None):
    lk = {"type": lt, "topicGet": DEV + ctrl}
    if writable_:
        lk["topicSet"] = DEV + ctrl + "/on"
    if mp:
        lk["map"] = mp
    return [lk]


def ch(ctype, ctrl, lt="Integer", writable_=False, mp=None, **extra):
    c = {"type": ctype, "link": link(ctrl, lt, writable_, mp)}
    c.update(extra)
    return c


def svc(name, stype, chars, visible=True):
    s = {"name": name, "type": stype, "characteristics": chars}
    if not visible:
        s["visible"] = False
    return s


def switch(name, ctrl, visible=True):
    return svc(name, "Switch", [ch("On", ctrl, writable_=True)], visible)


def opt_str(name, ctrl, writable_=False, visible=True):
    return svc(name, "C_Option", [ch("C_String", ctrl, "String", writable_)], visible)


def opt_int(name, ctrl, writable_=False, visible=True, **rng):
    return svc(name, "C_Option", [ch("C_Integer", ctrl, "Integer", writable_, **rng)], visible)


def opt_bool(name, ctrl, visible=True):
    return svc(name, "C_Option", [ch("C_Boolean", ctrl)], visible)


def short(title):
    return title.split(" (")[0]


def build_template(m):
    level_map = {"FILTER_OK": "100", "CHANGE_FILTER": "0;10"}
    services = [
        svc("Мойка", "Valve", [
            ch("Active", "run", writable_=True),
            ch("InUse", "running"),
            ch("RemainingDuration", "remaining_sec", maxValue=86400),
            ch("StatusFault", "alarm"),
        ]),
        switch("Питание", "power"),
    ]
    services += [switch("Программа: " + p["title"], "prog_" + p["key"].lower()) for p in m["programs"]]
    services += [switch(short(o["title"]), o["ctrl"]) for o in m["options"]]
    if m["uids"]["StartInRelative"]:
        services += [
            opt_int("Отложить старт, ч", "delay_h", writable_=True, minValue=0, maxValue=24, minStep=1),
            opt_str("Завершить к (ЧЧ:ММ)", "finish_at", writable_=True),
        ]
    services += [
        opt_str("Состояние", "state"),
        opt_str("Выполняется", "active_program"),
        opt_str("Фаза", "phase"),
        opt_int("Прогресс, %", "progress"),
        opt_str("Осталось", "remaining"),
        opt_str("Старт через", "start_in"),
        opt_str("Окончание", "end_time"),
        svc("Дверь", "ContactSensor", [ch("ContactSensorState", "door_open")]),
        svc("Мойка завершена", "OccupancySensor", [ch("OccupancyDetected", "finished")]),
        svc("AquaStop", "LeakSensor", [ch("LeakDetected", "aquastop")]),
        opt_str("Аварии", "alarm_text"),
        svc("Соль", "FilterMaintenance", [
            ch("FilterChangeIndication", "salt_level", mp=level_map),
            ch("FilterLifeLevel", "salt_level"),
        ]),
        svc("Ополаскиватель", "FilterMaintenance", [
            ch("FilterChangeIndication", "rinse_level", mp=level_map),
            ch("FilterLifeLevel", "rinse_level"),
        ]),
        svc("Уход за машиной", "FilterMaintenance", [ch("FilterChangeIndication", "care_needed")]),
        svc("Фильтр", "FilterMaintenance", [ch("FilterChangeIndication", "filter_check")]),
        opt_int("Циклов до ухода за машиной", "care_runs"),
        opt_str("Последнее событие", "last_message"),
        opt_str("Последняя мойка", "finished_at"),
        opt_bool("Связь с машиной", "online"),
        opt_bool("Удалённый старт разрешён", "remote_start"),
    ]
    # настройки машины — скрыты с рабочего стола
    for s in m["settings"]:
        if s["kind"] == "bool":
            services.append(switch(s["title"], s["ctrl"], visible=False))
        elif s["kind"] == "enum":
            keys = sorted(s["values"])
            if keys == [0, 1]:
                label = s.get("_switch_title") or "%s: %s" % (s["title"][len("Настройка: "):], s["values"][1][1])
                services.append(switch("Настройка: " + label, s["ctrl"], visible=False))
            else:
                services.append(opt_int("%s (%d–%d)" % (s["title"], keys[0], keys[-1]), s["ctrl"], writable_=True,
                                        visible=False, minValue=keys[0], maxValue=keys[-1], minStep=1))
        else:
            lo, hi = s["min"] // s["scale"], s["max"] // s["scale"]
            label = s["title"] + (", мин" if s["units"] == "min" else "")
            services.append(opt_int(label, s["ctrl"], writable_=True, visible=False,
                                    minValue=lo, maxValue=hi, minStep=1))
    # диагностика
    services += [
        opt_str("Как завершилась последняя программа", "end_trigger", visible=False),
        opt_int("Осталось, мин", "remaining_min", visible=False),
        opt_int("Тихий режим: осталось, мин", "silence_left", visible=False),
        opt_int("Прогноз энергии, %", "energy_forecast", visible=False),
        opt_int("Прогноз воды, %", "water_forecast", visible=False),
        opt_int("Всего запусков", "cycles", visible=False),
        opt_int("Wi-Fi, dBm", "rssi", visible=False),
        opt_str("Прошивка", "fw", visible=False),
        opt_bool("Доступно обновление ПО", "fw_update", visible=False),
    ]
    return {
        "name": "Посудомоечная машина",
        "manufacturer": m["brand"],
        "model": "%s (hcpy)" % m["model"],
        "modelIds": ["/devices/(%s)/controls/run/meta/type" % WB_DEVICE],
        "services": services,
    }


def main():
    ap = argparse.ArgumentParser(description="Правило wb-rules и шаблон Sprut.hub под вашу посудомойку")
    ap.add_argument("devices_json", help="devices.json от hcpy (hc-login.py или homeconnect-profile-downloader)")
    ap.add_argument("--name", help="поле name нужной машины, если в devices.json их несколько")
    ap.add_argument("--out", default="out", help="папка для результата (по умолчанию ./out)")
    a = ap.parse_args()

    with io.open(a.devices_json, encoding="utf-8") as fh:
        data = json.load(fh)
    devices = data if isinstance(data, list) else [data]
    m = build_model(pick_device(devices, a.name))

    os.makedirs(a.out, exist_ok=True)
    rule_path = os.path.join(a.out, "dishwasher.js")
    tpl_path = os.path.join(a.out, "spruthub_dishwasher.json")
    with io.open(rule_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(build_rule(m))
    with io.open(tpl_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(build_template(m), ensure_ascii=False, indent=2) + "\n")

    print("Модель: %s %s, топики hcpy: homeconnect/%s/..." % (m["brand"], m["model"], clean_name(m["name"])))
    print("Программы (%d): %s" % (len(m["programs"]), ", ".join(p["title"] for p in m["programs"])))
    print("Опции (%d): %s" % (len(m["options"]), ", ".join(short(o["title"])[len("Опция: "):] for o in m["options"]) or "нет"))
    print("Настройки (%d): %s" % (len(m["settings"]), ", ".join(s["title"][len("Настройка: "):] for s in m["settings"]) or "нет"))
    for w in m["warnings"]:
        print("Внимание: " + w)
    print("\nГотово:\n  %s\n  %s" % (rule_path, tpl_path))


if __name__ == "__main__":
    main()
