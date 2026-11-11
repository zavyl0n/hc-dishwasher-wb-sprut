"use strict";
// Имитация посудомойки для демо-режима страницы (web/app/js/sim.js).
// Главное здесь — сверка с настоящим правилом: состав и описание контролов, тексты состояний
// и ответы на команды должны быть теми же, что у rule/dishwasher.js в эмуляторе wb-rules.
//   node --test tests/web_sim.test.js
// Время поддельное: 10.03.2026, 20:00 по Москве; таймеры — mock.timers.
process.env.TZ = "Europe/Moscow";

const { describe, it, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { load } = require("./wbrules");

const ROOT = path.join(__dirname, "..");
const RULES = ["rule/dishwasher.js", "examples/SMV4HVX31E/dishwasher.js"];
const START = Date.UTC(2026, 2, 10, 17, 0, 0);
const P = "/devices/dishwasher/";
const C = P + "controls/";
const B = "homeconnect/dishwasher";

let Sim, Store, Model;
before(async function () {
  Sim = await import("../web/app/js/sim.js");
  Store = await import("../web/app/js/store.js");
  Model = await import("../web/app/js/model.js");
});

let clock = START;
let sims = [];

// Имитация с журналом опубликованного. По умолчанию машина выключена (сценарий idle).
function make(opts) {
  const out = [];
  const sim = new Sim.Simulator(Object.assign({
    publish: function (topic, payload, retained) { out.push([topic, payload, retained]); },
    now: function () { return clock; },
    scenario: "idle",
  }, opts || {}));
  sims.push(sim);
  const prefix = "/devices/" + (opts && opts.device || "dishwasher") + "/controls/";
  const r = {
    sim: sim, out: out,
    // последнее опубликованное значение; пустой текст в снимок не попадает
    val: function (id) {
      for (let i = out.length - 1; i >= 0; i--) if (out[i][0] === prefix + id) return out[i][1];
      return "";
    },
    count: function (id) { return out.filter(function (x) { return x[0] === prefix + id; }).length; },
    cmd: function (id, v) { sim.handle(prefix + id + "/on", String(v)); return r; },
    note: function () { return r.val("last_message").replace(/^\d\d\.\d\d \d\d:\d\d {2}/, ""); },
    // включённая и готовая машина
    ready: function () { sim.m.power = true; sim.m.op = "Ready"; sim.start(); return r; },
    start: function () { sim.start(); return r; },
  };
  return r;
}

// Прошло sec секунд настоящего времени: идут и часы, и таймеры имитации
function pass(sec) {
  for (let i = 0; i < sec; i++) { clock += 1000; mock.timers.tick(1000); }
}

beforeEach(function () {
  clock = START;
  sims = [];
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});
afterEach(function () {
  sims.forEach(function (s) { s.stop(); });
  mock.timers.reset();
});

// ---------------------------------------------------------------------------
// Сверка с правилом
// ---------------------------------------------------------------------------
// Значение по умолчанию у wb-rules: писать можно только в switch, pushbutton, range и rgb
function effectiveReadonly(def) {
  if (def.readonly !== undefined) return !!def.readonly;
  return ["switch", "pushbutton", "range", "rgb"].indexOf(def.type) < 0;
}
// Объекты правила созданы в другом контексте vm — сравниваем через JSON
const plain = function (x) { return JSON.parse(JSON.stringify(x)); };
const FIELDS = ["type", "title", "readonly", "min", "max", "units", "enum"];
function describeControl(id, def) {
  const d = { id: id };
  FIELDS.forEach(function (k) { if (def[k] !== undefined) d[k] = def[k]; });
  return plain(d);
}

for (const file of RULES) {
  describe("имитация и " + file, function () {
    let e, ruleDefs;
    beforeEach(function () {
      e = load(path.join(ROOT, file));
      ruleDefs = Object.keys(e.defs).map(function (k) {
        assert.equal(k.indexOf("dishwasher/"), 0);
        return describeControl(k.slice("dishwasher/".length), e.defs[k]);
      });
    });

    it("тот же набор контролов в том же порядке", function () {
      assert.deepEqual(Sim.controlDefs().map(function (d) { return d.id; }),
        ruleDefs.map(function (d) { return d.id; }));
    });

    it("у каждого контрола те же тип, подпись, readonly, границы, единицы и варианты", function () {
      const simDefs = Sim.controlDefs().map(function (d) { return describeControl(d.id, d); });
      assert.equal(simDefs.length > 50, true);
      simDefs.forEach(function (d, i) { assert.deepEqual(d, ruleDefs[i], d.id); });
    });

    it("метаданные в MQTT: readonly по правилам wb-rules, порядок, подпись, enum", function () {
      const metas = {};
      make().sim.snapshot().forEach(function (x) {
        const m = /^\/devices\/dishwasher\/controls\/([^/]+)\/meta$/.exec(x[0]);
        if (m) metas[m[1]] = JSON.parse(x[1]);
      });
      assert.deepEqual(Object.keys(metas), ruleDefs.map(function (d) { return d.id; }));
      // правило порядок не задаёт, и wb-rules нумерует контролы по алфавиту: abort — 1, active_program — 2, …
      const sorted = Object.keys(metas).sort();
      ruleDefs.forEach(function (d) {
        const m = metas[d.id];
        assert.equal(m.type, d.type, d.id);
        assert.equal(m.readonly, effectiveReadonly(d), d.id + ": readonly");
        assert.equal(m.order, sorted.indexOf(d.id) + 1, d.id + ": order");
        assert.equal(Store.pickTitle(m.title), d.title, d.id);
        ["min", "max", "units", "enum"].forEach(function (k) { assert.deepEqual(m[k], d[k], d.id + ": " + k); });
      });
    });

    it("подпись устройства", function () {
      const snap = make().sim.snapshot();
      assert.equal(snap[0][0], P + "meta");
      assert.equal(Store.pickTitle(JSON.parse(snap[0][1]).title), e.devices.dishwasher.title);
    });

    it("значения записаны так же, как их публикует wb-rules: 0/1, число, текст", function () {
      const sim = make().sim;
      const vals = {};
      sim.snapshot().forEach(function (x) {
        const m = /^\/devices\/dishwasher\/controls\/([^/]+)$/.exec(x[0]);
        if (m) vals[m[1]] = x[1];
      });
      Object.keys(e.defs).forEach(function (k) {
        const id = k.slice("dishwasher/".length), def = e.defs[k], v = vals[id];
        if (def.type === "pushbutton") return assert.equal(v, undefined, id + ": у кнопки нет значения");
        if (typeof def.value === "boolean") assert.match(v, /^[01]$/, id);
        else if (typeof def.value === "number") assert.match(v, /^-?\d+(\.\d+)?$/, id);
        else assert.notEqual(v, "", id + ": пустой текст брокер не хранит");
      });
      assert.deepEqual(Object.keys(vals).filter(function (id) { return !(("dishwasher/" + id) in e.defs); }), []);
    });

    it("тексты состояний и фаз", function () {
      const r = make();
      Object.keys(e.ctx.OPSTATE_RU).forEach(function (op) {
        r.sim.m.op = op;
        assert.equal(r.sim._values().state, e.ctx.OPSTATE_RU[op], op);
      });
      const phases = Object.keys(e.ctx.PHASE_RU).map(function (k) { return e.ctx.PHASE_RU[k]; }).filter(Boolean);
      assert.deepEqual(Model.PHASES, phases);
      r.sim.m.op = "Run";
      r.sim.m.total = 1000;
      const seen = [];
      for (let rem = 1000; rem >= 0; rem -= 10) {
        r.sim.m.rem = rem;
        r.sim._advance(0);
        if (seen.indexOf(r.sim.m.phase) < 0) seen.push(r.sim.m.phase);
      }
      assert.deepEqual(seen, phases);
    });

    it("программы: длительность и максимум отложенного старта", function () {
      const sim = make().sim;
      plain(e.ctx.PROGRAMS).forEach(function (p) {
        assert.equal(sim._duration(sim._prog(p.uid)), Math.round(p.dur / 60) * 60, p.key);
      });
      assert.equal(sim._prog(1), null);
      sim.m.delay_h = 999;
      assert.equal(sim._delay(), e.ctx.DELAY_MAX);
    });
  });
}

// ---------------------------------------------------------------------------
// Одни и те же действия над правилом (в эмуляторе wb-rules) и над имитацией
// ---------------------------------------------------------------------------
describe("имитация отвечает на команды как правило", function () {
  const READY = {
    bsh_common_setting_powerstate: "On",
    bsh_common_status_operationstate: "Ready",
    bsh_common_status_doorstate: "Closed",
    bsh_common_status_remotecontrolstartallowed: "True",
    bsh_common_root_selectedprogram: "Eco50",
    bsh_common_option_remainingprogramtime: "13500",
    dishcare_dishwasher_option_halfload: "False",
    dishcare_dishwasher_setting_soundlevelsignal: "Medium",
  };
  const OFF = { bsh_common_setting_powerstate: "Off", bsh_common_status_operationstate: "Inactive" };
  const hc = function (e, key, v) { e.mqtt(B + "/state/" + key, v, false); };
  const op = function (e, v) { hc(e, "bsh_common_status_operationstate", v); };
  // значение контрола правила в том виде, в каком wb-rules отдаёт его в MQTT
  const wb = function (v) { return typeof v === "boolean" ? (v ? "1" : "0") : String(v); };

  // Правило и имитация в одном и том же исходном состоянии и с общими часами
  function pair(state) {
    const e = load(path.join(ROOT, RULES[0]));
    e.mqtt("homeconnect/LWT", "online", true);
    e.mqtt(B + "/LWT", "online", true);
    const st = Object.assign({}, READY, state || {});
    Object.keys(st).forEach(function (k) { e.mqtt(B + "/state/" + k, st[k], true); });
    e.clear();
    const r = make({ now: e.now, speed: 1 });
    if (st.bsh_common_setting_powerstate === "On") r.ready(); else r.start();
    r.e = e;
    const demoNote = r.val("last_message");     // имитация начинает с готовой записи, правило — с пустой
    // пользователь меняет контрол: в правиле и командой /on в имитации
    r.user = function (id, v) { e.user(id, v); r.cmd(id, wb(v)); return r; };
    r.press = function (id) { e.press(id); r.cmd(id, "1"); return r; };
    r.both = function (ms) { e.advance(ms); mock.timers.tick(ms); return r; };
    r.same = function (ids, when) {
      ids.forEach(function (id) {
        const want = id === "last_message" && e.get(id) === "" ? demoNote : wb(e.get(id));   // правило ещё молчит — молчит и имитация
        assert.equal(r.val(id), want, id + (when ? " — " + when : ""));
      });
      assert.deepEqual(e.errors, []);
      return r;
    };
    // машина включилась по команде правила
    r.machineOn = function () { hc(e, "bsh_common_setting_powerstate", "On"); op(e, "Ready"); return r; };
    return r;
  }
  const BASE = ["power", "run", "running", "state", "program", "delay_h", "finish_at", "last_message"];

  it("исходное состояние совпадает", function () {
    pair().same(BASE.concat(["online", "door_open", "remote_start", "finished", "end_time", "start_in", "remaining_min",
      "prog_eco50", "prog_auto2", "alarm", "alarm_text"]));
    pair(OFF).same(["power", "run", "running", "state", "program", "end_time"]);
  });

  it("старт при открытой двери", function () {
    const p = pair();
    hc(p.e, "bsh_common_status_doorstate", "Open");
    p.sim.setDoor(true);
    p.user("run", true).same(BASE.concat("door_open"));
    assert.match(p.note(), /^Старт отменён: дверь открыта$/);
    p.press("start").same(BASE);
  });

  it("старт без разрешения удалённого старта", function () {
    const p = pair();
    hc(p.e, "bsh_common_status_remotecontrolstartallowed", "False");
    p.sim.setRemote(false);
    p.user("run", true).same(BASE.concat("remote_start"));
    assert.match(p.note(), /^Старт отменён: удалённый старт не разрешён/);
  });

  it("старт выключенной машины с открытой дверью: питание включено, старт отменён", function () {
    const p = pair(OFF);
    hc(p.e, "bsh_common_status_doorstate", "Open");
    p.sim.setDoor(true);
    p.user("run", true);
    p.machineOn().same(BASE, "пока машина включается");
    assert.equal(p.val("run"), "1");
    p.both(5000).same(BASE, "после включения");
    assert.equal(p.val("run"), "0");
    assert.equal(p.val("power"), "1");
  });

  it("выключение питания, пока машина включается для старта", function () {
    const p = pair(OFF);
    p.user("run", true);
    p.machineOn();
    p.user("power", false);
    assert.deepEqual(p.e.commands().pop().data, { uid: 539, value: "Off" }, "правило выключает машину");
    hc(p.e, "bsh_common_setting_powerstate", "Off");
    op(p.e, "Inactive");
    p.same(BASE);
    assert.equal(p.note(), "Старт отменён пользователем");
    p.both(10000).same(BASE, "отменённый старт не выполняется");
  });

  it("отмена ожидающего старта выключателем «Мойка»", function () {
    const p = pair(OFF);
    p.user("run", true);
    p.machineOn();
    p.user("run", false).same(BASE);
    assert.equal(p.note(), "Старт отменён пользователем");
    p.both(10000).same(BASE);
    assert.equal(p.val("state"), "Готова");
  });

  it("обычный старт, завершение", function () {
    const p = pair();
    p.user("run", true);
    hc(p.e, "bsh_common_root_activeprogram", "Eco50");
    op(p.e, "Run");
    p.both(3000);
    p.same(BASE.concat(["active_program", "remaining", "remaining_min", "end_time", "finished"]));
    assert.equal(p.note(), "▶ Мойка началась: Эко 50°, окончание ≈ 23:45");

    p.user("run", true).same(BASE, "повторная запись «Мойка» = 1 — эхо, правило молчит");
    p.press("start").same(BASE, "повторный старт кнопкой");
    assert.equal(p.note(), "Программа уже запущена или отменяется");
    p.user("program", 8195).same(BASE, "смена программы");
    assert.equal(p.note(), "Программу нельзя сменить во время мойки");
    p.user("power", false).same(BASE, "выключение");
    assert.equal(p.note(), "Выключение отменено: программа выполняется или отменяется");

    op(p.e, "Finished");
    p.sim.m.rem = 1;
    p.both(1000);
    p.same(BASE.concat(["finished", "finished_at", "remaining", "remaining_min"]));
    assert.equal(p.note(), "✅ Мойка завершена: Эко 50°. Можно разгружать");
    assert.equal(p.val("finished_at"), "10.03 20:00 (Эко 50°)");
  });

  it("отмена идущей программы", function () {
    const p = pair();
    p.user("run", true);
    hc(p.e, "bsh_common_root_activeprogram", "Eco50");
    op(p.e, "Run");
    p.both(3000);
    p.press("abort").same(["last_message"]);
    assert.equal(p.note(), "Команда отмены программы");
    op(p.e, "Aborting");
    p.same(BASE);
    p.press("abort").same(BASE);
    assert.equal(p.note(), "Машина уже отменяет программу");
    p.user("opt_halfload", true).same(["opt_halfload"], "опции во время отмены не меняются");

    p.both(4000);
    hc(p.e, "bsh_common_status_programrundetail_endtrigger", "ProgramAbortedByUser");
    hc(p.e, "bsh_common_root_activeprogram", "None");
    p.e.mqtt(B + "/event/bsh_common_event_programaborted", JSON.stringify({ event_type: "Present" }), false);
    op(p.e, "Ready");
    p.same(BASE.concat(["end_trigger", "active_program", "finished"]));
    assert.equal(p.note(), "⛔ Программа прервана");

    p.press("abort").same(BASE);
    assert.equal(p.note(), "Нечего отменять: программа не запущена");
  });

  it("отложенный старт по «Отложить старт, ч»: после запуска задержка сбрасывается", function () {
    const p = pair();
    p.user("delay_h", 2).same(BASE.concat("end_time"));
    assert.equal(p.val("end_time"), "≈ 01:45 завтра, если запустить сейчас");
    p.user("run", true);
    assert.deepEqual(p.e.commands().pop().data, { program: 8196, options: [{ uid: 558, value: 7200 }] });
    assert.equal(p.sim.m.sir, 7200);
    hc(p.e, "bsh_common_root_activeprogram", "Eco50");
    hc(p.e, "bsh_common_option_startinrelative", "7200");
    op(p.e, "DelayedStart");
    p.both(3000);
    p.same(BASE.concat(["start_in", "end_time", "remaining", "remaining_min"]));
    assert.equal(p.val("delay_h"), "0");
    assert.equal(p.note(), "⏰ Отложенный старт: Эко 50°, начнётся в 22:00, окончание ≈ 01:45 завтра");
  });

  it("отложенный старт по «Завершить к»", function () {
    const p = pair();
    p.user("finish_at", "07:30").same(BASE.concat("end_time"));
    assert.equal(p.val("end_time"), "≈ 07:30 завтра, если запустить сейчас");
    p.user("run", true);
    const sent = p.e.commands().pop().data;
    assert.deepEqual(sent, { program: 8196, options: [{ uid: 558, value: 27900 }] });
    assert.equal(p.sim.m.sir, 27900);
    hc(p.e, "bsh_common_root_activeprogram", "Eco50");
    hc(p.e, "bsh_common_option_startinrelative", "27900");
    op(p.e, "DelayedStart");
    p.both(3000);
    p.same(BASE.concat(["start_in", "end_time"]));
    assert.equal(p.val("finish_at"), "");
    assert.equal(p.val("start_in"), "7 ч 45 мин (в 03:45 завтра)");
  });

  it("неверное «Завершить к»", function () {
    const p = pair();
    p.user("finish_at", " 25:00 ").same(BASE.concat("end_time"));
    p.user("run", true).same(BASE);
    assert.equal(p.note(), "Неверное время «Завершить к»: «25:00», нужно ЧЧ:ММ");
    assert.deepEqual(p.e.commands(), []);
    // очистка поля пробелом, как это делает страница
    p.user("finish_at", " ").same(BASE.concat("end_time"));
    assert.equal(p.val("end_time"), "≈ 23:45, если запустить сейчас");
  });

  it("недопустимое значение настройки", function () {
    const p = pair();
    p.user("set_sound", 9).same(["set_sound", "last_message"]);
    assert.equal(p.note(), "Недопустимое значение для «громкость сигнала»: 9, можно: 0, 1, 2, 3");
    assert.equal(p.val("set_sound"), "2");
  });

  it("машина не на связи", function () {
    const p = pair();
    p.e.mqtt(B + "/LWT", "offline", false);
    p.sim.setOnline(false);
    p.same(BASE.concat(["online", "end_time"]));
    assert.equal(p.note(), "Потеряна связь с машиной");
    p.user("run", true).same(BASE);
    assert.equal(p.note(), "Старт невозможен: нет связи с машиной (hcpy)");
    // Без связи правило не знает состояния машины: опции и программу отклоняет молча.
    // Само значение сверять нельзя: правилу не к чему его вернуть, и до восстановления связи
    // в контроле остаётся записанное, а имитация сразу показывает прежнее.
    p.user("opt_halfload", true).same(["last_message"], "опция");
    assert.equal(p.val("opt_halfload"), "0");
    p.user("program", 8203).same(["last_message"], "программа");
    assert.equal(p.val("program"), "8196");
    p.user("set_sound", 3).same(["last_message"], "настройка");
    assert.equal(p.val("set_sound"), "2");
    assert.equal(p.note(), "Команда не отправлена: нет связи с машиной");
    p.press("abort").same(["run", "running", "state", "last_message"], "отмена");
    assert.equal(p.note(), "Нечего отменять: программа не запущена");
    p.user("power", false).same(["run", "running", "state", "last_message"], "выключение");
    assert.equal(p.note(), "Выключение отменено: состояние машины неизвестно");
    p.user("delay_h", 3).same(["delay_h"], "задержку можно задать и без связи");
    p.e.mqtt(B + "/LWT", "online", false);
    p.sim.setOnline(true);
    p.same(["online", "last_message"]);
    assert.equal(p.note(), "Связь с машиной восстановлена");
  });

  it("выбор программы и опции на выключенной машине: значение сразу новое, питание включается", function () {
    const p = pair(OFF);
    p.user("program", 8203);
    assert.deepEqual(p.e.commands().pop().data, { uid: 539, value: "On" });
    assert.equal(p.val("program"), "8203");
    p.machineOn().same(["power", "state", "program", "run"]);
    p.both(5000);
    assert.deepEqual(p.e.commands().pop().data, { program: 8203 });
    hc(p.e, "bsh_common_root_selectedprogram", "Quick65");
    p.same(["power", "state", "program", "prog_quick65", "prog_eco50", "run"]);

    const q = pair(OFF);
    q.user("opt_halfload", true);
    assert.equal(q.val("opt_halfload"), "1");
    q.machineOn().same(["power", "state", "opt_halfload"]);
  });
});

// ---------------------------------------------------------------------------
// Поведение имитации
// ---------------------------------------------------------------------------
describe("снимок и публикация", function () {
  it("start() отдаёт retained-снимок: устройство, метаданные и значения", function () {
    const r = make().start();
    assert.equal(r.out.every(function (x) { return x[2] === true; }), true);
    const topics = r.out.map(function (x) { return x[0]; });
    assert.equal(new Set(topics).size, topics.length, "каждая тема один раз");
    assert.equal(topics[0], P + "meta");
    assert.equal(topics.some(function (t) { return /\/on$/.test(t); }), false);
    Sim.controlDefs().forEach(function (d) {
      assert.equal(topics.indexOf(C + d.id + "/meta") >= 0, true, d.id);
    });
    assert.equal(r.val("state"), "Выключена");
    assert.equal(r.val("power"), "0");
    assert.equal(r.val("online"), "1");
    assert.equal(r.val("program"), "8196");
    assert.equal(r.val("prog_eco50"), "1");
    assert.equal(r.val("end_time"), "≈ 23:45, если запустить сейчас");
    // пустой текст и кнопки в снимок не попадают
    ["phase", "start_in", "active_program", "finish_at", "start", "abort"].forEach(function (id) {
      assert.equal(topics.indexOf(C + id), -1, id);
    });
  });

  it("без изменений ничего не публикуется; изменения идут без признака retained", function () {
    const r = make().start();
    const n = r.out.length;
    pass(3);
    assert.equal(r.out.length, n);
    r.sim.setDoor(true);
    assert.deepEqual(r.out.slice(n), [[C + "door_open", "1", false]]);
  });

  it("сценарий running: идёт «Эко 50°», прошла треть", function () {
    const r = make({ scenario: "running" }).start();
    assert.equal(r.val("state"), "Мойка");
    assert.equal(r.val("power"), "1");
    assert.equal(r.val("run"), "1");
    assert.equal(r.val("running"), "1");
    assert.equal(r.val("active_program"), "Эко 50°");
    assert.equal(r.val("progress"), "36");
    assert.equal(r.val("phase"), "Мойка");
    assert.equal(r.val("remaining_min"), "144");
    assert.equal(r.val("remaining"), "2 ч 24 мин");
    assert.equal(r.val("end_time"), "22:24");
    assert.equal(r.val("last_message"), "10.03 18:40  ▶ Мойка началась: Эко 50°, окончание ≈ 22:24");
  });

  it("«Последнее событие»: ДД.ММ ЧЧ:ММ, два пробела, текст", function () {
    const r = make().start();
    assert.equal(r.val("last_message"), "09.03 18:00  ✅ Мойка завершена: Интенсивная 70°. Можно разгружать");
    clock = new Date(2026, 0, 5, 7, 4, 59).getTime();
    r.cmd("abort", 1);
    assert.equal(r.val("last_message"), "05.01 07:04  Нечего отменять: программа не запущена");
  });

  it("другое устройство: свои темы, чужие команды не слушает", function () {
    const r = make({ device: "dw2" }).start();
    assert.equal(r.out.every(function (x) { return x[0].indexOf("/devices/dw2/") === 0; }), true);
    const n = r.out.length;
    r.sim.handle("/devices/dishwasher/controls/power/on", "1");
    r.sim.handle("/devices/dw2/controls/power", "1");
    r.sim.handle("/devices/dw2/controls/nope/on", "1");
    assert.equal(r.out.length, n);
    r.cmd("power", 1);
    assert.equal(r.val("power"), "1");
  });

  it("команды в контролы только для чтения игнорируются", function () {
    const r = make().ready();
    const n = r.out.length;
    r.cmd("online", 0).cmd("state", "Мойка").cmd("progress", 50).cmd("alarm", 1).cmd("salt_low", 1)
      .cmd("door_open", 1).cmd("last_message", "x").cmd("fw", "x");
    assert.equal(r.out.length, n);
  });

  it("на команду всегда приходит ответ, даже если значение прежнее", function () {
    const r = make().ready();
    r.cmd("set_sound", 2).cmd("power", 1).cmd("delay_h", 0);
    assert.equal(r.count("set_sound"), 2);
    assert.equal(r.count("power"), 2);
    assert.equal(r.count("delay_h"), 2);
  });
});

describe("питание и программа", function () {
  it("включение и выключение", function () {
    const r = make().start();
    r.cmd("power", 1);
    assert.equal(r.val("power"), "1");
    assert.equal(r.val("state"), "Готова");
    r.cmd("power", "true");
    assert.equal(r.val("power"), "1");
    r.cmd("power", 0);
    assert.equal(r.val("power"), "0");
    assert.equal(r.val("state"), "Выключена");
  });

  it("выбор программы на выключенной машине включает её", function () {
    const r = make().start();
    r.cmd("program", 8203);
    assert.equal(r.val("power"), "1");
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.val("program"), "8203");
    assert.equal(r.val("prog_quick65"), "1");
    assert.equal(r.val("prog_eco50"), "0");
    assert.equal(r.val("end_time"), "≈ 21:00, если запустить сейчас");
    pass(2);
    assert.equal(r.val("program"), "8203");
    assert.equal(r.val("run"), "0");
  });

  it("выключатели программ — радиокнопки: выключить нельзя", function () {
    const r = make().start();
    r.cmd("prog_auto2", 1);
    assert.equal(r.val("program"), "8195");
    assert.equal(r.val("power"), "1");
    r.cmd("prog_auto2", 0);
    assert.equal(r.val("prog_auto2"), "1");
    assert.equal(r.val("program"), "8195");
    r.cmd("program", 12345);
    assert.equal(r.val("program"), "8195", "неизвестная программа");
  });

  it("выбор программы после завершения мойки переводит машину в «Готова»", function () {
    const r = make({ scenario: "running" }).start();
    r.sim.skipToEnd();
    pass(2);
    assert.equal(r.val("state"), "Завершено");
    r.cmd("program", 8195);
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.val("finished"), "1", "посуда всё ещё не выгружена");
  });

  it("во время мойки программу сменить нельзя, питание не выключается", function () {
    const r = make({ scenario: "running" }).start();
    r.cmd("program", 8195);
    assert.equal(r.val("program"), "8196");
    assert.equal(r.note(), "Программу нельзя сменить во время мойки");
    r.cmd("prog_quick65", 1);
    assert.equal(r.val("prog_quick65"), "0");
    r.cmd("power", 0);
    assert.equal(r.val("power"), "1");
    assert.equal(r.val("state"), "Мойка");
    assert.equal(r.note(), "Выключение отменено: программа выполняется или отменяется");
  });

  it("опции: на выключенной машине включают её, меняют длительность и прогноз", function () {
    const r = make().start();
    const energy = Number(r.val("energy_forecast"));
    r.cmd("opt_variospeed", 1);
    assert.equal(r.val("opt_variospeed"), "1");
    assert.equal(r.val("power"), "1");
    pass(2);
    assert.equal(r.val("opt_variospeed"), "1");
    assert.equal(r.val("end_time"), "≈ 21:53, если запустить сейчас");   // 13500 / 2 = 1 ч 53 мин
    assert.equal(Number(r.val("energy_forecast")) > energy, true);
    r.cmd("opt_variospeed", 0);
    assert.equal(r.val("opt_variospeed"), "0");
  });

  it("тихий режим во время мойки включается на заданное в настройках время", function () {
    const r = make({ scenario: "running" }).start();
    r.cmd("set_silencetime", 20).cmd("opt_silence", 1);
    assert.equal(r.val("opt_silence"), "1");
    assert.equal(r.val("silence_left"), "20");
    r.cmd("opt_silence", 0);
    assert.equal(r.val("silence_left"), "0");
  });
});

