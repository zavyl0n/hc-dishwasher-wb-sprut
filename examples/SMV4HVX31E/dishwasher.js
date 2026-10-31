// =====================================================================
//  Посудомоечная машина Bosch / Siemens (Home Connect) — локальное управление
//  через hcpy (Home Connect -> MQTT, https://github.com/hcpy2-0/hcpy), без облака.
//
//  Установка:  скопировать в /etc/wb-rules/dishwasher.js (wb-rules подхватит сам)
//  Логи:       journalctl -u wb-rules -f | grep dishwasher
//  Устройство в веб-интерфейсе: «Посудомоечная машина» (dishwasher/...)
//
//  Блок «МОДЕЛЬ» ниже собирается под конкретную машину скриптом tools/make_kit.py
//  из её devices.json. В этом файле — пример для Bosch SMV4HVX31E.
// =====================================================================

var CFG = {
  id: "dishwasher",                  // id виртуального устройства WB
  base: "homeconnect/dishwasher",    // префикс hcpy + поле "name" из devices.json (make_kit.py подставит сам)
  powerOnDelayMs: 5000,              // пауза после включения питания перед командой
  resyncMs: 15000,                   // через сколько вернуть контрол к реальному значению, если машина не приняла команду
  delayStepSec: 60,                  // шаг отложенного старта, сек, если DELAY_STEP = 0 (машина не примет — поставить 3600)
  resetDelayOnStart: true,           // сбрасывать «Отложить старт» и «Завершить к» после старта программы
  unloadReminderMin: 60,             // напомнить «посуда не выгружена» через N минут после окончания (0 — выкл)
  notifyStart: true,                 // уведомлять о старте / отложенном старте
  tgToken: "",                       // токен Telegram-бота; пусто — уведомления только в лог и в «Последнее событие»
  tgChatId: ""
};

// ===== BEGIN MODEL (сгенерировано tools/make_kit.py — правьте через генератор) =====
var MODEL = "SMV4HVX31E";
var DELAY_MAX = 86400;               // максимум отложенного старта, сек (из devices.json)
var DELAY_STEP = 0;                  // шаг отложенного старта из devices.json; 0 — брать CFG.delayStepSec
var UID = {
  PowerState: 539,
  AbortProgram: 512,
  StartInRelative: 558
};
var HAS = { door: true, remoteStart: true };   // есть ли у машины датчик двери и статус «удалённый старт разрешён»

// dur — примерная длительность (сек), пока машина сама не сообщит точную
var PROGRAMS = [
  { uid: 8196, key: "Eco50", title: "Эко 50°", dur: 13500 },
  { uid: 8195, key: "Auto2", title: "Авто 45–65°", dur: 8400 },
  { uid: 8192, key: "Intensiv70", title: "Интенсивная 70°", dur: 7300 },
  { uid: 8203, key: "Quick65", title: "Быстрая 65°", dur: 3600 },
  { uid: 8202, key: "NightWash", title: "Тихая (ночная)", dur: 12000 },
  { uid: 8200, key: "PreRinse", title: "Предварительное ополаскивание", dur: 900 },
  { uid: 8215, key: "MachineCare", title: "Уход за машиной", dur: 7200 },
  { uid: 32828, key: "001", title: "Избранное", dur: 7200 }
];

var OPTIONS = [
  { ctrl: "opt_variospeed", uid: 5127, key: "dishcare_dishwasher_option_variospeedplus", title: "Опция: VarioSpeed+ (быстрее)" },
  { ctrl: "opt_halfload", uid: 5124, key: "dishcare_dishwasher_option_halfload", title: "Опция: половинная загрузка" },
  { ctrl: "opt_extradry", uid: 5121, key: "dishcare_dishwasher_option_extradry", title: "Опция: Extra Dry (доп. сушка)" },
  { ctrl: "opt_silence", uid: 5136, key: "dishcare_dishwasher_option_silenceondemand", title: "Опция: тихий режим (Silence on demand)" }
];

