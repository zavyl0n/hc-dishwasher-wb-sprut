// Что показывать: из контролов правила dishwasher.js собирает состояние экрана.
// Чистые функции без DOM — их проверяют тесты (tests/web_model.test.js).

// Тексты состояния, которые публикует правило (OPSTATE_RU в rule/dishwasher.js)
const MODE_BY_STATE = {
  "Выключена": "off",
  "Готова": "ready",
  "Отложенный старт": "delayed",
  "Мойка": "running",
  "Пауза": "paused",
  "Требуется действие": "action",
  "Завершено": "finished",
  "Ошибка": "error",
  "Отмена программы": "aborting"
};

export const PHASES = ["Предополаскивание", "Мойка", "Ополаскивание", "Сушка"];

// Подсказки к программам по ключу Home Connect (ключ приходит в enum контрола program)
const PROGRAM_HINTS = [
  [/^eco/i,         "leaf",        "Бережёт воду и электричество, идёт дольше остальных"],
  [/^auto/i,        "gauge",       "Сама подбирает режим по загрязнению посуды"],
  [/^intensiv/i,    "flame",       "Кастрюли, сковороды, присохшая еда"],
  [/^(quick|kurz|express|speed)/i, "zap", "Короткая мойка для обычной посуды"],
  [/^(night|silence)/i, "moon",    "Самая тихая, но долгая"],
  [/^prerinse/i,    "droplets",    "Сполоснуть посуду без моющего средства"],
  [/^machinecare/i, "sparkles",    "Чистка самой машины, без посуды"],
  [/^glas/i,        "glass-water", "Бокалы и хрупкая посуда"],
  [/^\d+$/,         "star",        "Сохранённое на машине сочетание программы и опций"]
];

// Пояснения к настройкам машины
const SETTING_HINTS = {
  set_infolight: "Световая точка на полу, пока идёт программа",
  set_extradry: "Дополнительная сушка в каждой программе",
  set_sound: "Сигнал об окончании программы",
  set_rinseaid: "Сколько ополаскивателя подаётся за цикл",
  set_hardness: "Под жёсткость воды в доме: от неё зависит расход соли",
  set_hotwater: "К какой воде подключена машина",
  set_turbidity: "Чем чувствительнее, тем интенсивнее авто-программы и выше расход воды",
  set_ecodefault: "Какая программа выбрана после включения",
  set_silencetime: "На сколько минут включается тихий режим",
  set_remotelevel: "Что разрешено делать по сети",
  set_cloud: "Обмен данными с серверами Home Connect"
};

// Пояснения к опциям программы
const OPTION_HINTS = {
  opt_variospeed: "Заметно быстрее, но воды и электричества уходит больше",
  opt_halfload: "Когда посуды мало: меньше воды и времени",
  opt_extradry: "Дольше и горячее сушит: для пластика и бокалов",
  opt_silence: "На время делает работу тише, программа идёт дольше"
};

export function optionHint(id) { return OPTION_HINTS[id] || ""; }

export function programHint(key) {
  for (let i = 0; i < PROGRAM_HINTS.length; i++) {
    if (PROGRAM_HINTS[i][0].test(key || "")) return { icon: PROGRAM_HINTS[i][1], text: PROGRAM_HINTS[i][2] };
  }
  return { icon: "waves", text: "" };
}
export function settingHint(id) { return SETTING_HINTS[id] || ""; }

/** «Опция: VarioSpeed+ (быстрее)» -> { name: «VarioSpeed+», note: «быстрее» } */
export function splitTitle(title) {
  const t = String(title || "").replace(/^[^:]{1,12}:\s*/, "");
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(t);
  const name = m ? m[1] : t;
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return { name: cap, note: m ? m[2] : "" };
}

/** Минуты -> «1:42» */
export function fmtHM(min) {
  min = Math.max(0, Math.round(min));
  const m = min % 60;
  return Math.floor(min / 60) + ":" + (m < 10 ? "0" : "") + m;
}