describe("старт, ход программы, завершение", function () {
  it("старт сразу: Run, фазы по порядку, прогресс до 100, «Завершено»", function () {
    const r = make().ready();
    r.cmd("run", 1);
    assert.equal(r.val("state"), "Мойка");
    assert.equal(r.val("run"), "1");
    assert.equal(r.val("running"), "1");
    assert.equal(r.val("active_program"), "Эко 50°");
    assert.equal(r.val("progress"), "0");
    assert.equal(r.val("phase"), "Предополаскивание");
    assert.equal(r.val("remaining"), "3 ч 45 мин");
    assert.equal(r.val("remaining_min"), "225");
    assert.equal(r.val("remaining_sec"), "13500");
    assert.equal(r.val("end_time"), "23:45");
    assert.equal(r.note(), "▶ Мойка началась: Эко 50°, окончание ≈ 23:45");

    // скорость 60: минута программы за секунду, 225 секунд на всю программу
    const phases = [];
    let prev = 0;
    for (let i = 0; i < 224; i++) {
      pass(1);
      const pr = Number(r.val("progress"));
      assert.equal(pr >= prev, true, "прогресс не убывает");
      prev = pr;
      if (phases.indexOf(r.val("phase")) < 0) phases.push(r.val("phase"));
      assert.equal(r.val("state"), "Мойка");
    }
    assert.deepEqual(phases, ["Предополаскивание", "Мойка", "Ополаскивание", "Сушка"]);
    assert.equal(r.val("remaining_min"), "1");

    pass(1);
    assert.equal(r.val("state"), "Завершено");
    assert.equal(r.val("progress"), "100");
    assert.equal(r.val("run"), "0");
    assert.equal(r.val("running"), "0");
    assert.equal(r.val("finished"), "1");
    assert.equal(r.val("remaining"), "");
    assert.equal(r.val("remaining_min"), "0");
    assert.equal(r.val("active_program"), "");
    assert.equal(r.val("finished_at"), "10.03 20:03 (Эко 50°)");
    assert.equal(r.val("end_trigger"), "Завершена нормально");
    assert.equal(r.val("cycles"), "879");
    assert.equal(r.val("care_runs"), "18");
    assert.equal(r.val("last_message"), "10.03 20:03  ✅ Мойка завершена: Эко 50°. Можно разгружать");

    // машина выключается сама, «не разгружена» остаётся до открытия двери
    pass(11);
    assert.equal(r.val("state"), "Выключена");
    assert.equal(r.val("power"), "0");
    assert.equal(r.val("finished"), "1");
    r.sim.setDoor(true);
    assert.equal(r.val("finished"), "0");
    assert.equal(r.val("door_open"), "1");
  });

  it("старт выключенной машины: сначала питание, потом программа", function () {
    const r = make().start();
    r.cmd("start", 1);
    assert.equal(r.val("power"), "1");
    assert.equal(r.val("run"), "1");
    assert.equal(r.val("running"), "0");
    assert.equal(r.val("state"), "Готова");
    r.cmd("start", 1);                       // повторное нажатие ничего не меняет
    pass(2);
    assert.equal(r.val("state"), "Мойка");
    assert.equal(r.val("running"), "1");
    assert.equal(r.val("run"), "1");
  });

  it("skipToEnd: перемотка к концу программы и к концу задержки", function () {
    const r = make({ scenario: "running" }).start();
    r.sim.skipToEnd();
    assert.equal(r.val("state"), "Мойка");
    assert.equal(Number(r.val("remaining_min")) <= 2, true);
    pass(2);
    assert.equal(r.val("state"), "Завершено");

    const d = make().ready();
    d.cmd("delay_h", 5).cmd("run", 1);
    assert.equal(d.val("state"), "Отложенный старт");
    d.sim.skipToEnd();
    assert.equal(d.val("state"), "Мойка");
  });

  it("отказ в старте: дверь открыта, состояние возвращается", function () {
    const r = make().ready();
    r.sim.setDoor(true);
    r.cmd("run", 1);
    assert.equal(r.val("run"), "0");
    assert.equal(r.val("running"), "0");
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.note(), "Старт отменён: дверь открыта");
    assert.equal(r.count("run"), 2, "ответ на команду опубликован");
  });

  it("отказ в старте: удалённый старт не разрешён", function () {
    const r = make().ready();
    r.sim.setRemote(false);
    assert.equal(r.val("remote_start"), "0");
    r.cmd("start", 1);
    assert.equal(r.val("run"), "0");
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.note(), "Старт отменён: удалённый старт не разрешён — нажмите Remote Start на машине");
    r.sim.setRemote(true);
    r.cmd("start", 1);
    assert.equal(r.val("state"), "Мойка");
  });

  it("отказ после включения питания: «Мойка» держится включённой, пока машина включается", function () {
    const r = make().start();
    r.sim.setDoor(true);
    r.cmd("run", 1);
    assert.equal(r.val("run"), "1");
    pass(2);
    assert.equal(r.val("run"), "0");
    assert.equal(r.val("power"), "1");
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.note(), "Старт отменён: дверь открыта");
  });
});