// values: ключ — числовое значение для машины, [имя у машины, подпись]
var SETTINGS = [
  { ctrl: "set_infolight", uid: 4378, key: "dishcare_dishwasher_setting_infolight", kind: "bool",
    title: "Настройка: InfoLight (луч на полу)" },
  { ctrl: "set_extradry", uid: 4356, key: "dishcare_dishwasher_setting_extradry", kind: "bool",
    title: "Настройка: Extra Dry всегда" },
  { ctrl: "set_sound", uid: 4364, key: "dishcare_dishwasher_setting_soundlevelsignal", kind: "enum",
    title: "Настройка: громкость сигнала",
    values: { 0: ["Off", "Выкл"], 1: ["Low", "Тихо"], 2: ["Medium", "Средне"], 3: ["High", "Громко"] } },
  { ctrl: "set_rinseaid", uid: 4354, key: "dishcare_dishwasher_setting_rinseaid", kind: "enum",
    title: "Настройка: дозировка ополаскивателя",
    values: { 0: ["Off", "Выкл"], 1: ["R01", "1"], 2: ["R02", "2"], 3: ["R03", "3"], 4: ["R04", "4"], 5: ["R05", "5"], 6: ["R06", "6"] } },
  { ctrl: "set_hardness", uid: 4367, key: "dishcare_dishwasher_setting_waterhardness", kind: "enum",
    title: "Настройка: жёсткость воды",
    values: { 0: ["H00", "0 (без соли)"], 1: ["H01", "1"], 2: ["H02", "2"], 3: ["H03", "3"], 4: ["H04", "4"], 5: ["H05", "5"], 6: ["H06", "6"], 7: ["H07", "7"] } },
  { ctrl: "set_hotwater", uid: 4357, key: "dishcare_dishwasher_setting_hotwater", kind: "enum",
    title: "Настройка: подключение воды",
    values: { 0: ["ColdWater", "Холодная"], 1: ["HotWater", "Горячая"] } },
  { ctrl: "set_turbidity", uid: 4355, key: "dishcare_dishwasher_setting_sensitivityturbidity", kind: "enum",
    title: "Настройка: датчик загрязнения",
    values: { 0: ["Standard", "Стандарт"], 1: ["Sensitive", "Чувствительный"], 2: ["VerySensitive", "Очень чувствительный"] } },
  { ctrl: "set_ecodefault", uid: 4363, key: "dishcare_dishwasher_setting_ecoasdefault", kind: "enum",
    title: "Настройка: программа при включении",
    values: { 0: ["LastProgram", "Последняя"], 1: ["EcoAsDefault", "Эко 50°"] } },
  { ctrl: "set_silencetime", uid: 4382, key: "dishcare_dishwasher_setting_silenceondemanddefaulttime", kind: "num",
    title: "Настройка: длительность тихого режима", scale: 60, min: 60, max: 1800, units: "min" },
  { ctrl: "set_remotelevel", uid: 15, key: "bsh_common_setting_remotecontrollevel", kind: "enum",
    title: "Настройка: удалённое управление",
    values: { 0: ["Monitoring", "Только мониторинг"], 1: ["ManualRemoteStart", "Старт по кнопке на машине"], 2: ["PermanentRemoteStart", "Постоянный удалённый старт"] } },
  { ctrl: "set_cloud", uid: 3, key: "bsh_common_setting_allowbackendconnection", kind: "bool",
    title: "Настройка: связь с облаком Home Connect" }
];
// ===== END MODEL =====

// События hcpy (event/...): ctrl — индикатор, alarm — авария, notify — текст уведомления
var EVENTS = {
  bsh_common_event_aquastopoccured:                              { ctrl: "aquastop", alarm: true, notify: "❗ Сработал AquaStop — возможна протечка!" },
  bsh_common_event_lowwaterpressure:                             { alarm: true, notify: "❗ Низкое давление воды" },
  dishcare_dishwasher_event_drainpumpblocked:                    { alarm: true, notify: "❗ Заблокирован сливной насос" },
  dishcare_dishwasher_event_drainingnotpossible:                 { alarm: true, notify: "❗ Слив невозможен" },
  dishcare_dishwasher_event_internalerror:                       { alarm: true, notify: "❗ Внутренняя ошибка машины" },
  dishcare_dishwasher_event_lowvoltage:                          { alarm: true, notify: "❗ Низкое напряжение питания" },
  dishcare_dishwasher_event_waterheatercalcified:                { alarm: true, notify: "⚠ Нагреватель в накипи — нужен уход за машиной" },
  bsh_common_event_programaborted:                               { notify: "⛔ Программа прервана" },
  bsh_common_event_confirmpermanentremotestart:                  { notify: "⚠ Подтвердите постоянный удалённый старт на машине" },
  dishcare_dishwasher_event_saltlack:                            { ctrl: "salt_empty",   notify: "⚠ Закончилась соль" },
  dishcare_dishwasher_event_saltnearlyempty:                     { ctrl: "salt_low" },
  dishcare_dishwasher_event_rinseaidlack:                        { ctrl: "rinse_empty",  notify: "⚠ Закончился ополаскиватель" },
  dishcare_dishwasher_event_rinseaidnearlyempty:                 { ctrl: "rinse_low" },
  dishcare_dishwasher_event_checkfiltersystem:                   { ctrl: "filter_check", notify: "⚠ Проверьте фильтр" },
  dishcare_dishwasher_event_smartfiltercleaningreminder:         { ctrl: "filter_check" },
  dishcare_dishwasher_event_machinecarereminder:                 { ctrl: "care_needed",  notify: "⚠ Пора запустить «Уход за машиной»" },
  dishcare_dishwasher_event_machinecareandfiltercleaningreminder:{ ctrl: "care_needed" },
  bsh_common_event_softwareupdateavailable:                      { ctrl: "fw_update" },
  bsh_common_event_softwaredownloadavailable:                    { ctrl: "fw_update" }
};
var FLAG_CTRLS = ["aquastop", "salt_empty", "salt_low", "rinse_empty", "rinse_low", "filter_check", "care_needed", "fw_update"];