/** Символ-пометка в начале события правила -> уровень; текст без пометки. */
export function parseNote(text) {
  const t = String(text || "");
  const m = /^([^\s\wА-Яа-яЁё«"(]+)\s+/.exec(t);
  if (!m) return { level: "info", text: t };
  const mark = m[1];
  let level = "info";
  if (mark.indexOf("❗") >= 0) level = "error";
  else if (mark.indexOf("⚠") >= 0 || mark.indexOf("⛔") >= 0) level = "warn";
  else if (mark.indexOf("✅") >= 0) level = "ok";
  return { level, text: t.slice(m[0].length) };
}

function wifiQuality(rssi) {
  if (!rssi) return "";
  if (rssi >= -60) return "отличный";
  if (rssi >= -70) return "хороший";
  if (rssi >= -80) return "слабый";
  return "очень слабый";
}

function programs(s) {
  const shown = parseFloat(s.shown("program"));
  const selected = String(Math.round(isNaN(shown) ? 0 : shown));
  const fromEnum = s.options("program");
  if (fromEnum.length) {
    return fromEnum.map((o) => ({
      uid: o.value, key: o.key, title: o.label, hint: programHint(o.key),
      selected: s.has("program") && o.value === selected, ctrl: null
    }));
  }
  // старое правило без enum: только выключатели prog_*
  return s.list("prog_").map((id) => ({
    uid: id, key: id.slice(5), title: splitTitle(s.title(id)).name, hint: programHint(id.slice(5)),
    selected: s.bool(id), ctrl: id
  }));
}

/**
 * Состояние экрана. s — DeviceStore. deviceWaitOver — устройство не появилось за отведённое время.
 */
export function derive(s, deviceWaitOver) {
  const v = {};

  // --- связь ---
  if (s.link !== "connected") v.link = s.link === "connecting" ? "connecting" : "broker";
  else if (!s.ready) v.link = deviceWaitOver ? "nodevice" : "connecting";
  else if (!s.bool("online")) v.link = "machine";
  else v.link = "ok";
  v.online = v.link === "ok";
  v.loaded = s.ready;                                       // есть что показать, пусть и устаревшее

  // --- режим ---
  const stateText = s.text("state");
  let mode = MODE_BY_STATE[stateText] || "unknown";
  const busy = s.bool("running");
  if (!v.online) mode = "offline";
  else if (!busy && s.bool("run")) mode = "starting";       // правило включает питание перед стартом
  v.mode = mode;
  v.busy = v.online && (busy || mode === "starting");
  v.stateText = v.online ? stateText || "Нет данных" : "Нет связи";
  v.power = s.shownBool("power");

  // --- программа ---
  v.programs = programs(s);
  v.selected = v.programs.filter((p) => p.selected)[0] || null;
  const active = s.text("active_program");
  v.programTitle = busy && active ? active : v.selected ? v.selected.title : "";
  v.canSelect = v.online && !busy && mode !== "starting" && mode !== "unknown" && mode !== "error";

  // --- ход программы ---
  v.progress = Math.max(0, Math.min(100, s.num("progress")));
  v.remainingMin = s.num("remaining_min");
  v.phase = s.text("phase");
  v.phaseIndex = mode === "running" || mode === "paused" || mode === "action" ? PHASES.indexOf(v.phase) : -1;
  v.endText = s.text("end_time");
  const startIn = s.text("start_in");                        // «2 ч 10 мин (в 23:10)»
  const sm = /^(.*?)\s*\(в\s+(.*)\)$/.exec(startIn);
  v.startInDur = sm ? sm[1] : startIn;
  v.startAt = sm ? sm[2] : "";
  v.finishedAt = s.text("finished_at");
  v.unloadPending = s.bool("finished");

  // --- циферблат: надпись, крупное значение, подпись ---
  const dial = { icon: "", label: "", value: "", sub: "", ring: 0, tone: "idle", wave: false };
  if (mode === "running" || mode === "paused" || mode === "action") {
    dial.label = mode === "paused" ? "Пауза" : mode === "action" ? "Ждёт вас" : "Осталось";
    dial.value = v.remainingMin > 0 ? fmtHM(v.remainingMin) : v.progress + "%";
    // пока машина ждёт действия, в end_time лежит прогноз «≈ …, если запустить сейчас», а не время окончания
    dial.sub = v.endText && mode !== "action" ? "до " + v.endText : "";
    dial.ring = v.progress;
    dial.tone = mode === "running" ? "run" : "warn";
    dial.wave = mode === "running" && v.phase !== "Сушка";
  } else if (mode === "delayed") {
    dial.label = "Старт через";
    dial.value = v.startInDur || "…";
    dial.sub = v.startAt ? "в " + v.startAt : "";
    dial.tone = "wait";
  } else if (mode === "starting") {
    dial.icon = "loader-circle";
    dial.value = "Запуск";
    dial.sub = "машина включается";
    dial.tone = "wait";
  } else if (mode === "aborting") {
    dial.icon = "loader-circle";
    dial.value = "Отмена";
    dial.sub = "машина завершает программу";
    dial.tone = "warn";
  } else if (s.bool("alarm") && (mode === "finished" || mode === "ready" || (v.unloadPending && mode === "off"))) {
    // авария важнее «чисто» и «готова»: причина написана ниже, в замечаниях
    dial.icon = "triangle-alert";
    dial.value = "Авария";
    dial.sub = "причина — ниже";
    dial.tone = "error";
  } else if (mode === "finished" || (v.unloadPending && (mode === "off" || mode === "ready"))) {
    dial.icon = "check";
    dial.value = "Чисто";
    dial.sub = "можно разгружать";
    dial.ring = 100;
    dial.tone = "ok";
  } else if (mode === "ready") {
    dial.icon = v.selected ? v.selected.hint.icon : "waves";
    dial.value = v.programTitle || "Готова";
    dial.sub = v.programTitle ? "готова к запуску" : "";
    dial.tone = "idle";
  } else if (mode === "off") {
    dial.icon = "power";
    dial.value = "Выключена";
    dial.tone = "off";
  } else if (mode === "error") {
    dial.icon = "triangle-alert";
    dial.value = "Ошибка";
    dial.sub = "смотрите дисплей машины";
    dial.tone = "error";
  } else if (mode === "offline") {
    dial.icon = "wifi-off";
    dial.value = "Нет связи";
    dial.tone = "off";
  } else {
    dial.value = "—";
    dial.tone = "off";
  }
  v.dial = dial;

  // --- заголовок под циферблатом ---
  if (mode === "offline") v.headline = v.link === "machine" ? "Машина не на связи" : "Нет связи";
  else if ((mode === "running" || mode === "paused") && v.programTitle) v.headline = stateText + " · " + v.programTitle;
  else v.headline = stateText || "Нет данных";

  // --- отложенный старт ---
  const finishAt = String(s.shown("finish_at") === undefined ? "" : s.shown("finish_at")).trim();
  v.hasDelay = s.has("delay_h");
  v.delayH = Math.round(parseFloat(s.shown("delay_h")) || 0);
  v.delayMax = s.meta("delay_h").max || 24;
  v.finishAt = finishAt;
  v.schedule = finishAt ? "finish" : v.delayH > 0 ? "delay" : "now";

  // --- главное действие ---
  const act = { kind: "start", label: "Запустить", hint: "", disabled: false };
  if (mode === "offline" || mode === "unknown") {
    act.disabled = true;
    act.hint = mode === "offline" ? "Нет связи с машиной" : "Нет данных о состоянии машины";
  } else if (mode === "starting") {
    act.kind = "cancel";
    act.label = "Отменить запуск";
  } else if (mode === "delayed") {
    act.kind = "abort";
    act.label = "Отменить отложенный старт";
    if (v.endText) act.hint = "Окончание в " + v.endText;
  } else if (mode === "aborting") {
    act.kind = "abort";
    act.label = "Отмена программы…";
    act.disabled = true;
  } else if (v.busy) {
    act.kind = "abort";
    act.label = "Отменить программу";
  } else if (mode === "error") {
    act.disabled = true;
    act.hint = "Машина сообщает об ошибке";
  } else {
    if (v.schedule === "delay") act.label = "Запустить через " + v.delayH + " ч";
    else if (v.schedule === "finish") act.label = "Запустить к " + finishAt;
    if (!v.selected) {
      act.disabled = true;
      act.hint = "Выберите программу";
    } else if (s.bool("door_open")) {
      act.disabled = true;
      act.hint = "Закройте дверь машины";
    } else if (s.has("remote_start") && !s.bool("remote_start") && s.bool("power")) {
      // правило само откажет в старте; кнопку не блокируем — у части моделей этого признака нет
      act.hint = "На машине не разрешён удалённый старт";
    } else if (v.endText) {
      act.hint = "Окончание " + v.endText.replace(/, если запустить сейчас$/, "");
    }
  }
  v.action = act;
  v.canPower = v.online && !(v.busy && v.power);
  v.powerHint = v.busy ? "Во время программы питание не отключается" : "";

  // --- что требует внимания ---
  const issues = [];
  if (s.bool("alarm")) issues.push({ id: "alarm", level: "error", text: s.text("alarm_text") || "Авария" });
  if (mode === "action") issues.push({ id: "action", level: "warn", text: "Машина ждёт действия — посмотрите на её дисплей" });
  if (s.bool("door_open")) issues.push({ id: "door", level: "info", text: "Дверь открыта" });
  if (s.bool("salt_empty")) issues.push({ id: "salt", level: "warn", text: "Закончилась соль" });
  else if (s.bool("salt_low")) issues.push({ id: "salt", level: "info", text: "Соль заканчивается" });
  if (s.bool("rinse_empty")) issues.push({ id: "rinse", level: "warn", text: "Закончился ополаскиватель" });
  else if (s.bool("rinse_low")) issues.push({ id: "rinse", level: "info", text: "Ополаскиватель заканчивается" });
  if (s.bool("filter_check")) issues.push({ id: "filter", level: "warn", text: "Проверьте фильтр" });
  if (s.bool("care_needed")) issues.push({ id: "care", level: "warn", text: "Пора запустить «Уход за машиной»" });
  v.issues = issues;
  v.attention = issues.filter((i) => i.level !== "info" || i.id !== "door").length;

  // --- расходники и уход ---
  function level(empty, low) { return s.bool(empty) ? 0 : s.bool(low) ? 1 : 2; }
  const LEVEL_TEXT = ["Закончилась", "Заканчивается", "В норме"];
  v.supplies = [
    { id: "salt", title: "Соль", level: level("salt_empty", "salt_low"),
      text: LEVEL_TEXT[level("salt_empty", "salt_low")] },
    { id: "rinse", title: "Ополаскиватель", level: level("rinse_empty", "rinse_low"),
      text: ["Закончился", "Заканчивается", "В норме"][level("rinse_empty", "rinse_low")] },
    { id: "filter", title: "Фильтр", level: s.bool("filter_check") ? 0 : 2,
      text: s.bool("filter_check") ? "Нужно проверить" : "В норме" },
    { id: "care", title: "Уход за машиной", level: s.bool("care_needed") ? 0 : 2,
      text: s.bool("care_needed") ? "Пора запустить"
        : s.num("care_runs") > 0 ? "Через " + plural(s.num("care_runs"), "цикл", "цикла", "циклов") : "Не требуется" }
  ];

  // --- сведения о машине ---
  const facts = [];
  function fact(id, label, value) { if (s.has(id) && value !== "") facts.push({ id, label, value }); }
  fact("door_open", "Дверь", s.bool("door_open") ? "Открыта" : "Закрыта");
  fact("remote_start", "Удалённый старт", s.bool("remote_start") ? "Разрешён" : "Не разрешён");
  if (s.num("silence_left") > 0) fact("silence_left", "Тихий режим", "ещё " + s.num("silence_left") + " мин");
  if (s.num("energy_forecast") > 0) fact("energy_forecast", "Прогноз расхода энергии", s.num("energy_forecast") + "%");
  if (s.num("water_forecast") > 0) fact("water_forecast", "Прогноз расхода воды", s.num("water_forecast") + "%");
  fact("finished_at", "Последняя мойка", s.text("finished_at"));
  fact("end_trigger", "Чем закончилась", s.text("end_trigger"));
  if (s.num("cycles") > 0) fact("cycles", "Всего запусков", String(s.num("cycles")));
  if (s.num("rssi")) fact("rssi", "Wi-Fi", s.num("rssi") + " dBm, " + wifiQuality(s.num("rssi")));
  fact("fw", "Прошивка", s.text("fw") + (s.bool("fw_update") ? " · доступно обновление" : ""));
  v.facts = facts;

  return v;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  const w = a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  return n + " " + w;
}