describe("отложенный старт", function () {
  it("delay_h: «Отложенный старт», потом мойка", function () {
    const r = make().ready();
    r.cmd("delay_h", 2);
    assert.equal(r.val("delay_h"), "2");
    assert.equal(r.val("end_time"), "≈ 01:45 завтра, если запустить сейчас");
    r.cmd("run", 1);
    assert.equal(r.val("state"), "Отложенный старт");
    assert.equal(r.val("run"), "1");
    assert.equal(r.val("running"), "1");
    assert.equal(r.val("start_in"), "2 ч 00 мин (в 22:00)");
    assert.equal(r.val("end_time"), "01:45 завтра");
    assert.equal(r.val("remaining_sec"), String(7200 + 13500));
    assert.equal(r.val("active_program"), "Эко 50°");
    assert.equal(r.val("delay_h"), "0", "задержка задаётся на один запуск");
    assert.equal(r.note(), "⏰ Отложенный старт: Эко 50°, начнётся в 22:00, окончание ≈ 01:45 завтра");

    pass(119);
    assert.equal(r.val("state"), "Отложенный старт");
    assert.equal(r.val("start_in").indexOf("1 мин"), 0);
    pass(1);
    assert.equal(r.val("state"), "Мойка");
    assert.equal(r.val("start_in"), "");
    assert.match(r.note(), /^▶ Мойка началась: Эко 50°, окончание ≈ \d\d:\d\d/);
    assert.equal(r.val("remaining_min"), "225");
  });

  it("delay_h: границы и мусор", function () {
    const r = make().ready();
    assert.equal(r.cmd("delay_h", 99).val("delay_h"), "24");
    assert.equal(r.cmd("delay_h", -3).val("delay_h"), "0");
    assert.equal(r.cmd("delay_h", "2.6").val("delay_h"), "3");
    assert.equal(r.cmd("delay_h", "много").val("delay_h"), "3");
  });

  it("finish_at: старт рассчитывается от времени окончания", function () {
    const r = make().ready();
    r.cmd("finish_at", "07:30");
    assert.equal(r.val("finish_at"), "07:30");
    assert.equal(r.val("end_time"), "≈ 07:30 завтра, если запустить сейчас");
    r.cmd("run", 1);
    assert.equal(r.val("state"), "Отложенный старт");
    assert.equal(r.val("start_in"), "7 ч 45 мин (в 03:45 завтра)");
    assert.equal(r.val("end_time"), "07:30 завтра");
    assert.equal(r.val("finish_at"), "");
    assert.equal(r.note(), "⏰ Отложенный старт: Эко 50°, начнётся в 03:45 завтра, окончание ≈ 07:30 завтра");
  });

  it("finish_at важнее delay_h; запись через точку; не успевает — старт сразу", function () {
    const r = make().ready();
    r.cmd("delay_h", 5).cmd("finish_at", "0.30");
    assert.equal(r.val("end_time"), "≈ 00:30 завтра, если запустить сейчас");
    r.cmd("finish_at", "21:00");                          // до 21:00 час, программа идёт 3:45
    assert.equal(r.val("end_time"), "≈ 23:45, если запустить сейчас");
    r.cmd("run", 1);
    assert.equal(r.val("state"), "Мойка");
    assert.equal(r.val("finish_at"), "");
    assert.equal(r.val("delay_h"), "0");
  });

  it("finish_at с ошибкой: прогноза нет, старт отклонён", function () {
    const r = make().ready();
    r.cmd("finish_at", "25:00");
    assert.equal(r.val("end_time"), "");
    r.cmd("run", 1);
    assert.equal(r.val("run"), "0");
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.note(), "Неверное время «Завершить к»: «25:00», нужно ЧЧ:ММ");
    r.cmd("finish_at", " ");                              // так поле очищает страница
    assert.equal(r.val("finish_at"), " ");
    assert.equal(r.val("end_time"), "≈ 23:45, если запустить сейчас");
  });
});