var OPSTATE_RU = {
  Inactive: "Выключена", Ready: "Готова", DelayedStart: "Отложенный старт", Run: "Мойка",
  Pause: "Пауза", ActionRequired: "Требуется действие", Finished: "Завершено", Error: "Ошибка", Aborting: "Отмена программы"
};
var PHASE_RU = { None: "", PreRinse: "Предополаскивание", MainWash: "Мойка", FinalRinse: "Ополаскивание", Drying: "Сушка" };
var ENDTRIGGER_RU = {
  ProgramFinished: "Завершена нормально", ProgramAbortedByUser: "Отменена пользователем",
  ProgramAbortedByAppliance: "Прервана машиной", ProgramAbortedByApplianceCriticalError: "Прервана из-за ошибки"
};

// ---------------------------------------------------------------------
//  Состояние и утилиты
// ---------------------------------------------------------------------
var D = CFG.id;
var hc = {};        // последние значения state/* от hcpy (как строки)
var ev = {};        // последние значения event/* (Off / Present / Confirmed)
var learnedDur = {}; // реальная длительность программ, которую сообщила машина
var handlers = {};  // key state/* -> [функции]
var unloadTimer = null;

function on(key, fn) { (handlers[key] = handlers[key] || []).push(fn); }
function isTrue(v) { return v === true || v === 1 || v === "True" || v === "true" || v === "1"; }
function toInt(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
function pad2(n) { return (n < 10 ? "0" : "") + n; }
function isRunning(st) { return st === "Run" || st === "Pause" || st === "DelayedStart"; }
// ActionRequired бывает посреди программы (например, открыли дверь) — выключать питание нельзя
function isBusy(st) { return isRunning(st) || st === "ActionRequired"; }

function progByKey(k) {
  for (var i = 0; i < PROGRAMS.length; i++) if (PROGRAMS[i].key === k) return PROGRAMS[i];
  return null;
}
function progByUid(u) {
  u = toInt(u);
  for (var i = 0; i < PROGRAMS.length; i++) if (PROGRAMS[i].uid === u) return PROGRAMS[i];
  return null;
}

function fmtDur(sec) {
  var min = Math.max(0, Math.round(sec / 60)), h = Math.floor(min / 60), m = min % 60;
  return h ? h + " ч " + pad2(m) + " мин" : m + " мин";
}
function fmtClock(ts) {
  var d = new Date(ts), now = new Date();
  var days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
                         new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + (days === 1 ? " завтра" : days > 1 ? " +" + days + " дн" : "");
}
function fmtNow() {
  var d = new Date();
  return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function setCtrl(ctrl, value) {
  if (dev[D + "/" + ctrl] !== value) dev[D + "/" + ctrl] = value;
}

function note(text, push) {
  log.info("[dishwasher] " + text);
  setCtrl("last_message", fmtNow() + "  " + text);
  if (push && CFG.tgToken && CFG.tgChatId && typeof Notify.sendTelegramMessage === "function") {
    Notify.sendTelegramMessage(CFG.tgToken, CFG.tgChatId, "Посудомойка: " + text);
  }
}

// ---------------------------------------------------------------------
//  Команды в hcpy
// ---------------------------------------------------------------------
function cmd(topic, payload) {
  var s = JSON.stringify(payload);
  log.info("[dishwasher] -> " + topic + " " + s);
  publish(CFG.base + "/" + topic, s);
}
function hcSet(uid, value) { cmd("set", { uid: uid, value: value }); }

// Включить машину (если выключена) и затем выполнить fn
function withPower(fn) {
  if (hc.bsh_common_setting_powerstate === "On") { fn(); return; }
  hcSet(UID.PowerState, "On");
  setTimeout(fn, CFG.powerOnDelayMs);
}

function programDuration(p) {
  if (!p) return 0;
  return learnedDur[p.key] || p.dur;
}

// Момент «Завершить к» (мс); 0 — поле пустое; null — ошибка ввода
function finishTarget(silent) {
  var fin = String(dev[D + "/finish_at"] || "").trim();
  if (!fin) return 0;
  var m = /^(\d{1,2})[:.](\d{2})$/.exec(fin);
  if (!m || +m[1] > 23 || +m[2] > 59) {
    if (!silent) note("Неверное время «Завершить к»: «" + fin + "», нужно ЧЧ:ММ");
    return null;
  }
  var now = new Date(), t = new Date(now.getTime());
  t.setHours(+m[1], +m[2], 0, 0);
  if (t.getTime() <= now.getTime()) {
    // завтра в ЧЧ:ММ по календарю, а не +24 ч: в ночь перевода часов это разное время
    t.setDate(t.getDate() + 1);
    t.setHours(+m[1], +m[2], 0, 0);
  }
  return t.getTime();
}

// Желаемая задержка старта в секундах по «Завершить к» или «Отложить старт, ч»,
// с шагом машины, но без её ограничения DELAY_MAX; null — ошибка ввода
function wantedDelay(silent) {
  var target = finishTarget(silent);
  if (target === null) return null;
  var delay = target
    ? Math.floor((target - Date.now()) / 1000) - programDuration(progByUid(dev[D + "/program"]))
    : toInt(dev[D + "/delay_h"]) * 3600;
  if (delay <= 0) return 0;
  var step = DELAY_STEP || CFG.delayStepSec;
  return Math.floor(delay / step) * step;
}

function calcDelay(silent) {
  var delay = wantedDelay(silent);
  return delay === null ? null : Math.min(delay, DELAY_MAX);
}

function startProgram() {
  if (dev[D + "/online"] !== true) { note("Старт невозможен: нет связи с машиной (hcpy)", true); return false; }
  if (isBusy(hc.bsh_common_status_operationstate)) { note("Программа уже запущена"); return false; }
  var p = progByUid(dev[D + "/program"]);
  if (!p) { note("Старт невозможен: не выбрана программа"); return false; }
  var delay = calcDelay(false);
  if (delay === null) return false;
  // к «Завершить к» программа уже не успевает — запускаем сразу, но предупреждаем
  var late = "", target = finishTarget(true);
  var endNow = Date.now() + programDuration(p) * 1000;
  if (target && delay === 0 && endNow > target) {
    late = " — к " + fmtClock(target) + " не успеет, окончание ≈ " + fmtClock(endNow);
  } else if (wantedDelay(true) > DELAY_MAX) {
    late = " — дольше машина не откладывает" + (target ? ", окончание ≈ " + fmtClock(endNow + delay * 1000) : "");
  }

  var opts = [];
  OPTIONS.forEach(function (o) {
    if (dev[D + "/" + o.ctrl] === true) opts.push({ uid: o.uid, value: true });
  });
  if (delay > 0) {
    if (!UID.StartInRelative) { note("Отложенный старт не поддерживается этой моделью"); return false; }
    opts.push({ uid: UID.StartInRelative, value: delay });
  }
  var payload = { program: p.uid };
  if (opts.length) payload.options = opts;

  function blocked() {
    if (HAS.door && hc.bsh_common_status_doorstate === "Open") return "дверь открыта";
    if (HAS.remoteStart && !isTrue(hc.bsh_common_status_remotecontrolstartallowed)) {
      return "удалённый старт не разрешён — нажмите Remote Start на машине";
    }
    return "";
  }
  // машина уже включена — проверяем сразу, чтобы кнопка в Sprut.hub/WB сразу вернулась назад
  if (hc.bsh_common_setting_powerstate === "On" && blocked()) {
    note("Старт отменён: " + blocked(), true);
    return false;
  }
  withPower(function () {
    if (blocked()) { note("Старт отменён: " + blocked(), true); return; }
    cmd("activeProgram", payload);
    note("Команда старта: " + p.title + (delay > 0 ? ", отложенный на " + fmtDur(delay) : "") + late);
  });
}

function abortProgram() {
  if (!isBusy(hc.bsh_common_status_operationstate)) { note("Нечего отменять: программа не запущена"); return false; }
  if (!UID.AbortProgram) { note("Отмена программы не поддерживается этой моделью — отмените на машине"); return false; }
  hcSet(UID.AbortProgram, true);
  note("Команда отмены программы");
}

function selectProgram(p) {
  if (isBusy(hc.bsh_common_status_operationstate)) {
    note("Программу нельзя сменить во время мойки");
    return false;
  }
  withPower(function () { cmd("selectedProgram", { program: p.uid }); });
}

function applyOption(o, val) {
  if (isBusy(hc.bsh_common_status_operationstate)) {
    hcSet(o.uid, val);                       // изменение опции у идущей программы
    return;
  }
  var p = progByUid(dev[D + "/program"]) || progByKey(hc.bsh_common_root_selectedprogram);
  if (!p) { note("Сначала выберите программу"); return false; }
  withPower(function () {
    cmd("selectedProgram", { program: p.uid, options: [{ uid: o.uid, value: val }] });
  });
}

// ---------------------------------------------------------------------
//  Время: осталось / старт через / окончание
// ---------------------------------------------------------------------
function updateTimes() {
  var st = hc.bsh_common_status_operationstate;
  var rem = toInt(hc.bsh_common_option_remainingprogramtime);
  var sir = toInt(hc.bsh_common_option_startinrelative);
  var now = Date.now();
  var sel = progByKey(hc.bsh_common_root_selectedprogram);
  var end = "", startIn = "";

  // запоминаем реальную длительность выбранной программы (с учётом опций)
  if (st === "Ready" && sel && rem > 0) learnedDur[sel.key] = rem;

  if (st === "Run" || st === "Pause") {
    end = fmtClock(now + rem * 1000);
  } else if (st === "DelayedStart") {
    startIn = fmtDur(sir) + " (в " + fmtClock(now + sir * 1000) + ")";
    end = fmtClock(now + (sir + rem) * 1000);
  } else if (dev[D + "/online"] === true) {
    var d = calcDelay(true);
    var p = progByUid(dev[D + "/program"]);
    if (d !== null && p) end = "≈ " + fmtClock(now + (d + programDuration(p)) * 1000) + ", если запустить сейчас";
  }

  setCtrl("remaining", isRunning(st) && rem > 0 ? fmtDur(rem) : "");
  setCtrl("remaining_min", isRunning(st) ? Math.round(rem / 60) : 0);
  setCtrl("remaining_sec", st === "DelayedStart" ? sir + rem : isRunning(st) ? rem : 0);
  setCtrl("start_in", startIn);
  setCtrl("end_time", end);
}

// ---------------------------------------------------------------------
//  Аварии и индикаторы из событий
// ---------------------------------------------------------------------
function errorCodes() {
  try {
    var list = JSON.parse(hc.bsh_common_status_errorcodeslist || "{}").list || [];
    return list.map(function (e) { return typeof e === "object" ? JSON.stringify(e) : String(e); }).join(", ");
  } catch (e) {
    return "";
  }
}

function recomputeFlags() {
  var flags = {}, alarms = [];
  FLAG_CTRLS.forEach(function (c) { flags[c] = false; });
  Object.keys(EVENTS).forEach(function (k) {
    var def = EVENTS[k], t = ev[k], active = !!t && t !== "Off";
    if (def.ctrl) flags[def.ctrl] = flags[def.ctrl] || active;
    if (def.alarm && active) alarms.push(def.notify.replace(/^\S+\s/, ""));
  });
  var errs = errorCodes();
  if (errs) alarms.push("Коды ошибок: " + errs);
  FLAG_CTRLS.forEach(function (c) { setCtrl(c, flags[c]); });
  // уровень в % для Sprut.hub / HomeKit: 100 — норма, 10 — заканчивается, 0 — нет
  setCtrl("salt_level", flags.salt_empty ? 0 : flags.salt_low ? 10 : 100);
  setCtrl("rinse_level", flags.rinse_empty ? 0 : flags.rinse_low ? 10 : 100);
  setCtrl("alarm", alarms.length > 0);
  setCtrl("alarm_text", alarms.length ? alarms.join("; ") : "Нет");
}

// ---------------------------------------------------------------------
//  Виртуальное устройство
// ---------------------------------------------------------------------
var cells = {};
function c(id, def) { cells[id] = def; }

var progEnum = {};
PROGRAMS.forEach(function (p) {
  progEnum[p.uid] = { en: p.key, ru: p.title };
  p.ctrl = "prog_" + p.key.toLowerCase();    // отдельный выключатель программы (для Sprut.hub / HomeKit / Алисы)
});

c("online",          { title: "Связь с машиной",          type: "switch", value: false, readonly: true });
c("power",           { title: "Питание",                  type: "switch", value: false });
c("run",             { title: "Мойка (вкл — старт, выкл — отмена)", type: "switch", value: false });
c("state",           { title: "Состояние",                type: "text",   value: "" });
c("running",         { title: "Программа запущена",       type: "switch", value: false, readonly: true });
c("finished",        { title: "Мойка завершена, не разгружена", type: "switch", value: false, readonly: true });
c("door_open",       { title: "Дверь открыта",            type: "switch", value: false, readonly: true });
c("program",         { title: "Программа",                type: "value",  value: PROGRAMS[0].uid, readonly: false, enum: progEnum });
PROGRAMS.forEach(function (p) {
  c(p.ctrl, { title: "Программа: " + p.title, type: "switch", value: false });
});
c("active_program",  { title: "Выполняется",              type: "text",   value: "" });
c("phase",           { title: "Фаза",                     type: "text",   value: "" });
c("progress",        { title: "Прогресс",                 type: "value",  value: 0, units: "%" });
c("remaining",       { title: "Осталось",                 type: "text",   value: "" });
c("remaining_min",   { title: "Осталось, мин",            type: "value",  value: 0, units: "min" });
c("remaining_sec",   { title: "До окончания, с (с учётом отложенного старта)", type: "value", value: 0, units: "s" });
c("start_in",        { title: "Старт через",              type: "text",   value: "" });
c("end_time",        { title: "Окончание",                type: "text",   value: "" });
OPTIONS.forEach(function (o) {
  c(o.ctrl, { title: o.title, type: "switch", value: false });
});
if (UID.StartInRelative) {
  c("delay_h",       { title: "Отложить старт, ч",        type: "range",  value: 0, min: 0, max: Math.max(1, Math.floor(DELAY_MAX / 3600)) });
  c("finish_at",     { title: "Завершить к (ЧЧ:ММ, пусто — не использовать)", type: "text", value: "", readonly: false });
}
c("start",           { title: "▶ Старт",                  type: "pushbutton" });
c("abort",           { title: "■ Отменить программу",     type: "pushbutton" });
c("remote_start",    { title: "Удалённый старт разрешён", type: "switch", value: false, readonly: true });
c("energy_forecast", { title: "Прогноз расхода энергии",  type: "value",  value: 0, units: "%" });
c("water_forecast",  { title: "Прогноз расхода воды",     type: "value",  value: 0, units: "%" });
c("alarm",           { title: "Авария",                   type: "alarm",  value: false });
c("alarm_text",      { title: "Аварии",                   type: "text",   value: "Нет" });
c("aquastop",        { title: "AquaStop (протечка)",      type: "alarm",  value: false });
c("salt_empty",      { title: "Нет соли",                 type: "alarm",  value: false });
c("salt_low",        { title: "Соль заканчивается",       type: "switch", value: false, readonly: true });
c("rinse_empty",     { title: "Нет ополаскивателя",       type: "alarm",  value: false });
c("rinse_low",       { title: "Ополаскиватель заканчивается", type: "switch", value: false, readonly: true });
c("salt_level",      { title: "Соль, уровень",            type: "value",  value: 100, units: "%" });
c("rinse_level",     { title: "Ополаскиватель, уровень",  type: "value",  value: 100, units: "%" });
c("filter_check",    { title: "Проверить фильтр",         type: "switch", value: false, readonly: true });
c("care_needed",     { title: "Нужен уход за машиной",    type: "switch", value: false, readonly: true });
c("care_runs",       { title: "Циклов до ухода за машиной", type: "value", value: 0 });
c("silence_left",    { title: "Тихий режим: осталось",    type: "value",  value: 0, units: "min" });
c("end_trigger",     { title: "Последняя программа",      type: "text",   value: "" });
c("finished_at",     { title: "Последняя мойка завершена", type: "text",  value: "" });
c("cycles",          { title: "Всего запусков",           type: "value",  value: 0 });
c("last_message",    { title: "Последнее событие",        type: "text",   value: "" });
SETTINGS.forEach(function (s) {
  var def = { title: s.title, value: 0 };
  if (s.kind === "bool") {
    def.type = "switch";
    def.value = false;
  } else if (s.kind === "enum") {
    def.type = "value";
    def.readonly = false;
    def.enum = {};
    Object.keys(s.values).forEach(function (k) { def.enum[k] = { en: s.values[k][0], ru: s.values[k][1] }; });
  } else {
    def.type = "range";
    def.min = s.min / s.scale;
    def.max = s.max / s.scale;
    def.value = def.min;                     // до первых данных от машины
    def.units = s.units;
  }
  c(s.ctrl, def);
});
c("rssi",            { title: "Wi-Fi сигнал",             type: "value",  value: 0, units: "dBm" });
c("fw",              { title: "Прошивка",                 type: "text",   value: "" });
c("fw_update",       { title: "Доступно обновление ПО",   type: "switch", value: false, readonly: true });

defineVirtualDevice(D, { title: "Посудомоечная машина", cells: cells });

// ---------------------------------------------------------------------
//  Двусторонняя привязка: контрол <-> значение машины
//  fromHc(строка от машины) -> значение контрола или null (неизвестно)
//  send(значение контрола) — отправить в машину; вернуть false, если команда отменена
// ---------------------------------------------------------------------
function bind(ctrl, key, fromHc, send) {
  on(key, function (v) {
    var x = fromHc(v);
    if (x !== null) setCtrl(ctrl, x);
  });
  defineRule("dishwasher_" + ctrl, {
    whenChanged: D + "/" + ctrl,
    then: function (val) {
      var cur = fromHc(hc[key]);
      if (cur === val) return;               // эхо от машины, а не действие пользователя
      if (send(val) === false) {
        if (cur !== null) setCtrl(ctrl, cur);
        return;
      }
      // если машина не приняла команду — вернуть контрол к реальному значению
      setTimeout(function () {
        var real = fromHc(hc[key]);
        if (real !== null && dev[D + "/" + ctrl] !== real) {
          log.warning("[dishwasher] машина не применила " + ctrl + "=" + val + ", возвращаю " + real);
          setCtrl(ctrl, real);
        }
      }, CFG.resyncMs);
    }
  });
}

bind("power", "bsh_common_setting_powerstate",
  function (v) { return v === "On" ? true : v === "Off" ? false : null; },
  function (val) {
    var st = hc.bsh_common_status_operationstate;
    if (!val && isRunning(st)) {
      note("Выключение отменено: идёт программа (используйте «Отменить программу»)");
      return false;
    }
    if (!val && isBusy(st)) {
      note("Выключение отменено: машина требует действия — посмотрите на дисплей (выключить можно кнопкой на машине)");
      return false;
    }
    hcSet(UID.PowerState, val ? "On" : "Off");
  });

bind("program", "bsh_common_root_selectedprogram",
  function (v) { var p = progByKey(v); return p ? p.uid : null; },
  function (val) {
    var p = progByUid(val);
    return p ? selectProgram(p) : false;
  });

// выключатели программ работают как радиокнопки: включение выбирает программу, выключить нельзя
PROGRAMS.forEach(function (p) {
  bind(p.ctrl, "bsh_common_root_selectedprogram",
    function (v) { return v === undefined ? null : v === p.key; },
    function (val) { return val ? selectProgram(p) : false; });
});

// «Мойка»: включение — старт выбранной программы с опциями и отложенным стартом, выключение — отмена
bind("run", "bsh_common_status_operationstate",
  function (v) { return v === undefined ? null : isBusy(v); },
  function (val) { return val ? startProgram() : abortProgram(); });

OPTIONS.forEach(function (o) {
  bind(o.ctrl, o.key,
    function (v) { return v === undefined ? null : isTrue(v); },
    function (val) { return applyOption(o, val); });
});

SETTINGS.forEach(function (s) {
  bind(s.ctrl, s.key,
    function (v) {
      if (v === undefined) return null;
      if (s.kind === "bool") return isTrue(v);
      if (s.kind === "num") return Math.round(toInt(v) / s.scale);
      var keys = Object.keys(s.values);
      for (var i = 0; i < keys.length; i++) if (s.values[keys[i]][0] === v) return toInt(keys[i]);
      return null;
    },
    function (val) {
      if (s.kind === "bool") hcSet(s.uid, !!val);
      else if (s.kind === "num") hcSet(s.uid, Math.max(s.min, Math.min(s.max, Math.round(val) * s.scale)));
      else if (!s.values.hasOwnProperty(String(toInt(val)))) {
        note("Недопустимое значение для «" + s.title.replace(/^Настройка: /, "") + "»: " + val +
             ", можно: " + Object.keys(s.values).join(", "));
        return false;
      } else hcSet(s.uid, toInt(val));
    });
});

defineRule("dishwasher_start", { whenChanged: D + "/start", then: startProgram });
defineRule("dishwasher_abort", { whenChanged: D + "/abort", then: abortProgram });
defineRule("dishwasher_preview", {
  whenChanged: UID.StartInRelative ? [D + "/program", D + "/delay_h", D + "/finish_at"] : [D + "/program"],
  then: updateTimes
});

// ---------------------------------------------------------------------
//  Обработка состояния машины
// ---------------------------------------------------------------------
on("bsh_common_status_operationstate", function (v, prev, retained) {
  setCtrl("state", OPSTATE_RU[v] || String(v));
  setCtrl("running", isBusy(v));
  updateTimes();
  if (retained || prev === undefined || prev === v) return;
  if (isRunning(v)) setCtrl("finished", false);
  if (isBusy(v) && !isBusy(prev) && CFG.resetDelayOnStart && UID.StartInRelative) {
    // отложенный старт задаётся на один запуск: следующий старт (например, плиткой в Sprut.hub) — сразу
    setCtrl("delay_h", 0);
    setCtrl("finish_at", "");
  }

  var p = progByKey(hc.bsh_common_root_activeprogram) || progByKey(hc.bsh_common_root_selectedprogram);
  var name = p ? p.title : "";

  if (v === "Run" && prev !== "Pause" && prev !== "ActionRequired") {
    setTimeout(function () {   // дождаться актуального оставшегося времени
      note("▶ Мойка началась: " + name + ", окончание ≈ " +
           fmtClock(Date.now() + toInt(hc.bsh_common_option_remainingprogramtime) * 1000), CFG.notifyStart);
    }, 3000);
  } else if (v === "DelayedStart") {
    setTimeout(function () {
      var sir = toInt(hc.bsh_common_option_startinrelative);
      var rem = toInt(hc.bsh_common_option_remainingprogramtime);
      note("⏰ Отложенный старт: " + name + ", начнётся в " + fmtClock(Date.now() + sir * 1000) +
           ", окончание ≈ " + fmtClock(Date.now() + (sir + rem) * 1000), CFG.notifyStart);
    }, 3000);
  } else if (v === "Finished") {
    setCtrl("finished_at", fmtNow() + (name ? " (" + name + ")" : ""));
    setCtrl("finished", true);
    note("✅ Мойка завершена" + (name ? ": " + name : "") + ". Можно разгружать", true);
    if (unloadTimer) clearTimeout(unloadTimer);
    if (CFG.unloadReminderMin > 0) {
      unloadTimer = setTimeout(function () {
        unloadTimer = null;
        if (hc.bsh_common_status_doorstate !== "Open") note("Посуда чистая, но ещё не выгружена", true);
      }, CFG.unloadReminderMin * 60000);
    }
  } else if (v === "ActionRequired") {
    note("⚠ Машина требует действия — посмотрите на дисплей", true);
  } else if (v === "Error") {
    note("❗ Ошибка посудомоечной машины", true);
  }
});

on("bsh_common_status_doorstate", function (v, prev, retained) {
  setCtrl("door_open", v === "Open");
  if (v !== "Open") return;
  setCtrl("finished", false);
  if (unloadTimer) { clearTimeout(unloadTimer); unloadTimer = null; }
});
on("bsh_common_root_selectedprogram", function () { updateTimes(); });
on("bsh_common_root_activeprogram", function (v) {
  var p = progByKey(v);
  setCtrl("active_program", p ? p.title : (v && v !== "None" ? String(v) : ""));
});
on("dishcare_dishwasher_status_programphase", function (v) {
  setCtrl("phase", PHASE_RU.hasOwnProperty(v) ? PHASE_RU[v] : String(v));
});
on("bsh_common_option_programprogress",     function (v) { setCtrl("progress", toInt(v)); });
on("bsh_common_option_remainingprogramtime", function () { updateTimes(); });
on("bsh_common_option_startinrelative",     function () { updateTimes(); });
on("bsh_common_option_energyforecast",      function (v) { setCtrl("energy_forecast", toInt(v)); });
on("bsh_common_option_waterforecast",       function (v) { setCtrl("water_forecast", toInt(v)); });
on("bsh_common_status_remotecontrolstartallowed", function (v) { setCtrl("remote_start", isTrue(v)); });
on("dishcare_dishwasher_status_machinecarereminder_remainingprogramruns", function (v) { setCtrl("care_runs", toInt(v)); });
on("dishcare_dishwasher_status_silenceondemandremainingtime", function (v) { setCtrl("silence_left", Math.round(toInt(v) / 60)); });
on("bsh_common_status_errorcodeslist",      function () { recomputeFlags(); });
on("bsh_common_status_programrundetail_endtrigger", function (v) { setCtrl("end_trigger", ENDTRIGGER_RU[v] || String(v)); });
on("bsh_common_status_program_all_count_started", function (v) { setCtrl("cycles", toInt(v)); });
on("rssi",      function (v) { setCtrl("rssi", toInt(v)); });
on("swversion", function (v) { setCtrl("fw", String(v)); });

// ---------------------------------------------------------------------
//  Подписки MQTT
// ---------------------------------------------------------------------
trackMqtt(CFG.base + "/state/+", function (msg) {
  var key = msg.topic.split("/").pop();
  var prev = hc[key];
  hc[key] = msg.value;
  (handlers[key] || []).forEach(function (fn) {
    try {
      fn(msg.value, prev, msg.retained);
    } catch (e) {
      log.error("[dishwasher] ошибка обработки " + key + ": " + e);
    }
  });
});

trackMqtt(CFG.base + "/event/+", function (msg) {
  var key = msg.topic.split("/").pop();
  var t;
  try { t = JSON.parse(msg.value).event_type; } catch (e) { t = msg.value; }
  var prev = ev[key];
  ev[key] = t;
  recomputeFlags();
  var def = EVENTS[key];
  if (def && def.notify && !msg.retained && prev !== t && t === "Present") {
    note(def.notify, true);
  }
});

// Связь: <base>/LWT hcpy обновляет, когда подключается к машине или теряет её,
// а homeconnect/LWT брокер ставит в offline, если завершился сам процесс hcpy.
// Без второго топика после остановки hcpy «Связь с машиной» оставалась бы включённой.
var link = { bridge: null, device: null };   // null — ещё не знаем
function onLwt(which, msg) {
  link[which] = msg.value === "online";
  var online = link.bridge !== false && link.device === true;
  if (!msg.retained && dev[D + "/online"] !== online) {
    note(online ? "Связь с машиной восстановлена" :
         which === "bridge" ? "Потеряна связь с машиной: служба hcpy не работает" : "Потеряна связь с машиной");
  }
  setCtrl("online", online);
  updateTimes();
}
trackMqtt(CFG.base.replace(/[^\/]*$/, "") + "LWT", function (msg) { onLwt("bridge", msg); });
trackMqtt(CFG.base + "/LWT", function (msg) { onLwt("device", msg); });

// обновлять «Окончание» по ходу времени
setInterval(updateTimes, 30000);
