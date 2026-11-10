// Имитация посудомойки для демо-режима и разработки без контроллера.
// Публикует те же топики, что правило rule/dishwasher.js (пример SMV4HVX31E), и отвечает на
// команды /on в том же духе: отказы, питание перед стартом, отложенный старт, ход программы.
// Состав и типы контролов сверяет с настоящим правилом tests/web_sim.test.js.

const PROGRAMS = [
  { uid: 8196,  key: "Eco50",       title: "Эко 50°",                       dur: 13500 },
  { uid: 8195,  key: "Auto2",       title: "Авто 45–65°",                   dur: 8400 },
  { uid: 8192,  key: "Intensiv70",  title: "Интенсивная 70°",               dur: 7300 },
  { uid: 8203,  key: "Quick65",     title: "Быстрая 65°",                   dur: 3600 },
  { uid: 8202,  key: "NightWash",   title: "Тихая (ночная)",                dur: 12000 },
  { uid: 8200,  key: "PreRinse",    title: "Предварительное ополаскивание", dur: 900 },
  { uid: 8215,  key: "MachineCare", title: "Уход за машиной",               dur: 7200 },
  { uid: 32828, key: "001",         title: "Избранное",                     dur: 7200 }
];
const OPTIONS = [
  { ctrl: "opt_variospeed", title: "Опция: VarioSpeed+ (быстрее)" },
  { ctrl: "opt_halfload",   title: "Опция: половинная загрузка" },
  { ctrl: "opt_extradry",   title: "Опция: Extra Dry (доп. сушка)" },
  { ctrl: "opt_silence",    title: "Опция: тихий режим (Silence on demand)" }
];
const SETTINGS = [
  { ctrl: "set_infolight", kind: "bool", title: "Настройка: InfoLight (луч на полу)", value: true },
  { ctrl: "set_extradry", kind: "bool", title: "Настройка: Extra Dry всегда", value: false },
  { ctrl: "set_sound", kind: "enum", title: "Настройка: громкость сигнала", value: 2,
    values: { 0: ["Off", "Выкл"], 1: ["Low", "Тихо"], 2: ["Medium", "Средне"], 3: ["High", "Громко"] } },
  { ctrl: "set_rinseaid", kind: "enum", title: "Настройка: дозировка ополаскивателя", value: 5,
    values: { 0: ["Off", "Выкл"], 1: ["R01", "1"], 2: ["R02", "2"], 3: ["R03", "3"], 4: ["R04", "4"], 5: ["R05", "5"], 6: ["R06", "6"] } },
  { ctrl: "set_hardness", kind: "enum", title: "Настройка: жёсткость воды", value: 4,
    values: { 0: ["H00", "0 (без соли)"], 1: ["H01", "1"], 2: ["H02", "2"], 3: ["H03", "3"], 4: ["H04", "4"], 5: ["H05", "5"], 6: ["H06", "6"], 7: ["H07", "7"] } },
  { ctrl: "set_hotwater", kind: "enum", title: "Настройка: подключение воды", value: 0,
    values: { 0: ["ColdWater", "Холодная"], 1: ["HotWater", "Горячая"] } },
  { ctrl: "set_turbidity", kind: "enum", title: "Настройка: датчик загрязнения", value: 0,
    values: { 0: ["Standard", "Стандарт"], 1: ["Sensitive", "Чувствительный"], 2: ["VerySensitive", "Очень чувствительный"] } },
  { ctrl: "set_ecodefault", kind: "enum", title: "Настройка: программа при включении", value: 1,
    values: { 0: ["LastProgram", "Последняя"], 1: ["EcoAsDefault", "Эко 50°"] } },
  { ctrl: "set_silencetime", kind: "num", title: "Настройка: длительность тихого режима", value: 30, min: 1, max: 30, units: "min" },
  { ctrl: "set_remotelevel", kind: "enum", title: "Настройка: удалённое управление", value: 2,
    values: { 0: ["Monitoring", "Только мониторинг"], 1: ["ManualRemoteStart", "Старт по кнопке на машине"], 2: ["PermanentRemoteStart", "Постоянный удалённый старт"] } },
  { ctrl: "set_cloud", kind: "bool", title: "Настройка: связь с облаком Home Connect", value: false }
];
const OPSTATE_RU = {
  Inactive: "Выключена", Ready: "Готова", DelayedStart: "Отложенный старт", Run: "Мойка",
  Pause: "Пауза", ActionRequired: "Требуется действие", Finished: "Завершено", Error: "Ошибка", Aborting: "Отмена программы"
};
const PHASE_RU = ["Предополаскивание", "Мойка", "Ополаскивание", "Сушка"];
const DELAY_MAX = 86400;