describe("отмена", function () {
  it("идущая программа: «Отмена программы», через несколько секунд «Готова»", function () {
    const r = make({ scenario: "running" }).start();
    r.cmd("abort", 1);
    assert.equal(r.val("state"), "Отмена программы");
    assert.equal(r.val("running"), "1");
    assert.equal(r.val("run"), "1");
    assert.equal(r.note(), "Команда отмены программы");
    r.cmd("run", 0);
    assert.equal(r.note(), "Машина уже отменяет программу");
    r.cmd("opt_extradry", 1);
    assert.equal(r.val("opt_extradry"), "0");
    pass(3);
    assert.equal(r.val("state"), "Отмена программы");
    pass(1);
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.val("run"), "0");
    assert.equal(r.val("running"), "0");
    assert.equal(r.val("progress"), "0");
    assert.equal(r.val("phase"), "");
    assert.equal(r.val("active_program"), "");
    assert.equal(r.val("end_trigger"), "Отменена пользователем");
    assert.equal(r.val("finished"), "0");
    assert.equal(r.val("cycles"), "878");
    assert.equal(r.note(), "⛔ Программа прервана");
  });

  it("выключатель «Мойка» отменяет отложенный старт", function () {
    const r = make().ready();
    r.cmd("delay_h", 3).cmd("run", 1);
    assert.equal(r.val("state"), "Отложенный старт");
    r.cmd("run", 0);
    assert.equal(r.val("state"), "Отмена программы");
    pass(2);
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.val("start_in"), "");
    assert.equal(r.val("run"), "0");
  });

  it("отмена, пока машина включается: старта не будет", function () {
    const r = make().start();
    r.cmd("run", 1);
    assert.equal(r.val("run"), "1");
    r.cmd("run", 0);
    assert.equal(r.val("run"), "0");
    assert.equal(r.note(), "Старт отменён пользователем");
    pass(5);
    assert.equal(r.val("state"), "Готова");
    assert.equal(r.val("running"), "0");
  });

  it("выключение питания, пока машина включается: старт отменён, машина выключена", function () {
    const r = make().start();
    r.cmd("run", 1).cmd("power", 0);
    assert.equal(r.val("run"), "0");
    assert.equal(r.val("power"), "0");
    assert.equal(r.val("state"), "Выключена");
    assert.equal(r.note(), "Старт отменён пользователем");
    pass(5);
    assert.equal(r.val("state"), "Выключена");
  });

  it("нечего отменять", function () {
    const r = make().ready();
    r.cmd("abort", 1);
    assert.equal(r.note(), "Нечего отменять: программа не запущена");
    assert.equal(r.val("state"), "Готова");
    r.cmd("run", 0);
    assert.equal(r.val("run"), "0");
  });
});

