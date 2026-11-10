"use strict";
// Тесты состояния экрана (web/app/js/model.js): что derive() собирает из контролов правила
// в каждом режиме машины. Контролы даёт имитация (web/app/js/sim.js) через демо-транспорт,
// редкие состояния подаются руками.
//   node --test tests/web_model.test.js
// Время поддельное: 10.03.2026, 20:00 по Москве; таймеры — mock.timers.
process.env.TZ = "Europe/Moscow";

const { describe, it, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const START = Date.UTC(2026, 2, 10, 17, 0, 0);
const P = "/devices/dishwasher/";
const C = P + "controls/";

let Sim, Store, M;
before(async function () {
  Sim = await import("../web/app/js/sim.js");
  Store = await import("../web/app/js/store.js");
  M = await import("../web/app/js/model.js");
});

let clock = START;
let stores = [];

// Страница в демо-режиме: имитация, транспорт, хранилище. По умолчанию машина выключена.
function rig(opts) {
  const t = new Sim.SimTransport(Object.assign({ now: function () { return clock; }, scenario: "idle" }, opts || {}));
  const store = new Store.DeviceStore({ transport: t });
  stores.push(store);
  store.start();
  const r = {
    t: t, sim: t.sim, store: store,
    view: function (waitOver) { return M.derive(store, !!waitOver); },
    /** подключиться и получить retained-снимок */
    up: function () { mock.timers.tick(350); return r; },
    /** команда со страницы и ответ имитации */
    set: function (id, v) { store.set(id, v); mock.timers.tick(120); return r; },
    press: function (id) { store.press(id); mock.timers.tick(120); return r; },
    /** включить машину и дождаться «Готова» */
    on: function () { r.set("power", true); mock.timers.tick(1500); return r; },
    /** состояние машины напрямую — для того, чего командами не добиться */
    op: function (op) { t.sim.m.op = op; t.sim.sync(); return r; },
  };
  return r;
}

// Хранилище без имитации: значения и метаданные подаются руками
function bare(values, link) {
  const t = { subscribe: function () {}, connect: function () {}, publish: function () { return true; }, close: function () {} };
  const store = new Store.DeviceStore({ transport: t });
  stores.push(store);
  store.start();
  if (link !== false) t.onStatus(link || "connected");
  const r = {
    store: store, t: t,
    feed: function (vals) {
      Object.keys(vals).forEach(function (id) { store.handleMessage(C + id, String(vals[id]), true); });
      return r;
    },
    meta: function (id, m) { store.handleMessage(C + id + "/meta", JSON.stringify(m), true); return r; },
    view: function (waitOver) { return M.derive(store, !!waitOver); },
  };
  return r.feed(values || {});
}

// Секунды настоящего времени: идут и часы, и таймеры
function pass(sec) {
  for (let i = 0; i < sec; i++) { clock += 1000; mock.timers.tick(1000); }
}

beforeEach(function () {
  clock = START;
  stores = [];
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
});
afterEach(function () {
  stores.forEach(function (s) { s.stop(); });
  mock.timers.reset();
});

// ---------------------------------------------------------------------------
describe("связь", function () {
  it("подключение к брокеру: данных нет, действие недоступно", function () {
    const v = rig().view();
    assert.equal(v.link, "connecting");
    assert.equal(v.online, false);
    assert.equal(v.loaded, false);
    assert.equal(v.mode, "offline");
    assert.equal(v.busy, false);
    assert.equal(v.stateText, "Нет связи");
    assert.equal(v.headline, "Нет связи");
    assert.deepEqual(v.dial, { icon: "wifi-off", label: "", value: "Нет связи", sub: "", ring: 0, tone: "off", wave: false });
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Нет связи с машиной", disabled: true });
    assert.equal(v.canPower, false);
    assert.equal(v.canSelect, false);
    assert.deepEqual(v.programs, []);
    assert.equal(v.selected, null);
    assert.deepEqual(v.issues, []);
    assert.deepEqual(v.facts, []);
  });

  it("брокер подключён, устройства ещё нет: ждём, потом «устройство не найдено»", function () {
    const b = bare();
    assert.equal(b.view(false).link, "connecting");
    assert.equal(b.view(true).link, "nodevice");
    assert.equal(b.view(true).mode, "offline");
    assert.equal(b.view(true).loaded, false);
    // одни метаданные (кнопки, пустой текст) — ещё не устройство
    b.meta("start", { type: "pushbutton" });
    assert.equal(b.view(true).link, "nodevice");
    b.feed({ online: 1, state: "Готова" });
    assert.equal(b.view(true).link, "ok");
  });

  it("связь с брокером потеряна: последнее известное остаётся, управлять нельзя", function () {
    const r = rig({ scenario: "running" }).up();
    assert.equal(r.view().link, "ok");
    r.t.onStatus("reconnecting", "соединение потеряно");
    let v = r.view();
    assert.equal(v.link, "broker");
    assert.equal(v.loaded, true);
    assert.equal(v.online, false);
    assert.equal(v.mode, "offline");
    assert.equal(v.headline, "Нет связи");
    assert.equal(v.dial.value, "Нет связи");
    assert.equal(v.action.disabled, true);
    assert.equal(v.busy, false);
    assert.equal(v.programs.length, 8, "список программ виден");
    r.t.onStatus("closed");
    assert.equal(r.view().link, "broker");
    r.t.onStatus("connecting");
    assert.equal(r.view().link, "connecting");
    r.t.onStatus("connected");
    v = r.view();
    assert.equal(v.link, "ok");
    assert.equal(v.mode, "running");
  });

  it("машина не на связи с контроллером", function () {
    const r = rig().up().on();
    r.sim.setOnline(false);
    const v = r.view();
    assert.equal(v.link, "machine");
    assert.equal(v.online, false);
    assert.equal(v.loaded, true);
    assert.equal(v.mode, "offline");
    assert.equal(v.headline, "Машина не на связи");
    assert.equal(v.stateText, "Нет связи");
    assert.deepEqual(v.dial, { icon: "wifi-off", label: "", value: "Нет связи", sub: "", ring: 0, tone: "off", wave: false });
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Нет связи с машиной", disabled: true });
    assert.equal(v.canPower, false);
    assert.equal(v.canSelect, false);
    r.sim.setOnline(true);
    assert.equal(r.view().link, "ok");
    assert.equal(r.view().mode, "ready");
  });
});

// ---------------------------------------------------------------------------
describe("машина свободна", function () {
  it("выключена", function () {
    const v = rig().up().view();
    assert.equal(v.link, "ok");
    assert.equal(v.online, true);
    assert.equal(v.loaded, true);
    assert.equal(v.mode, "off");
    assert.equal(v.busy, false);
    assert.equal(v.power, false);
    assert.equal(v.stateText, "Выключена");
    assert.equal(v.headline, "Выключена");
    assert.deepEqual(v.dial, { icon: "power", label: "", value: "Выключена", sub: "", ring: 0, tone: "off", wave: false });
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Окончание ≈ 23:45", disabled: false });
    assert.equal(v.canPower, true);
    assert.equal(v.powerHint, "");
    assert.equal(v.canSelect, true);
    assert.equal(v.schedule, "now");
    assert.equal(v.phaseIndex, -1);
    assert.equal(v.unloadPending, false);
  });

  it("готова: на циферблате выбранная программа", function () {
    const v = rig().up().on().view();
    assert.equal(v.mode, "ready");
    assert.equal(v.power, true);
    assert.equal(v.headline, "Готова");
    assert.deepEqual(v.dial, { icon: "leaf", label: "", value: "Эко 50°", sub: "готова к запуску", ring: 0, tone: "idle", wave: false });
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Окончание ≈ 23:45", disabled: false });
    assert.equal(v.programTitle, "Эко 50°");
    assert.equal(v.canSelect, true);
    assert.equal(v.canPower, true);
  });

  it("программы: из enum контрола program, с ключом, подсказкой и отметкой выбранной", function () {
    const r = rig().up().on();
    const v = r.view();
    assert.deepEqual(v.programs.map(function (p) { return [p.uid, p.key, p.title, p.hint.icon, p.selected, p.ctrl]; }), [
      ["8192", "Intensiv70", "Интенсивная 70°", "flame", false, null],
      ["8195", "Auto2", "Авто 45–65°", "gauge", false, null],
      ["8196", "Eco50", "Эко 50°", "leaf", true, null],
      ["8200", "PreRinse", "Предварительное ополаскивание", "droplets", false, null],
      ["8202", "NightWash", "Тихая (ночная)", "moon", false, null],
      ["8203", "Quick65", "Быстрая 65°", "zap", false, null],
      ["8215", "MachineCare", "Уход за машиной", "sparkles", false, null],
      ["32828", "001", "Избранное", "star", false, null],
    ]);
    assert.equal(v.selected.uid, "8196");

    // выбор виден сразу, до ответа правила
    r.store.set("program", 8203);
    assert.equal(r.view().selected.title, "Быстрая 65°");
    assert.equal(r.view().dial.value, "Быстрая 65°");
    assert.equal(r.view().dial.icon, "zap");
    mock.timers.tick(120);
    assert.equal(r.store.pending("program"), undefined);
    assert.equal(r.view().selected.uid, "8203");
    assert.equal(r.view().action.hint, "Окончание ≈ 21:00");
  });

  it("программа не выбрана: запуск недоступен", function () {
    const r = rig().up().on();
    r.sim.m.program = 0;
    r.sim.sync();
    const v = r.view();
    assert.equal(v.selected, null);
    assert.equal(v.programTitle, "");
    assert.deepEqual(v.dial, { icon: "waves", label: "", value: "Готова", sub: "", ring: 0, tone: "idle", wave: false });
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Выберите программу", disabled: true });
  });

  it("дверь открыта: запуск недоступен, замечание без счётчика внимания", function () {
    const r = rig().up().on();
    r.sim.setFlag("rinse_low", false);
    r.sim.setDoor(true);
    const v = r.view();
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Закройте дверь машины", disabled: true });
    assert.deepEqual(v.issues, [{ id: "door", level: "info", text: "Дверь открыта" }]);
    assert.equal(v.attention, 0);
    assert.equal(v.dial.value, "Эко 50°", "циферблат прежний");
    r.sim.setDoor(false);
    assert.equal(r.view().action.disabled, false);
    assert.deepEqual(r.view().issues, []);
  });

  it("удалённый старт не разрешён: подсказка, но кнопка работает", function () {
    const r = rig().up().on();
    r.sim.setRemote(false);
    assert.deepEqual(r.view().action,
      { kind: "start", label: "Запустить", hint: "На машине не разрешён удалённый старт", disabled: false });
    // дверь важнее
    r.sim.setDoor(true);
    assert.equal(r.view().action.hint, "Закройте дверь машины");
    r.sim.setDoor(false);
    // у выключенной машины признак ничего не значит
    r.set("power", false);
    assert.equal(r.view().mode, "off");
    assert.equal(r.view().action.hint, "Окончание ≈ 23:45");
  });

  it("у модели нет признака удалённого старта — подсказки нет", function () {
    const b = bare({ online: 1, power: 1, state: "Готова", program: 8196, end_time: "≈ 23:45, если запустить сейчас" });
    b.meta("program", { type: "value", enum: { 8196: { en: "Eco50", ru: "Эко 50°" } } });
    assert.deepEqual(b.view().action, { kind: "start", label: "Запустить", hint: "Окончание ≈ 23:45", disabled: false });
    b.feed({ end_time: "" });
    assert.equal(b.view().action.hint, "");
  });

  it("отложить на часы: подпись кнопки и прогноз окончания", function () {
    const r = rig().up().on();
    let v = r.view();
    assert.equal(v.hasDelay, true);
    assert.equal(v.delayH, 0);
    assert.equal(v.delayMax, 24);
    r.store.set("delay_h", 2);
    v = r.view();
    assert.equal(v.delayH, 2, "видно сразу, до ответа правила");
    assert.equal(v.schedule, "delay");
    assert.equal(v.action.label, "Запустить через 2 ч");
    mock.timers.tick(120);
    v = r.view();
    assert.equal(v.schedule, "delay");
    assert.deepEqual(v.action, { kind: "start", label: "Запустить через 2 ч", hint: "Окончание ≈ 01:45 завтра", disabled: false });
    r.set("delay_h", 0);
    assert.equal(r.view().schedule, "now");
    assert.equal(r.view().action.label, "Запустить");
  });

  it("завершить к времени: важнее задержки в часах", function () {
    const r = rig().up().on();
    r.set("delay_h", 3).set("finish_at", "07:30");
    let v = r.view();
    assert.equal(v.schedule, "finish");
    assert.equal(v.finishAt, "07:30");
    assert.deepEqual(v.action, { kind: "start", label: "Запустить к 07:30", hint: "Окончание ≈ 07:30 завтра", disabled: false });
    // очистка поля пробелом
    r.set("finish_at", " ");
    v = r.view();
    assert.equal(v.finishAt, "");
    assert.equal(v.schedule, "delay");
    assert.equal(v.action.label, "Запустить через 3 ч");
  });

  it("старое правило без delay_h и finish_at", function () {
    const v = bare({ online: 1, power: 1, state: "Готова" }).view();
    assert.equal(v.hasDelay, false);
    assert.equal(v.delayH, 0);
    assert.equal(v.delayMax, 24);
    assert.equal(v.finishAt, "");
    assert.equal(v.schedule, "now");
  });

  it("состояние неизвестно: управлять нельзя", function () {
    const b = bare({ online: 1, power: 1, state: "Что-то новое", program: 8196 });
    let v = b.view();
    assert.equal(v.mode, "unknown");
    assert.equal(v.headline, "Что-то новое");
    assert.deepEqual(v.dial, { icon: "", label: "", value: "—", sub: "", ring: 0, tone: "off", wave: false });
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Нет данных о состоянии машины", disabled: true });
    assert.equal(v.canSelect, false);
    b.feed({ state: "" });
    v = b.view();
    assert.equal(v.mode, "unknown");
    assert.equal(v.stateText, "Нет данных");
    assert.equal(v.headline, "Нет данных");
  });
});

// ---------------------------------------------------------------------------
describe("запуск и ход программы", function () {
  it("запуск выключенной машины: «Запуск», можно отменить", function () {
    const r = rig().up();
    r.set("run", true);
    let v = r.view();
    assert.equal(v.mode, "starting");
    assert.equal(v.busy, true);
    assert.equal(v.power, true);
    assert.deepEqual(v.dial, { icon: "loader-circle", label: "", value: "Запуск", sub: "машина включается", ring: 0, tone: "wait", wave: false });
    assert.deepEqual(v.action, { kind: "cancel", label: "Отменить запуск", hint: "", disabled: false });
    assert.equal(v.canSelect, false);
    assert.equal(v.canPower, false);
    assert.equal(v.powerHint, "Во время программы питание не отключается");
    mock.timers.tick(1500);
    v = r.view();
    assert.equal(v.mode, "running");
    assert.equal(v.dial.label, "Осталось");
    assert.equal(v.dial.value, "3:45");
  });

  it("идёт мойка", function () {
    const r = rig({ scenario: "running" }).up();
    const v = r.view();
    assert.equal(v.mode, "running");
    assert.equal(v.busy, true);
    assert.equal(v.power, true);
    assert.equal(v.stateText, "Мойка");
    assert.equal(v.headline, "Мойка · Эко 50°");
    assert.equal(v.programTitle, "Эко 50°");
    assert.deepEqual(v.dial, { icon: "", label: "Осталось", value: "2:24", sub: "до 22:24", ring: 36, tone: "run", wave: true });
    assert.equal(v.progress, 36);
    assert.equal(v.remainingMin, 144);
    assert.equal(v.phase, "Мойка");
    assert.equal(v.phaseIndex, 1);
    assert.deepEqual(v.action, { kind: "abort", label: "Отменить программу", hint: "", disabled: false });
    assert.equal(v.canSelect, false);
    assert.equal(v.canPower, false);
    assert.equal(v.powerHint, "Во время программы питание не отключается");
    assert.equal(v.schedule, "now");
  });

  it("фазы по порядку; на сушке волны нет; в конце — проценты", function () {
    const r = rig({ scenario: "running" }).up();
    const seen = [];
    [13500, 11000, 5000, 3000, 20].forEach(function (rem) {
      r.sim.m.rem = rem;
      r.sim._advance(0);
      r.sim.sync();
      const v = r.view();
      seen.push([v.phase, v.phaseIndex, v.dial.wave, v.dial.value]);
    });
    assert.deepEqual(seen, [
      ["Предополаскивание", 0, true, "3:45"],
      ["Мойка", 1, true, "3:03"],
      ["Ополаскивание", 2, true, "1:23"],
      ["Сушка", 3, false, "0:50"],
      ["Сушка", 3, false, "100%"],
    ]);
    assert.deepEqual(M.PHASES, ["Предополаскивание", "Мойка", "Ополаскивание", "Сушка"]);
  });

  it("активная программа важнее выбранной", function () {
    const r = rig({ scenario: "running" }).up();
    r.sim.m.program = 8203;
    r.sim.sync();
    const v = r.view();
    assert.equal(v.selected.title, "Быстрая 65°");
    assert.equal(v.programTitle, "Эко 50°");
    assert.equal(v.headline, "Мойка · Эко 50°");
  });

  it("пауза", function () {
    const v = rig({ scenario: "running" }).up().op("Pause").view();
    assert.equal(v.mode, "paused");
    assert.equal(v.busy, true);
    assert.equal(v.headline, "Пауза · Эко 50°");
    assert.deepEqual(v.dial, { icon: "", label: "Пауза", value: "2:24", sub: "до 22:24", ring: 36, tone: "warn", wave: false });
    assert.equal(v.phaseIndex, 1);
    assert.deepEqual(v.action, { kind: "abort", label: "Отменить программу", hint: "", disabled: false });
  });

  it("машина ждёт действия: замечание, прогноз «если запустить сейчас» на циферблат не попадает", function () {
    const r = rig({ scenario: "running" }).up().op("ActionRequired");
    r.sim.setFlag("rinse_low", false);
    const v = r.view();
    assert.equal(r.store.text("end_time"), "≈ 23:45, если запустить сейчас", "так публикует и правило");
    assert.equal(v.mode, "action");
    assert.equal(v.busy, true);
    assert.equal(v.headline, "Требуется действие");
    assert.deepEqual(v.dial, { icon: "", label: "Ждёт вас", value: "36%", sub: "", ring: 36, tone: "warn", wave: false });
    assert.equal(v.phaseIndex, 1);
    assert.deepEqual(v.issues, [{ id: "action", level: "warn", text: "Машина ждёт действия — посмотрите на её дисплей" }]);
    assert.equal(v.attention, 1);
    assert.deepEqual(v.action, { kind: "abort", label: "Отменить программу", hint: "", disabled: false });
  });

  it("мойка завершена: «Чисто», пока не открыли дверь, даже когда машина выключилась", function () {
    const r = rig({ scenario: "running" }).up();
    r.sim.skipToEnd();
    pass(2);
    let v = r.view();
    assert.equal(v.mode, "finished");
    assert.equal(v.busy, false);
    assert.equal(v.unloadPending, true);
    assert.equal(v.headline, "Завершено");
    assert.deepEqual(v.dial, { icon: "check", label: "", value: "Чисто", sub: "можно разгружать", ring: 100, tone: "ok", wave: false });
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Окончание ≈ 23:45", disabled: false });
    assert.equal(v.canSelect, true);
    assert.equal(v.canPower, true);
    assert.equal(v.phaseIndex, -1);
    assert.equal(v.finishedAt, "10.03 20:00 (Эко 50°)");

    pass(15);                                   // машина выключается сама
    v = r.view();
    assert.equal(v.mode, "off");
    assert.equal(v.dial.value, "Чисто");
    assert.equal(v.dial.ring, 100);

    r.sim.setDoor(true);
    v = r.view();
    assert.equal(v.unloadPending, false);
    assert.deepEqual(v.dial, { icon: "power", label: "", value: "Выключена", sub: "", ring: 0, tone: "off", wave: false });
  });

  it("включили после мойки, посуда ещё внутри: «Чисто»", function () {
    const b = bare({ online: 1, power: 1, state: "Готова", finished: 1, program: 8196 });
    assert.equal(b.view().dial.value, "Чисто");
    b.feed({ finished: 0 });
    assert.equal(b.view().dial.value, "Готова");
  });

  it("ошибка машины", function () {
    const v = rig().up().on().op("Error").view();
    assert.equal(v.mode, "error");
    assert.equal(v.headline, "Ошибка");
    assert.deepEqual(v.dial, { icon: "triangle-alert", label: "", value: "Ошибка", sub: "смотрите дисплей машины", ring: 0, tone: "error", wave: false });
    assert.deepEqual(v.action, { kind: "start", label: "Запустить", hint: "Машина сообщает об ошибке", disabled: true });
    assert.equal(v.canSelect, false);
    assert.equal(v.canPower, true);
  });
});

// ---------------------------------------------------------------------------
describe("отложенный старт и отмена", function () {
  it("отложенный старт", function () {
    const r = rig().up().on();
    r.set("delay_h", 2).press("start");
    const v = r.view();
    assert.equal(v.mode, "delayed");
    assert.equal(v.busy, true);
    assert.equal(v.headline, "Отложенный старт");
    assert.deepEqual(v.dial, { icon: "", label: "Старт через", value: "2 ч 00 мин", sub: "в 22:00", ring: 0, tone: "wait", wave: false });
    assert.equal(v.startInDur, "2 ч 00 мин");
    assert.equal(v.startAt, "22:00");
    assert.deepEqual(v.action, { kind: "abort", label: "Отменить отложенный старт", hint: "Окончание в 01:45 завтра", disabled: false });
    assert.equal(v.schedule, "now", "задержка действует на один запуск");
    assert.equal(v.delayH, 0);
    assert.equal(v.phaseIndex, -1);
    assert.equal(v.canSelect, false);
    assert.equal(v.canPower, false);
  });

  it("отложенный старт по «Завершить к»: поле очищается, старт на завтра", function () {
    const r = rig().up().on();
    r.set("finish_at", "07:30").set("run", true);
    const v = r.view();
    assert.equal(v.mode, "delayed");
    assert.equal(v.dial.value, "7 ч 45 мин");
    assert.equal(v.dial.sub, "в 03:45 завтра");
    assert.equal(v.action.hint, "Окончание в 07:30 завтра");
    assert.equal(v.finishAt, "");
    assert.equal(v.schedule, "now");
  });

  it("start_in без времени и пустой", function () {
    const b = bare({ online: 1, power: 1, state: "Отложенный старт", running: 1, run: 1, start_in: "45 мин" });
    let v = b.view();
    assert.equal(v.dial.value, "45 мин");
    assert.equal(v.dial.sub, "");
    assert.equal(v.action.hint, "");
    b.feed({ start_in: "" });
    v = b.view();
    assert.equal(v.dial.value, "…");
  });

  it("отмена программы: кнопка недоступна, пока машина не закончит", function () {
    const r = rig({ scenario: "running" }).up();
    r.press("abort");
    let v = r.view();
    assert.equal(v.mode, "aborting");
    assert.equal(v.busy, true);
    assert.equal(v.headline, "Отмена программы");
    assert.deepEqual(v.dial, { icon: "loader-circle", label: "", value: "Отмена", sub: "машина завершает программу", ring: 0, tone: "warn", wave: false });
    assert.deepEqual(v.action, { kind: "abort", label: "Отмена программы…", hint: "", disabled: true });
    assert.equal(v.canSelect, false);
    assert.equal(v.phaseIndex, -1);
    mock.timers.tick(4000);
    v = r.view();
    assert.equal(v.mode, "ready");
    assert.equal(v.busy, false);
    assert.equal(v.action.kind, "start");
    assert.equal(v.action.disabled, false);
    assert.equal(v.unloadPending, false);
    assert.equal(v.dial.value, "Эко 50°");
  });

  it("отмена отложенного старта и отмена запуска", function () {
    let r = rig().up().on();
    r.set("delay_h", 1).set("run", true);
    assert.equal(r.view().mode, "delayed");
    r.set("run", false);
    assert.equal(r.view().mode, "aborting");
    mock.timers.tick(1500);
    assert.equal(r.view().mode, "ready");

    r = rig().up();
    r.set("run", true);
    assert.equal(r.view().mode, "starting");
    r.set("run", false);
    assert.equal(r.view().mode, "ready");
    mock.timers.tick(5000);
    assert.equal(r.view().mode, "ready", "отменённый запуск не выполняется");
  });

  it("отказ в старте: кнопка возвращается к «Запустить»", function () {
    const r = rig().up().on();
    r.sim.setRemote(false);
    r.store.set("run", true);
    assert.equal(r.store.shownBool("run"), true);
    mock.timers.tick(120);
    assert.equal(r.store.shownBool("run"), false);
    const v = r.view();
    assert.equal(v.mode, "ready");
    assert.equal(v.action.kind, "start");
    assert.equal(M.parseNote(r.store.log[0].text).text,
      "Старт отменён: удалённый старт не разрешён — нажмите Remote Start на машине");
    assert.equal(r.store.log[0].live, true);
  });
});

// ---------------------------------------------------------------------------
describe("авария, замечания, расходники", function () {
  it("авария важнее «Готова» и «Чисто», но не хода программы", function () {
    const ALARM = { icon: "triangle-alert", label: "", value: "Авария", sub: "причина — ниже", ring: 0, tone: "error", wave: false };
    let r = rig().up().on();
    r.sim.setFlag("rinse_low", false);
    r.sim.setFlag("aquastop", true);
    let v = r.view();
    assert.equal(v.mode, "ready");
    assert.deepEqual(v.dial, ALARM);
    assert.deepEqual(v.issues, [{ id: "alarm", level: "error", text: "Сработал AquaStop — возможна протечка!" }]);
    assert.equal(v.attention, 1);
    assert.equal(v.action.disabled, false, "запуск остаётся на усмотрение правила");

    r = rig({ scenario: "running" }).up();
    r.sim.setFlag("aquastop", true);
    assert.equal(r.view().dial.label, "Осталось");
    assert.equal(r.view().issues[0].id, "alarm");
    r.sim.skipToEnd();
    pass(2);
    assert.equal(r.view().mode, "finished");
    assert.deepEqual(r.view().dial, ALARM);
    pass(15);
    assert.equal(r.view().mode, "off");
    assert.deepEqual(r.view().dial, ALARM, "машина выключилась с посудой внутри — авария всё ещё важнее «Чисто»");
    r.sim.setFlag("aquastop", false);
    assert.equal(r.view().dial.value, "Чисто");
  });

  it("выключенная пустая машина с аварией: циферблат «Выключена», авария — в замечаниях", function () {
    const r = rig().up();
    r.sim.setFlag("aquastop", true);
    assert.equal(r.view().dial.value, "Выключена");
    assert.equal(r.view().issues[0].level, "error");
  });

  it("авария без текста", function () {
    const v = bare({ online: 1, state: "Готова", alarm: 1 }).view();
    assert.deepEqual(v.issues, [{ id: "alarm", level: "error", text: "Авария" }]);
  });

  it("замечания: порядок, уровни, счётчик", function () {
    const r = rig().up().on();
    let v = r.view();
    assert.deepEqual(v.issues, [{ id: "rinse", level: "info", text: "Ополаскиватель заканчивается" }]);
    assert.equal(v.attention, 1);

    ["aquastop", "salt_low", "rinse_empty", "filter_check", "care_needed"].forEach(function (f) { r.sim.setFlag(f, true); });
    r.sim.setDoor(true);
    v = r.view();
    assert.deepEqual(v.issues, [
      { id: "alarm", level: "error", text: "Сработал AquaStop — возможна протечка!" },
      { id: "door", level: "info", text: "Дверь открыта" },
      { id: "salt", level: "info", text: "Соль заканчивается" },
      { id: "rinse", level: "warn", text: "Закончился ополаскиватель" },
      { id: "filter", level: "warn", text: "Проверьте фильтр" },
      { id: "care", level: "warn", text: "Пора запустить «Уход за машиной»" },
    ]);
    assert.equal(v.attention, 5, "все, кроме открытой двери");

    r.sim.setFlag("salt_empty", true);
    assert.deepEqual(r.view().issues[2], { id: "salt", level: "warn", text: "Закончилась соль" });
  });

  it("расходники и уход: уровень 2 — норма, 1 — заканчивается, 0 — нет", function () {
    const r = rig().up();
    assert.deepEqual(r.view().supplies, [
      { id: "salt", title: "Соль", level: 2, text: "В норме" },
      { id: "rinse", title: "Ополаскиватель", level: 1, text: "Заканчивается" },
      { id: "filter", title: "Фильтр", level: 2, text: "В норме" },
      { id: "care", title: "Уход за машиной", level: 2, text: "Через 19 циклов" },
    ]);
    r.sim.setFlag("salt_low", true);
    r.sim.setFlag("rinse_empty", true);
    r.sim.setFlag("filter_check", true);
    r.sim.setFlag("care_needed", true);
    assert.deepEqual(r.view().supplies, [
      { id: "salt", title: "Соль", level: 1, text: "Заканчивается" },
      { id: "rinse", title: "Ополаскиватель", level: 0, text: "Закончился" },
      { id: "filter", title: "Фильтр", level: 0, text: "Нужно проверить" },
      { id: "care", title: "Уход за машиной", level: 0, text: "Пора запустить" },
    ]);
    r.sim.setFlag("salt_empty", true);
    assert.deepEqual(r.view().supplies[0], { id: "salt", title: "Соль", level: 0, text: "Закончилась" });

    r.sim.setFlag("care_needed", false);
    r.sim.m.care_runs = 1;
    r.sim.sync();
    assert.equal(r.view().supplies[3].text, "Через 1 цикл");
    r.sim.m.care_runs = 3;
    r.sim.sync();
    assert.equal(r.view().supplies[3].text, "Через 3 цикла");
    r.sim.m.care_runs = 0;
    r.sim.sync();
    assert.equal(r.view().supplies[3].text, "Не требуется");
  });

  it("сведения о машине", function () {
    const r = rig({ scenario: "running" }).up();
    assert.deepEqual(r.view().facts, [
      { id: "door_open", label: "Дверь", value: "Закрыта" },
      { id: "remote_start", label: "Удалённый старт", value: "Разрешён" },
      { id: "energy_forecast", label: "Прогноз расхода энергии", value: r.store.num("energy_forecast") + "%" },
      { id: "water_forecast", label: "Прогноз расхода воды", value: r.store.num("water_forecast") + "%" },
      { id: "finished_at", label: "Последняя мойка", value: "09.03 18:00 (Интенсивная 70°)" },
      { id: "end_trigger", label: "Чем закончилась", value: "Завершена нормально" },
      { id: "cycles", label: "Всего запусков", value: "878" },
      { id: "rssi", label: "Wi-Fi", value: "-58 dBm, отличный" },
      { id: "fw", label: "Прошивка", value: "3.12.1.0" },
    ]);
    r.sim.setDoor(true);
    r.sim.setRemote(false);
    r.sim.setFlag("fw_update", true);
    r.set("opt_silence", true);
    const facts = {};
    r.view().facts.forEach(function (f) { facts[f.id] = f.value; });
    assert.equal(facts.door_open, "Открыта");
    assert.equal(facts.remote_start, "Не разрешён");
    assert.equal(facts.silence_left, "ещё 30 мин");
    assert.equal(facts.fw, "3.12.1.0 · доступно обновление");
  });

  it("сведения: уровень Wi-Fi словами; чего нет — того не показываем", function () {
    const quality = function (rssi) {
      const f = bare({ online: 1, state: "Готова", rssi: rssi }).view().facts;
      return f.length ? f[0].value : "";
    };
    assert.equal(quality(-60), "-60 dBm, отличный");
    assert.equal(quality(-61), "-61 dBm, хороший");
    assert.equal(quality(-70), "-70 dBm, хороший");
    assert.equal(quality(-80), "-80 dBm, слабый");
    assert.equal(quality(-81), "-81 dBm, очень слабый");
    assert.equal(quality(0), "");
    assert.deepEqual(bare({ online: 1, state: "Готова", cycles: 0, fw: "", finished_at: "" }).view().facts, []);
  });
});

// ---------------------------------------------------------------------------
describe("старое правило и настоящий контроллер", function () {
  it("без enum у program программы берутся из выключателей prog_*", function () {
    const b = bare({ online: 1, power: 1, state: "Готова", prog_eco50: 0, prog_quick65: 1, prog_intensiv70: 0 });
    b.meta("prog_eco50", { type: "switch", order: 30, title: { en: "Программа: Эко 50°" } });
    b.meta("prog_quick65", { type: "switch", order: 35, title: { en: "Программа: Быстрая 65°" } });
    b.meta("prog_intensiv70", { type: "switch", order: 31, title: { en: "Программа: Интенсивная 70°" } });
    const v = b.view();
    assert.deepEqual(v.programs.map(function (p) { return [p.uid, p.key, p.title, p.hint.icon, p.selected, p.ctrl]; }), [
      ["prog_eco50", "eco50", "Эко 50°", "leaf", false, "prog_eco50"],
      ["prog_intensiv70", "intensiv70", "Интенсивная 70°", "flame", false, "prog_intensiv70"],
      ["prog_quick65", "quick65", "Быстрая 65°", "zap", true, "prog_quick65"],
    ]);
    assert.equal(v.selected.ctrl, "prog_quick65");
    assert.equal(v.dial.value, "Быстрая 65°");
    assert.equal(v.action.disabled, false);
  });

  it("снимок настоящего контроллера: идёт «Интенсивная 70°»", function () {
    const b = bare();
    fs.readFileSync(path.join(__dirname, "fixtures", "wb7_retained.txt"), "utf8").split("\n").forEach(function (line) {
      if (!line || line[0] === "#") return;
      const i = line.indexOf(" ");
      b.store.handleMessage(line.slice(0, i), line.slice(i + 1), true);
    });
    const v = b.view();
    assert.equal(v.link, "ok");
    assert.equal(v.mode, "running");
    assert.equal(v.headline, "Мойка · Интенсивная 70°");
    assert.deepEqual(v.dial, { icon: "", label: "Осталось", value: "1:38", sub: "до 14:48", ring: 27, tone: "run", wave: true });
    assert.equal(v.phaseIndex, 1);
    assert.equal(v.programs.length, 8);
    assert.equal(v.selected.key, "Intensiv70");
    assert.deepEqual(v.action, { kind: "abort", label: "Отменить программу", hint: "", disabled: false });
    assert.deepEqual(v.issues, []);
    assert.equal(v.attention, 0);
    assert.equal(v.delayMax, 24);
    assert.equal(v.supplies[3].text, "Через 12 циклов");
    assert.deepEqual(v.facts.map(function (f) { return f.id; }),
      ["door_open", "remote_start", "energy_forecast", "water_forecast", "finished_at", "end_trigger", "cycles", "rssi", "fw"]);
  });
});

// ---------------------------------------------------------------------------
describe("вспомогательные функции", function () {
  it("fmtHM: минуты в «ч:мм»", function () {
    assert.equal(M.fmtHM(0), "0:00");
    assert.equal(M.fmtHM(5), "0:05");
    assert.equal(M.fmtHM(59), "0:59");
    assert.equal(M.fmtHM(60), "1:00");
    assert.equal(M.fmtHM(102), "1:42");
    assert.equal(M.fmtHM(1440), "24:00");
    assert.equal(M.fmtHM(101.6), "1:42");
    assert.equal(M.fmtHM(-7), "0:00");
  });

  it("plural: один цикл, два цикла, пять циклов", function () {
    const p = function (n) { return M.plural(n, "цикл", "цикла", "циклов"); };
    assert.equal(p(0), "0 циклов");
    assert.equal(p(1), "1 цикл");
    assert.equal(p(2), "2 цикла");
    assert.equal(p(4), "4 цикла");
    assert.equal(p(5), "5 циклов");
    assert.equal(p(11), "11 циклов");
    assert.equal(p(12), "12 циклов");
    assert.equal(p(14), "14 циклов");
    assert.equal(p(19), "19 циклов");
    assert.equal(p(21), "21 цикл");
    assert.equal(p(22), "22 цикла");
    assert.equal(p(25), "25 циклов");
    assert.equal(p(101), "101 цикл");
    assert.equal(p(111), "111 циклов");
    assert.equal(p(112), "112 циклов");
    assert.equal(p(-1), "-1 цикл");
  });

  it("splitTitle: без приставки, пояснение из скобок отдельно, с заглавной буквы", function () {
    assert.deepEqual(M.splitTitle("Опция: VarioSpeed+ (быстрее)"), { name: "VarioSpeed+", note: "быстрее" });
    assert.deepEqual(M.splitTitle("Опция: половинная загрузка"), { name: "Половинная загрузка", note: "" });
    assert.deepEqual(M.splitTitle("Опция: тихий режим (Silence on demand)"), { name: "Тихий режим", note: "Silence on demand" });
    assert.deepEqual(M.splitTitle("Настройка: InfoLight (луч на полу)"), { name: "InfoLight", note: "луч на полу" });
    assert.deepEqual(M.splitTitle("Настройка: громкость сигнала"), { name: "Громкость сигнала", note: "" });
    assert.deepEqual(M.splitTitle("Программа: Тихая (ночная)"), { name: "Тихая", note: "ночная" });
    assert.deepEqual(M.splitTitle("Питание"), { name: "Питание", note: "" });
    assert.deepEqual(M.splitTitle("opt_zeolith"), { name: "Opt_zeolith", note: "" });
    assert.deepEqual(M.splitTitle("Очень длинная приставка: имя"), { name: "Очень длинная приставка: имя", note: "" });
    assert.deepEqual(M.splitTitle(""), { name: "", note: "" });
    assert.deepEqual(M.splitTitle(undefined), { name: "", note: "" });
  });

  it("parseNote: пометка в начале события задаёт уровень", function () {
    assert.deepEqual(M.parseNote("✅ Мойка завершена: Эко 50°. Можно разгружать"),
      { level: "ok", text: "Мойка завершена: Эко 50°. Можно разгружать" });
    assert.deepEqual(M.parseNote("⛔ Программа прервана"), { level: "warn", text: "Программа прервана" });
    assert.deepEqual(M.parseNote("⚠ Заканчивается соль"), { level: "warn", text: "Заканчивается соль" });
    assert.deepEqual(M.parseNote("⚠️ Заканчивается соль"), { level: "warn", text: "Заканчивается соль" });
    assert.deepEqual(M.parseNote("❗ Сработал AquaStop — возможна протечка!"),
      { level: "error", text: "Сработал AquaStop — возможна протечка!" });
    assert.deepEqual(M.parseNote("▶ Мойка началась: Эко 50°, окончание ≈ 23:45"),
      { level: "info", text: "Мойка началась: Эко 50°, окончание ≈ 23:45" });
    assert.deepEqual(M.parseNote("⏰ Отложенный старт: Эко 50°"), { level: "info", text: "Отложенный старт: Эко 50°" });
  });

  it("parseNote: без пометки текст не трогается", function () {
    assert.deepEqual(M.parseNote("Старт отменён: дверь открыта"), { level: "info", text: "Старт отменён: дверь открыта" });
    assert.deepEqual(M.parseNote("«Эко 50°» выбрана"), { level: "info", text: "«Эко 50°» выбрана" });
    assert.deepEqual(M.parseNote("(тест) событие"), { level: "info", text: "(тест) событие" });
    assert.deepEqual(M.parseNote("Abort failed ❗ совсем"), { level: "info", text: "Abort failed ❗ совсем" });
    assert.deepEqual(M.parseNote("12 циклов до ухода"), { level: "info", text: "12 циклов до ухода" });
    assert.deepEqual(M.parseNote(""), { level: "info", text: "" });
    assert.deepEqual(M.parseNote(undefined), { level: "info", text: "" });
  });

  it("parseNote понимает все пометки, которыми пользуется правило", function () {
    const src = fs.readFileSync(path.join(__dirname, "..", "rule", "dishwasher.js"), "utf8");
    const marks = {};
    const re = /"([^"\sA-Za-zА-Яа-яЁё0-9«(]{1,3}) [А-ЯЁ]/g;
    let m;
    while ((m = re.exec(src))) marks[m[1]] = true;
    assert.equal(Object.keys(marks).length >= 4, true, "пометки в правиле найдены: " + Object.keys(marks).join(" "));
    Object.keys(marks).forEach(function (mark) {
      const n = M.parseNote(mark + " Текст события");
      assert.equal(n.text, "Текст события", mark);
      const want = mark.indexOf("❗") >= 0 ? "error" : mark.indexOf("⚠") >= 0 || mark.indexOf("⛔") >= 0 ? "warn"
        : mark.indexOf("✅") >= 0 ? "ok" : "info";
      assert.equal(n.level, want, mark);
    });
  });

  it("programHint: значок и пояснение по ключу программы", function () {
    assert.deepEqual(M.programHint("Eco50"), { icon: "leaf", text: "Бережёт воду и электричество, идёт дольше остальных" });
    assert.equal(M.programHint("eco50").icon, "leaf");
    assert.equal(M.programHint("Auto2").icon, "gauge");
    assert.equal(M.programHint("Intensiv70").icon, "flame");
    assert.equal(M.programHint("Quick65").icon, "zap");
    assert.equal(M.programHint("Kurz60").icon, "zap");
    assert.equal(M.programHint("NightWash").icon, "moon");
    assert.equal(M.programHint("PreRinse").icon, "droplets");
    assert.equal(M.programHint("MachineCare").icon, "sparkles");
    assert.equal(M.programHint("Glas40").icon, "glass-water");
    assert.deepEqual(M.programHint("001"), { icon: "star", text: "Сохранённое на машине сочетание программы и опций" });
    assert.deepEqual(M.programHint("Super"), { icon: "waves", text: "" });
    assert.deepEqual(M.programHint(""), { icon: "waves", text: "" });
    assert.deepEqual(M.programHint(undefined), { icon: "waves", text: "" });
  });

  it("у каждой программы имитации есть значок и пояснение", function () {
    const r = rig().up();
    r.view().programs.forEach(function (p) {
      assert.notEqual(p.hint.icon, "waves", p.key);
      assert.notEqual(p.hint.text, "", p.key);
    });
  });

  it("optionHint и settingHint: пояснения есть у всех опций и настроек правила", function () {
    assert.equal(M.optionHint("opt_halfload"), "Когда посуды мало: меньше воды и времени");
    assert.equal(M.optionHint("opt_unknown"), "");
    assert.equal(M.settingHint("set_sound"), "Сигнал об окончании программы");
    assert.equal(M.settingHint("set_unknown"), "");
    Sim.controlDefs().forEach(function (d) {
      if (d.id.indexOf("opt_") === 0) assert.notEqual(M.optionHint(d.id), "", d.id);
      if (d.id.indexOf("set_") === 0) assert.notEqual(M.settingHint(d.id), "", d.id);
    });
  });
});