function pad2(n) { return (n < 10 ? "0" : "") + n; }
function fmtDur(sec) {
  const min = Math.max(0, Math.round(sec / 60)), h = Math.floor(min / 60), m = min % 60;
  return h ? h + " ч " + pad2(m) + " мин" : m + " мин";
}
function fmtClock(ts, nowTs) {
  const d = new Date(ts), now = new Date(nowTs);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
                           new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + (days === 1 ? " завтра" : days > 1 ? " +" + days + " дн" : "");
}
function fmtStamp(ts) {
  const d = new Date(ts);
  return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// Как wb-rules: без явного readonly писать можно только в switch, pushbutton, range и rgb
function isReadonly(d) {
  if (d.readonly !== undefined) return !!d.readonly;
  return d.type !== "switch" && d.type !== "pushbutton" && d.type !== "range" && d.type !== "rgb";
}

/** Описание контролов: [{ id, type, title, readonly?, min?, max?, units?, enum? }] в порядке правила. */
export function controlDefs() {
  const defs = [];
  function c(id, def) { defs.push(Object.assign({ id }, def)); }
  const progEnum = {};
  PROGRAMS.forEach((p) => { progEnum[p.uid] = { en: p.key, ru: p.title }; });

  c("online",          { title: "Связь с машиной", type: "switch", readonly: true });
  c("power",           { title: "Питание", type: "switch" });
  c("run",             { title: "Мойка (вкл — старт, выкл — отмена)", type: "switch" });
  c("state",           { title: "Состояние", type: "text" });
  c("running",         { title: "Программа запущена", type: "switch", readonly: true });
  c("finished",        { title: "Мойка завершена, не разгружена", type: "switch", readonly: true });
  c("door_open",       { title: "Дверь открыта", type: "switch", readonly: true });
  c("program",         { title: "Программа", type: "value", readonly: false, enum: progEnum });
  PROGRAMS.forEach((p) => c("prog_" + p.key.toLowerCase(), { title: "Программа: " + p.title, type: "switch" }));
  c("active_program",  { title: "Выполняется", type: "text" });
  c("phase",           { title: "Фаза", type: "text" });
  c("progress",        { title: "Прогресс", type: "value", units: "%" });
  c("remaining",       { title: "Осталось", type: "text" });
  c("remaining_min",   { title: "Осталось, мин", type: "value", units: "min" });
  c("remaining_sec",   { title: "До окончания, с (с учётом отложенного старта)", type: "value", units: "s" });
  c("start_in",        { title: "Старт через", type: "text" });
  c("end_time",        { title: "Окончание", type: "text" });
  OPTIONS.forEach((o) => c(o.ctrl, { title: o.title, type: "switch" }));
  c("delay_h",         { title: "Отложить старт, ч", type: "range", min: 0, max: 24 });
  c("finish_at",       { title: "Завершить к (ЧЧ:ММ, пусто — не использовать)", type: "text", readonly: false });
  c("start",           { title: "▶ Старт", type: "pushbutton" });
  c("abort",           { title: "■ Отменить программу", type: "pushbutton" });
  c("remote_start",    { title: "Удалённый старт разрешён", type: "switch", readonly: true });
  c("energy_forecast", { title: "Прогноз расхода энергии", type: "value", units: "%" });
  c("water_forecast",  { title: "Прогноз расхода воды", type: "value", units: "%" });
  c("alarm",           { title: "Авария", type: "alarm" });
  c("alarm_text",      { title: "Аварии", type: "text" });
  c("aquastop",        { title: "AquaStop (протечка)", type: "alarm" });
  c("salt_empty",      { title: "Нет соли", type: "alarm" });
  c("salt_low",        { title: "Соль заканчивается", type: "switch", readonly: true });
  c("rinse_empty",     { title: "Нет ополаскивателя", type: "alarm" });
  c("rinse_low",       { title: "Ополаскиватель заканчивается", type: "switch", readonly: true });
  c("salt_level",      { title: "Соль, уровень", type: "value", units: "%" });
  c("rinse_level",     { title: "Ополаскиватель, уровень", type: "value", units: "%" });
  c("filter_check",    { title: "Проверить фильтр", type: "switch", readonly: true });
  c("care_needed",     { title: "Нужен уход за машиной", type: "switch", readonly: true });
  c("care_runs",       { title: "Циклов до ухода за машиной", type: "value" });
  c("silence_left",    { title: "Тихий режим: осталось", type: "value", units: "min" });
  c("end_trigger",     { title: "Последняя программа", type: "text" });
  c("finished_at",     { title: "Последняя мойка завершена", type: "text" });
  c("cycles",          { title: "Всего запусков", type: "value" });
  c("last_message",    { title: "Последнее событие", type: "text" });
  SETTINGS.forEach((s) => {
    const def = { title: s.title };
    if (s.kind === "bool") def.type = "switch";
    else if (s.kind === "enum") {
      def.type = "value";
      def.readonly = false;
      def.enum = {};
      Object.keys(s.values).forEach((k) => { def.enum[k] = { en: s.values[k][0], ru: s.values[k][1] }; });
    } else {
      def.type = "range";
      def.min = s.min;
      def.max = s.max;
      def.units = s.units;
    }
    c(s.ctrl, def);
  });
  c("rssi",            { title: "Wi-Fi сигнал", type: "value", units: "dBm" });
  c("fw",              { title: "Прошивка", type: "text" });
  c("fw_update",       { title: "Доступно обновление ПО", type: "switch", readonly: true });
  return defs;
}

export class Simulator {
  /**
   * opts: { publish(topic, payload, retained), device = "dishwasher", speed = 60 (секунд машины
   *         за секунду настоящего времени), now = Date.now, scenario = "running" | "idle" }
   */
  constructor(opts) {
    this.out = opts.publish;
    this.device = opts.device || "dishwasher";
    this.speed = opts.speed || 60;
    this.now = opts.now || Date.now;
    this.prefix = "/devices/" + this.device + "/";
    this.defs = controlDefs();
    this.sent = {};                 // последнее опубликованное значение контрола
    this.timer = null;
    this.pendingStart = null;
    this.abortTimer = null;

    const m = this.m = {
      online: true, power: false, op: "Inactive", door: false, remote: true,
      program: 8196, active: null, total: 0, rem: 0, sir: 0, progress: 0, phase: "",
      opts: {}, set: {}, delay_h: 0, finish_at: "",
      flags: { aquastop: false, salt_empty: false, salt_low: false, rinse_empty: false, rinse_low: true,
               filter_check: false, care_needed: false, fw_update: false },
      finished: false, finished_at: "", end_trigger: "Завершена нормально",
      cycles: 878, care_runs: 19, last_message: "", silence_left: 0
    };
    OPTIONS.forEach((o) => { m.opts[o.ctrl] = false; });
    SETTINGS.forEach((s) => { m.set[s.ctrl] = s.value; });
    m.finished_at = fmtStamp(this.now() - 26 * 3600000) + " (Интенсивная 70°)";

    if (opts.scenario !== "idle") {
      // идёт «Эко 50°», прошла примерно треть
      m.power = true;
      m.op = "Run";
      m.active = 8196;
      m.total = this._duration(this._prog(8196));
      m.rem = Math.round(m.total * 0.64);
      this._advance(0);
      m.last_message = fmtStamp(this.now() - 80 * 60000) + "  ▶ Мойка началась: Эко 50°, окончание ≈ " +
        fmtClock(this.now() + m.rem * 1000, this.now());
    } else {
      m.last_message = fmtStamp(this.now() - 26 * 3600000) + "  ✅ Мойка завершена: Интенсивная 70°. Можно разгружать";
    }
  }

  // ---- публикация ---------------------------------------------------
  /** Полный снимок: метаданные и значения (как retained у брокера). */
  snapshot() {
    const list = [];
    list.push([this.prefix + "meta", JSON.stringify({ driver: "wb-rules", title: { en: "Посудомоечная машина" } })]);
    const byId = this.defs.map((d) => d.id).sort();      // wb-rules нумерует контролы по алфавиту id
    this.defs.forEach((d) => {
      const meta = { type: d.type, order: byId.indexOf(d.id) + 1, readonly: isReadonly(d), title: { en: d.title } };
      ["min", "max", "units", "enum"].forEach((k) => { if (d[k] !== undefined) meta[k] = d[k]; });
      list.push([this.prefix + "controls/" + d.id + "/meta", JSON.stringify(meta)]);
    });
    const vals = this._values();
    Object.keys(vals).forEach((id) => {
      // пустую строку брокер не хранит: такого retained-сообщения нет
      if (vals[id] !== "") list.push([this.prefix + "controls/" + id, vals[id]]);
    });
    return list;
  }

  start() {
    this.sent = this._values();
    this.snapshot().forEach((x) => this.out(x[0], x[1], true));
    this.timer = setInterval(() => this.tick(1), 1000);
  }
  stop() {
    clearInterval(this.timer);
    clearTimeout(this.pendingStart);
    clearTimeout(this.abortTimer);
    this.timer = this.pendingStart = this.abortTimer = null;
  }

  _values() {
    const m = this.m, now = this.now(), v = {};
    const busy = this._busy();
    const running = m.op === "Run" || m.op === "Pause" || m.op === "DelayedStart";
    const b = (x) => (x ? "1" : "0");
    v.online = b(m.online);
    v.power = b(m.power);
    v.run = b(this.pendingStart !== null || busy);
    v.state = OPSTATE_RU[m.op];
    v.running = b(busy);
    v.finished = b(m.finished);
    v.door_open = b(m.door);
    v.program = String(m.program);
    PROGRAMS.forEach((p) => { v["prog_" + p.key.toLowerCase()] = b(p.uid === m.program); });
    const act = this._prog(m.active);
    v.active_program = act ? act.title : "";
    v.phase = m.phase;
    v.progress = String(m.progress);
    v.remaining = running && m.rem > 0 ? fmtDur(m.rem) : "";
    v.remaining_min = String(running ? Math.round(m.rem / 60) : 0);
    v.remaining_sec = String(m.op === "DelayedStart" ? m.sir + m.rem : running ? m.rem : 0);
    let end = "", startIn = "";
    if (m.op === "Run" || m.op === "Pause") end = fmtClock(now + m.rem * 1000, now);
    else if (m.op === "DelayedStart") {
      startIn = fmtDur(m.sir) + " (в " + fmtClock(now + m.sir * 1000, now) + ")";
      end = fmtClock(now + (m.sir + m.rem) * 1000, now);
    } else if (m.online) {
      const d = this._delay(), p = this._prog(m.program);
      if (d !== null && p) end = "≈ " + fmtClock(now + (d + this._duration(p)) * 1000, now) + ", если запустить сейчас";
    }
    v.start_in = startIn;
    v.end_time = end;
    OPTIONS.forEach((o) => { v[o.ctrl] = b(m.opts[o.ctrl]); });
    v.delay_h = String(m.delay_h);
    v.finish_at = m.finish_at;
    v.remote_start = b(m.remote);
    v.energy_forecast = String(this._forecast(60));
    v.water_forecast = String(this._forecast(70));
    const alarms = [];
    if (m.flags.aquastop) alarms.push("Сработал AquaStop — возможна протечка!");
    v.alarm = b(alarms.length > 0);
    v.alarm_text = alarms.length ? alarms.join("; ") : "Нет";
    Object.keys(m.flags).forEach((k) => { v[k] = b(m.flags[k]); });
    v.salt_level = String(m.flags.salt_empty ? 0 : m.flags.salt_low ? 10 : 100);
    v.rinse_level = String(m.flags.rinse_empty ? 0 : m.flags.rinse_low ? 10 : 100);
    v.care_runs = String(m.care_runs);
    v.silence_left = String(m.silence_left);
    v.end_trigger = m.end_trigger;
    v.finished_at = m.finished_at;
    v.cycles = String(m.cycles);
    v.last_message = m.last_message;
    SETTINGS.forEach((s) => { v[s.ctrl] = s.kind === "bool" ? b(m.set[s.ctrl]) : String(m.set[s.ctrl]); });
    v.rssi = "-58";
    v.fw = "3.12.1.0";
    return v;
  }

  /** Опубликовать изменившиеся значения. force — id контрола, который публикуется в любом случае
   *  (wb-rules отвечает на команду, даже если значение вернулось к прежнему). */
  sync(force) {
    const vals = this._values();
    Object.keys(vals).forEach((id) => {
      if (vals[id] === this.sent[id] && id !== force) return;
      this.sent[id] = vals[id];
      this.out(this.prefix + "controls/" + id, vals[id], false);
    });
  }

  note(text) {
    this.m.last_message = fmtStamp(this.now()) + "  " + text;
  }

  // ---- логика машины ------------------------------------------------
  _prog(uid) {
    for (let i = 0; i < PROGRAMS.length; i++) if (PROGRAMS[i].uid === Number(uid)) return PROGRAMS[i];
    return null;
  }
  _busy() { const op = this.m.op; return op === "Run" || op === "Pause" || op === "DelayedStart" || op === "ActionRequired" || op === "Aborting"; }
  _idle() { const op = this.m.op; return op === "Ready" || op === "Finished" || op === "Inactive"; }
  _duration(p) {
    if (!p) return 0;
    let d = p.dur;
    const o = this.m.opts;
    if (o.opt_variospeed) d *= 0.5;
    if (o.opt_halfload) d *= 0.85;
    if (o.opt_extradry) d += 1500;
    return Math.round(d / 60) * 60;
  }
  _forecast(base) {
    const o = this.m.opts, p = this._prog(this.m.program);
    let x = base * (p && p.key === "Eco50" ? 0.7 : p && p.key === "Intensiv70" ? 1.3 : 1);
    if (o.opt_variospeed) x *= 1.25;
    if (o.opt_halfload) x *= 0.8;
    if (o.opt_extradry) x *= 1.1;
    return Math.max(5, Math.min(100, Math.round(x)));
  }
  _finishTarget() {
    const fin = String(this.m.finish_at || "").trim();
    if (!fin) return 0;
    const mm = /^(\d{1,2})[:.](\d{2})$/.exec(fin);
    if (!mm || +mm[1] > 23 || +mm[2] > 59) return null;
    const now = new Date(this.now()), t = new Date(now.getTime());
    t.setHours(+mm[1], +mm[2], 0, 0);
    if (t.getTime() <= now.getTime()) { t.setDate(t.getDate() + 1); t.setHours(+mm[1], +mm[2], 0, 0); }
    return t.getTime();
  }
  _delay() {
    const target = this._finishTarget();
    if (target === null) return null;
    const delay = target
      ? Math.floor((target - this.now()) / 1000) - this._duration(this._prog(this.m.program))
      : this.m.delay_h * 3600;
    if (delay <= 0) return 0;
    return Math.min(Math.floor(delay / 60) * 60, DELAY_MAX);
  }
  _advance(dt) {
    const m = this.m;
    m.rem = Math.max(0, m.rem - dt);
    m.progress = m.total ? Math.min(100, Math.round((1 - m.rem / m.total) * 100)) : 0;
    m.phase = PHASE_RU[m.progress < 12 ? 0 : m.progress < 58 ? 1 : m.progress < 76 ? 2 : 3];
  }

  /** Прошло sec секунд настоящего времени. */
  tick(sec) {
    const m = this.m, dt = sec * this.speed;
    if (!m.online) return;
    if (m.op === "DelayedStart") {
      m.sir -= dt;
      if (m.sir <= 0) {
        m.sir = 0;
        m.op = "Run";
        this.note("▶ Мойка началась: " + this._prog(m.active).title + ", окончание ≈ " + fmtClock(this.now() + m.rem * 1000, this.now()));
      }
    } else if (m.op === "Run") {
      this._advance(dt);
      if (m.rem <= 0) this._finish();
    } else if (m.op === "Finished") {
      m.idleFor = (m.idleFor || 0) + dt;
      if (m.idleFor > 600) { m.op = "Inactive"; m.power = false; }     // машина выключается сама
    }
    this.sync();
  }

  _finish() {
    const m = this.m, p = this._prog(m.active);
    m.op = "Finished";
    m.idleFor = 0;
    m.progress = 100;
    m.rem = 0;
    m.active = null;
    m.finished = true;
    m.finished_at = fmtStamp(this.now()) + (p ? " (" + p.title + ")" : "");
    m.end_trigger = "Завершена нормально";
    m.cycles++;
    m.care_runs = Math.max(0, m.care_runs - 1);
    this.note("✅ Мойка завершена" + (p ? ": " + p.title : "") + ". Можно разгружать");
  }

  _powerOn(then) {
    const m = this.m;
    if (m.power) return then();
    m.power = true;
    m.op = "Ready";
    return setTimeout(() => { then(); this.sync(); }, 1500);
  }

  _start() {
    const m = this.m;
    if (this.pendingStart !== null) return;
    if (!m.online) return this.note("Старт невозможен: нет связи с машиной (hcpy)");
    if (this._busy()) return this.note("Программа уже запущена или отменяется");
    const p = this._prog(m.program);
    if (!p) return this.note("Старт невозможен: не выбрана программа");
    const delay = this._delay();
    if (delay === null) return this.note("Неверное время «Завершить к»: «" + String(m.finish_at).trim() + "», нужно ЧЧ:ММ");
    const dispatch = () => {
      this.pendingStart = null;
      if (m.door) return this.note("Старт отменён: дверь открыта");
      if (!m.remote) return this.note("Старт отменён: удалённый старт не разрешён — нажмите Remote Start на машине");
      m.active = p.uid;
      m.total = m.rem = this._duration(p);
      m.finished = false;
      m.delay_h = 0;                                      // задержка задаётся на один запуск
      m.finish_at = "";
      this._advance(0);
      if (delay > 0) {
        m.op = "DelayedStart";
        m.sir = delay;
        this.note("⏰ Отложенный старт: " + p.title + ", начнётся в " + fmtClock(this.now() + delay * 1000, this.now()) +
          ", окончание ≈ " + fmtClock(this.now() + (delay + m.rem) * 1000, this.now()));
      } else {
        m.op = "Run";
        this.note("▶ Мойка началась: " + p.title + ", окончание ≈ " + fmtClock(this.now() + m.rem * 1000, this.now()));
      }
    };
    if (m.power) return dispatch();
    const t = this._powerOn(dispatch);
    this.pendingStart = t;
  }

  _abort() {
    const m = this.m;
    if (this.pendingStart !== null) {
      clearTimeout(this.pendingStart);
      this.pendingStart = null;
      return this.note("Старт отменён пользователем");
    }
    if (m.op === "Aborting") return this.note("Машина уже отменяет программу");
    if (!this._busy()) return this.note("Нечего отменять: программа не запущена");
    const wasDelayed = m.op === "DelayedStart";
    m.op = "Aborting";
    m.sir = 0;
    this.note("Команда отмены программы");
    this.abortTimer = setTimeout(() => {
      m.op = "Ready";
      m.active = null;
      m.rem = 0;
      m.progress = 0;
      m.phase = "";
      m.end_trigger = "Отменена пользователем";
      this.note("⛔ Программа прервана");
      this.sync();
    }, wasDelayed ? 1500 : 4000);
  }

  _select(uid) {
    const m = this.m, p = this._prog(uid);
    if (!p) return;
    if (this._busy()) return this.note("Программу нельзя сменить во время мойки");
    m.program = p.uid;                                    // wb-rules сразу показывает записанное значение
    this._powerOn(() => { if (m.op === "Finished") m.op = "Ready"; });
  }

  /** Команда: топик .../controls/<id>/on. */
  handle(topic, payload) {
    const mm = /\/controls\/([^/]+)\/on$/.exec(topic);
    if (!mm || topic.indexOf(this.prefix) !== 0) return;
    const id = mm[1], m = this.m;
    const def = this.defs.filter((d) => d.id === id)[0];
    if (!def || isReadonly(def)) return;
    const on = payload === "1" || payload === "true";

    const starting = id === "start" || (id === "run" && on);     // отказ в старте правило объясняет само
    if (!m.online && id !== "delay_h" && id !== "finish_at" && !starting) {
      // без связи правило не знает состояния машины; программу, опции и «Мойка» оно возвращает назад молча
      if (id === "power" && !on) this.note("Выключение отменено: состояние машины неизвестно");
      else if (id === "abort") this.note("Нечего отменять: программа не запущена");
      else if (id === "power" || id.indexOf("set_") === 0) this.note("Команда не отправлена: нет связи с машиной");
    } else if (id === "power") {
      if (on) this._powerOn(() => {});
      else {
        if (this.pendingStart !== null) this._abort();
        if (this._busy()) this.note("Выключение отменено: программа выполняется или отменяется");
        else { m.power = false; m.op = "Inactive"; }
      }
    } else if (id === "run") {
      // запись уже стоящего значения правило считает эхом и молчит
      if (on !== (this.pendingStart !== null || this._busy())) { if (on) this._start(); else this._abort(); }
    }
    else if (id === "start") this._start();
    else if (id === "abort") this._abort();
    else if (id === "program") this._select(payload);
    else if (id.indexOf("prog_") === 0) {
      const p = PROGRAMS.filter((x) => "prog_" + x.key.toLowerCase() === id)[0];
      if (on && p) this._select(p.uid);
    } else if (id.indexOf("opt_") === 0) {
      if (m.op === "Aborting") { /* отказ */ }
      else {
        m.opts[id] = on;                                  // wb-rules сразу показывает записанное значение
        if (!this._busy()) this._powerOn(() => {});
        else if (id === "opt_silence") m.silence_left = on ? m.set.set_silencetime : 0;
      }
    } else if (id === "delay_h") {
      const n = Math.round(parseFloat(payload));
      if (!isNaN(n)) m.delay_h = Math.max(0, Math.min(24, n));
    } else if (id === "finish_at") {
      m.finish_at = String(payload);
    } else if (id.indexOf("set_") === 0) {
      const s = SETTINGS.filter((x) => x.ctrl === id)[0];
      const n = Math.round(parseFloat(payload));
      if (s.kind === "bool") m.set[id] = on;
      else if (s.kind === "num") { if (!isNaN(n)) m.set[id] = Math.max(s.min, Math.min(s.max, n)); }
      else {
        if (s.values.hasOwnProperty(String(n))) m.set[id] = n;
        else this.note("Недопустимое значение для «" + s.title.replace(/^Настройка: /, "") + "»: " + payload +
                       ", можно: " + Object.keys(s.values).join(", "));
      }
    }
    this.sync(id);
  }

  // ---- пульт демо ----------------------------------------------------
  setDoor(open) {
    const m = this.m;
    m.door = !!open;
    if (open) m.finished = false;
    this.sync();
  }
  setRemote(allowed) { this.m.remote = !!allowed; this.sync(); }
  setFlag(name, on) { this.m.flags[name] = !!on; this.sync(); }
  setOnline(on) {
    const m = this.m;
    if (m.online === !!on) return;
    m.online = !!on;
    this.note(on ? "Связь с машиной восстановлена" : "Потеряна связь с машиной");
    this.sync();
  }
  /** Перемотать идущую программу к концу. */
  skipToEnd() {
    const m = this.m;
    if (m.op === "DelayedStart") m.sir = 1;
    else if (m.op === "Run") m.rem = Math.min(m.rem, 120);
    this.tick(1);
  }
}

/** Транспорт с интерфейсом MqttClient поверх имитации — для демо в браузере. */
export class SimTransport {
  constructor(opts) {
    this.onMessage = () => {};
    this.onStatus = () => {};
    this.connected = false;
    this._timer = null;
    this.sim = new Simulator(Object.assign({}, opts, {
      publish: (topic, payload, retained) => {
        if (this.connected) this.onMessage(topic, payload, !!retained);
      }
    }));
  }
  subscribe() {}
  connect() {
    if (this._timer !== null || this.connected) return;
    this.onStatus("connecting");
    this._timer = setTimeout(() => {
      this._timer = null;
      this.connected = true;
      this.onStatus("connected");
      this.sim.start();
    }, 350);
  }
  publish(topic, payload) {
    if (!this.connected) return false;
    setTimeout(() => { if (this.connected) this.sim.handle(topic, String(payload)); }, 120);   // как задержка сети
    return true;
  }
  close() {
    clearTimeout(this._timer);
    this._timer = null;
    this.sim.stop();
    this.connected = false;
    this.onStatus("closed");
  }
}