describe("пульт демо и настройки", function () {
  it("setFlag: индикаторы, уровни расходников, авария", function () {
    const r = make().start();
    assert.equal(r.val("rinse_low"), "1");
    assert.equal(r.val("rinse_level"), "10");
    assert.equal(r.val("salt_level"), "100");
    assert.equal(r.val("alarm"), "0");
    assert.equal(r.val("alarm_text"), "Нет");

    r.sim.setFlag("salt_low", true);
    assert.equal(r.val("salt_low"), "1");
    assert.equal(r.val("salt_level"), "10");
    r.sim.setFlag("salt_empty", true);
    assert.equal(r.val("salt_empty"), "1");
    assert.equal(r.val("salt_level"), "0");
    r.sim.setFlag("rinse_low", false);
    assert.equal(r.val("rinse_level"), "100");
    r.sim.setFlag("filter_check", true);
    assert.equal(r.val("filter_check"), "1");
    assert.equal(r.val("alarm"), "0", "расходники — не авария");

    r.sim.setFlag("aquastop", true);
    assert.equal(r.val("aquastop"), "1");
    assert.equal(r.val("alarm"), "1");
    assert.equal(r.val("alarm_text"), "Сработал AquaStop — возможна протечка!");
    r.sim.setFlag("aquastop", false);
    assert.equal(r.val("alarm"), "0");
    assert.equal(r.val("alarm_text"), "Нет");
  });

  it("setOnline: без связи программа стоит, команды отклоняются", function () {
    const r = make({ scenario: "running" }).start();
    r.sim.setOnline(false);
    assert.equal(r.val("online"), "0");
    assert.equal(r.note(), "Потеряна связь с машиной");
    const n = r.out.length;
    r.sim.setOnline(false);
    assert.equal(r.out.length, n, "повтор ничего не публикует");
    pass(30);
    assert.equal(r.val("remaining_min"), "144");

    r.cmd("set_sound", 0);
    assert.equal(r.val("set_sound"), "2");
    assert.equal(r.note(), "Команда не отправлена: нет связи с машиной");
    r.cmd("power", 0);
    assert.equal(r.val("power"), "1");
    r.cmd("delay_h", 4);
    assert.equal(r.val("delay_h"), "4");

    r.sim.setOnline(true);
    assert.equal(r.val("online"), "1");
    assert.equal(r.note(), "Связь с машиной восстановлена");
    pass(1);
    assert.equal(r.val("remaining_min"), "143");
  });

  it("без связи старт отклоняется со своим сообщением", function () {
    const r = make().ready();
    r.sim.setOnline(false);
    r.cmd("run", 1);
    assert.equal(r.val("run"), "0");
    assert.equal(r.note(), "Старт невозможен: нет связи с машиной (hcpy)");
    r.cmd("start", 1);
    assert.equal(r.note(), "Старт невозможен: нет связи с машиной (hcpy)");
  });

  it("настройки: запись возвращается эхом", function () {
    const r = make().ready();
    assert.equal(r.val("set_infolight"), "1");
    assert.equal(r.cmd("set_infolight", 0).val("set_infolight"), "0");
    assert.equal(r.cmd("set_cloud", "true").val("set_cloud"), "1");
    assert.equal(r.cmd("set_sound", 3).val("set_sound"), "3");
    assert.equal(r.cmd("set_hardness", 7).val("set_hardness"), "7");
    assert.equal(r.cmd("set_silencetime", 12).val("set_silencetime"), "12");
    assert.equal(r.cmd("set_silencetime", 500).val("set_silencetime"), "30");
    assert.equal(r.cmd("set_silencetime", 0).val("set_silencetime"), "1");
    assert.equal(r.cmd("set_silencetime", "x").val("set_silencetime"), "1");
  });

  it("настройка-перечисление: недопустимое значение отклоняется", function () {
    const r = make().ready();
    r.cmd("set_hotwater", 2);
    assert.equal(r.val("set_hotwater"), "0");
    assert.equal(r.note(), "Недопустимое значение для «подключение воды»: 2, можно: 0, 1");
    assert.equal(r.count("set_hotwater"), 2);
  });
});

// ---------------------------------------------------------------------------
// Транспорт демо-режима
// ---------------------------------------------------------------------------
describe("SimTransport", function () {
  let ts;
  function transport(opts) {
    const t = new Sim.SimTransport(Object.assign({ scenario: "idle", now: function () { return clock; } }, opts || {}));
    t.statuses = [];
    t.msgs = [];
    t.onStatus = function (s) { t.statuses.push(s); };
    t.onMessage = function (topic, payload, retained) { t.msgs.push([topic, payload, retained]); };
    t.val = function (id) {
      for (let i = t.msgs.length - 1; i >= 0; i--) if (t.msgs[i][0] === C + id) return t.msgs[i][1];
      return "";
    };
    ts.push(t);
    return t;
  }
  beforeEach(function () { ts = []; });
  afterEach(function () { ts.forEach(function (t) { t.close(); }); });

  it("подключение: connecting, затем connected и retained-снимок", function () {
    const t = transport();
    t.subscribe(["/devices/dishwasher/#"]);
    assert.equal(t.publish(C + "power/on", "1"), false, "до подключения команды не уходят");
    t.connect();
    assert.deepEqual(t.statuses, ["connecting"]);
    mock.timers.tick(349);
    assert.equal(t.connected, false);
    assert.deepEqual(t.msgs, []);
    mock.timers.tick(1);
    assert.equal(t.connected, true);
    assert.deepEqual(t.statuses, ["connecting", "connected"]);
    assert.equal(t.msgs.length > 100, true);
    assert.equal(t.msgs.every(function (m) { return m[2] === true; }), true);
    assert.equal(t.val("state"), "Выключена");
  });

  it("команда доходит с небольшой задержкой, ответ приходит без признака retained", function () {
    const t = transport();
    t.connect();
    mock.timers.tick(350);
    const n = t.msgs.length;
    assert.equal(t.publish(C + "power/on", 1), true);
    mock.timers.tick(119);
    assert.equal(t.msgs.length, n);
    mock.timers.tick(1);
    assert.equal(t.val("power"), "1");
    assert.equal(t.msgs.slice(n).every(function (m) { return m[2] === false; }), true);
  });

  it("время идёт само: секунда настоящего времени — минута программы", function () {
    const t = transport({ scenario: "running" });
    t.connect();
    mock.timers.tick(350);
    assert.equal(t.val("remaining_min"), "144");
    pass(10);
    assert.equal(t.val("remaining_min"), "134");
  });

  it("close(): closed, сообщения и команды прекращаются", function () {
    const t = transport({ scenario: "running" });
    t.connect();
    mock.timers.tick(350);
    t.publish(C + "abort/on", "1");          // команда в пути
    t.close();
    assert.equal(t.connected, false);
    assert.deepEqual(t.statuses, ["connecting", "connected", "closed"]);
    const n = t.msgs.length;
    assert.equal(t.publish(C + "power/on", "0"), false);
    pass(20);
    assert.equal(t.msgs.length, n);
    assert.equal(t.sim.m.op, "Run", "команда, не дошедшая до закрытия, не выполняется");
    assert.equal(t.sim.timer, null);
  });

  it("close() до подключения: имитация не запускается", function () {
    const t = transport();
    t.connect();
    mock.timers.tick(100);
    t.close();
    pass(5);
    assert.equal(t.connected, false);
    assert.deepEqual(t.statuses, ["connecting", "closed"]);
    assert.deepEqual(t.msgs, []);
    assert.equal(t.sim.timer, null);
  });

  it("повторный connect() не запускает вторую имитацию; после close() можно подключиться снова", function () {
    const t = transport({ scenario: "running" });
    t.connect();
    t.connect();
    mock.timers.tick(350);
    t.connect();
    assert.deepEqual(t.statuses, ["connecting", "connected"]);
    const snapshot = t.msgs.length;
    pass(10);
    assert.equal(t.val("remaining_min"), "134", "время идёт с обычной скоростью");
    t.close();
    t.connect();
    mock.timers.tick(350);
    assert.deepEqual(t.statuses, ["connecting", "connected", "closed", "connecting", "connected"]);
    assert.equal(t.msgs.filter(function (m) { return m[2]; }).length, snapshot * 2, "снимок выдан заново");
    assert.equal(t.val("remaining_min"), "134");
  });
});
