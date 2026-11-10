"use strict";
// Тесты модели устройства Wiren Board для веб-страницы (web/app/js/store.js): разбор значений
// и метаданных, уведомления, команды и их подтверждение, журнал событий. Брокер не нужен:
// транспорт поддельный, сообщения подаются руками.
//   node --test tests/web_store.test.js

const { describe, it, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

let S;
before(async function () { S = await import("../web/app/js/store.js"); });

const P = "/devices/dishwasher/";
const C = P + "controls/";

// Поддельный транспорт с интерфейсом MqttClient
function fakeTransport() {
  const t = {
    up: true, subs: [], sent: [], connects: 0, closes: 0,
    onMessage: null, onStatus: null,
    subscribe: function (filters) { t.subs.push(filters); },
    connect: function () { t.connects++; },
    publish: function (topic, payload, opts) {
      if (!t.up) return false;
      t.sent.push(opts === undefined ? [topic, payload] : [topic, payload, opts]);
      return true;
    },
    close: function () { t.closes++; },
  };
  return t;
}

// Хранилище на поддельном транспорте и журнал уведомлений
function make(opts) {
  const t = fakeTransport();
  const store = new S.DeviceStore(Object.assign({ transport: t }, opts || {}));
  store.start();
  const r = {
    store: store, t: t, events: [],
    /** сообщение брокера; rest — топик после /devices/dishwasher/ */
    msg: function (rest, payload, retained) { t.onMessage(P + rest, payload, retained !== false); return r; },
    /** значение контрола; live — пришло при нас, без признака retained */
    val: function (id, payload) { return r.msg("controls/" + id, payload, true); },
    live: function (id, payload) { return r.msg("controls/" + id, payload, false); },
    meta: function (id, m) { return r.msg("controls/" + id + "/meta", typeof m === "string" ? m : JSON.stringify(m)); },
    field: function (id, name, payload) { return r.msg("controls/" + id + "/meta/" + name, payload); },
    link: function (status, info) { t.onStatus(status, info); return r; },
    /** дождаться отложенных уведомлений и забрать их */
    flush: async function () {
      await new Promise(function (done) { setImmediate(done); });
      const got = r.events;
      r.events = [];
      return got;
    },
  };
  r.off = store.subscribe(function (changed) { r.events.push(Array.from(changed).sort()); });
  return r;
}

// Строки «топик значение» из снимка настоящего контроллера
function fixture() {
  return fs.readFileSync(path.join(__dirname, "fixtures", "wb7_retained.txt"), "utf8").split("\n")
    .filter(function (line) { return line && line[0] !== "#"; })
    .map(function (line) {
      const i = line.indexOf(" ");
      return [line.slice(0, i), line.slice(i + 1)];
    });
}

beforeEach(function () { mock.timers.enable({ apis: ["setTimeout"] }); });
afterEach(function () { mock.timers.reset(); mock.restoreAll(); });

// ---------------------------------------------------------------------------
describe("подключение", function () {
  it("start() подписывается на всё устройство и подключается", function () {
    const r = make();
    assert.deepEqual(r.t.subs, [["/devices/dishwasher/#"]]);
    assert.equal(r.t.connects, 1);
    assert.equal(r.store.link, "connecting");
    assert.equal(r.store.ready, false);
    assert.equal(r.store.structure, 0);
  });

  it("другое устройство — другой префикс", function () {
    const r = make({ device: "dw2" });
    assert.deepEqual(r.t.subs, [["/devices/dw2/#"]]);
    r.t.onMessage("/devices/dw2/controls/power", "1", true);
    r.t.onMessage("/devices/dishwasher/controls/run", "1", true);
    assert.equal(r.store.bool("power"), true);
    assert.equal(r.store.has("run"), false);
    r.store.set("power", false);
    assert.deepEqual(r.t.sent, [["/devices/dw2/controls/power/on", "0"]]);
  });

  it("состояние связи: статус, пояснение, уведомление «@link»", async function () {
    const r = make();
    r.link("connected");
    assert.equal(r.store.link, "connected");
    assert.equal(r.store.linkInfo, "");
    assert.deepEqual(await r.flush(), [["@link"]]);
    r.link("reconnecting", "соединение потеряно");
    assert.equal(r.store.link, "reconnecting");
    assert.equal(r.store.linkInfo, "соединение потеряно");
    r.link("closed");
    assert.equal(r.store.link, "closed");
    assert.equal(r.store.linkInfo, "");
    assert.deepEqual(await r.flush(), [["@link"]]);
  });
});

// ---------------------------------------------------------------------------
describe("значения", function () {
  it("raw, bool, num, text", function () {
    const r = make();
    r.val("power", "1").val("run", "0").val("online", "true").val("rssi", "-55").val("ratio", "12.5")
      .val("state", "Мойка").val("delay_h", "abc");
    const s = r.store;
    assert.equal(s.raw("power"), "1");
    assert.equal(s.bool("power"), true);
    assert.equal(s.bool("run"), false);
    assert.equal(s.bool("online"), true);
    assert.equal(s.bool("state"), false);
    assert.equal(s.num("rssi"), -55);
    assert.equal(s.num("ratio"), 12.5);
    assert.equal(s.num("power"), 1);
    assert.equal(s.num("delay_h"), 0, "не число — ноль");
    assert.equal(s.text("state"), "Мойка");
    assert.equal(s.text("rssi"), "-55");
  });

  it("контрола нет: undefined, false, 0, пустая строка", function () {
    const s = make().store;
    assert.equal(s.has("nope"), false);
    assert.equal(s.raw("nope"), undefined);
    assert.equal(s.bool("nope"), false);
    assert.equal(s.num("nope"), 0);
    assert.equal(s.text("nope"), "");
    assert.deepEqual(s.meta("nope"), {});
    assert.equal(s.type("nope"), "");
    assert.equal(s.readonly("nope"), false);
    assert.equal(s.title("nope"), "nope");
    assert.equal(s.error("nope"), "");
    assert.equal(s.shown("nope"), undefined);
    assert.equal(s.pending("nope"), undefined);
    assert.deepEqual(s.options("nope"), []);
  });

  it("ready — только после первого значения: одних метаданных мало", function () {
    const r = make();
    r.msg("meta", JSON.stringify({ driver: "wb-rules", title: { en: "Посудомоечная машина" } }));
    r.meta("start", { type: "pushbutton", readonly: false, order: 63 });
    assert.equal(r.store.ready, false);
    assert.equal(r.store.has("start"), true);
    assert.equal(r.store.raw("start"), undefined);
    r.val("power", "0");
    assert.equal(r.store.ready, true);
  });

  it("чужие устройства, команды и незнакомые топики не учитываются", async function () {
    const r = make();
    r.t.onMessage("/devices/other/controls/power", "1", true);
    r.t.onMessage("/devices/dishwasher2/controls/power", "1", true);
    r.t.onMessage("/devices/dishwasher", "1", true);
    r.msg("controls/power/on", "1", false);
    r.msg("controls/", "1");
    r.msg("controls/power/foo", "1");
    r.msg("controls/power/meta/type/extra", "switch");
    r.msg("something", "1");
    r.msg("meta/driver", "wb-rules");
    assert.equal(r.store.controls.size, 0);
    assert.equal(r.store.ready, false);
    assert.equal(r.store.structure, 0);
    assert.deepEqual(await r.flush(), []);
  });

  it("пустой текст остаётся контролом с пустым значением", function () {
    const r = make();
    r.meta("phase", { type: "text", readonly: true }).val("phase", "Мойка");
    r.live("phase", "");
    assert.equal(r.store.has("phase"), true);
    assert.equal(r.store.text("phase"), "");
    // пустой текст, пришедший раньше метаданных: брокер такое не хранит, но wb-rules может прислать при нас
    r.live("start_in", "");
    assert.equal(r.store.has("start_in"), true);
    assert.equal(r.store.text("start_in"), "");
  });

  it("пустое значение не текстового контрола — контрол удалён", async function () {
    const r = make();
    r.meta("opt_zeolith", { type: "switch", readonly: false, order: 5 }).val("opt_zeolith", "1");
    r.field("opt_zeolith", "type", "switch");
    await r.flush();
    const before = r.store.structure;
    // так wb-rules убирает контрол: пустые retained-публикации, подписчик получает их без признака retained
    r.live("opt_zeolith", "");
    assert.equal(r.store.has("opt_zeolith"), false);
    assert.equal(r.store.structure, before + 1);
    assert.deepEqual(await r.flush(), [["@structure"]]);
    r.msg("controls/opt_zeolith/meta", "", false);
    r.msg("controls/opt_zeolith/meta/type", "", false);
    r.msg("controls/opt_zeolith/meta/order", "", false);
    r.msg("controls/opt_zeolith/meta/readonly", "", false);
    assert.equal(r.store.has("opt_zeolith"), false, "хвост из пустых метаданных не возвращает контрол");
    assert.deepEqual(r.store.list("opt_"), []);
    assert.deepEqual(await r.flush(), []);
    // и с признаком retained тоже
    r.field("opt_x", "type", "switch").val("opt_x", "0").val("opt_x", "");
    assert.equal(r.store.has("opt_x"), false);
    // тип неизвестен — это может быть и текст: контрол остаётся
    r.val("mystery", "1").live("mystery", "");
    assert.equal(r.store.has("mystery"), true);
    assert.equal(r.store.text("mystery"), "");
  });
});

// ---------------------------------------------------------------------------
describe("метаданные", function () {
  it("JSON /meta: тип, readonly, порядок, границы, единицы", function () {
    const r = make();
    r.meta("delay_h", { max: 24, min: 0, order: 9, readonly: false, title: { en: "Отложить старт, ч" }, type: "range" });
    r.meta("state", { order: 65, readonly: true, title: { en: "Состояние" }, type: "text" });
    r.meta("rssi", { order: 45, readonly: true, title: { en: "Wi-Fi сигнал" }, type: "value", units: "dBm" });
    const s = r.store;
    assert.equal(s.type("delay_h"), "range");
    assert.equal(s.readonly("delay_h"), false);
    assert.equal(s.meta("delay_h").min, 0);
    assert.equal(s.meta("delay_h").max, 24);
    assert.equal(s.meta("delay_h").order, 9);
    assert.equal(s.type("state"), "text");
    assert.equal(s.readonly("state"), true);
    assert.equal(s.meta("rssi").units, "dBm");
  });

  it("подпись: ru важнее en, годится строка, без подписи — id", function () {
    const r = make();
    r.meta("a", { type: "switch", title: { en: "Power", ru: "Питание" } });
    r.meta("b", { type: "switch", title: { en: "Питание" } });
    r.meta("c", { type: "switch", title: "Просто строка" });
    r.meta("d", { type: "switch" });
    r.meta("e", { type: "switch", title: { de: "Strom" } });
    r.meta("f", { type: "switch", title: {} });
    assert.equal(r.store.title("a"), "Питание");
    assert.equal(r.store.title("b"), "Питание");
    assert.equal(r.store.title("c"), "Просто строка");
    assert.equal(r.store.title("d"), "d");
    assert.equal(r.store.title("e"), "Strom");
    assert.equal(r.store.title("f"), "f");
  });

  it("pickTitle", function () {
    assert.equal(S.pickTitle(undefined), "");
    assert.equal(S.pickTitle(null), "");
    assert.equal(S.pickTitle("Имя"), "Имя");
    assert.equal(S.pickTitle({ ru: "Да", en: "Yes" }), "Да");
    assert.equal(S.pickTitle({ ru: "", en: "Yes" }), "Yes");
    assert.equal(S.pickTitle({ fr: "Oui" }), "Oui");
    assert.equal(S.pickTitle({}), "");
    assert.equal(S.pickTitle(5), "5");
  });

  it("не JSON, не объект и пустое /meta не учитываются", async function () {
    const r = make();
    r.meta("power", { type: "switch" });
    await r.flush();
    const before = r.store.structure;
    r.meta("power", "{не json").meta("power", "5").meta("power", "null").meta("power", "\"text\"").meta("power", "");
    assert.deepEqual(r.store.meta("power"), { type: "switch" });
    assert.equal(r.store.structure, before);
    assert.deepEqual(await r.flush(), []);
    r.meta("ghost", "{не json").meta("ghost", "");
    assert.equal(r.store.has("ghost"), false);
  });

  it("новый JSON дополняет и заменяет поля; тот же самый — не событие", async function () {
    const r = make();
    r.meta("delay_h", { type: "range", min: 0, max: 24, readonly: false });
    assert.deepEqual(await r.flush(), [["@structure", "delay_h"]]);
    const before = r.store.structure;
    r.meta("delay_h", { type: "range", min: 0, max: 24, readonly: false });
    assert.equal(r.store.structure, before);
    assert.deepEqual(await r.flush(), []);
    r.meta("delay_h", { max: 12, readonly: true });
    assert.deepEqual(r.store.meta("delay_h"), { type: "range", min: 0, max: 12, readonly: true });
    assert.equal(r.store.structure, before + 1);
    assert.deepEqual(await r.flush(), [["@structure", "delay_h"]]);
  });

  it("ошибка контрола: из JSON и из /meta/error", async function () {
    const r = make();
    r.meta("rssi", { type: "value", error: "r" });
    assert.equal(r.store.error("rssi"), "r");
    await r.flush();
    r.field("rssi", "error", "");
    assert.equal(r.store.error("rssi"), "");
    assert.deepEqual(await r.flush(), [["rssi"]]);
    r.field("rssi", "error", "p");
    assert.equal(r.store.error("rssi"), "p");
    r.field("rssi", "error", "p");
    assert.deepEqual(await r.flush(), [["rssi"]], "повтор той же ошибки — не событие");
  });

  it("старый формат: /meta/type, /meta/readonly, /meta/order, /meta/min, /meta/max, /meta/units, /meta/precision", function () {
    const r = make();
    r.field("set_silencetime", "type", "range").field("set_silencetime", "max", "30").field("set_silencetime", "min", "1")
      .field("set_silencetime", "order", "59").field("set_silencetime", "readonly", "0")
      .field("set_silencetime", "units", "min").field("set_silencetime", "precision", "0.5");
    assert.deepEqual(r.store.meta("set_silencetime"),
      { type: "range", max: 30, min: 1, order: 59, readonly: false, units: "min", precision: 0.5 });
    assert.equal(r.store.readonly("set_silencetime"), false);

    r.field("state", "readonly", "1").field("alarm", "readonly", "true").field("power", "readonly", "false");
    assert.equal(r.store.readonly("state"), true);
    assert.equal(r.store.readonly("alarm"), true);
    assert.equal(r.store.readonly("power"), false);
    assert.equal(r.store.ready, false, "метаданные — ещё не значения");
  });

  it("старый формат: не числа и незнакомые поля не учитываются, подпись берётся только из JSON", function () {
    const r = make();
    r.field("x", "type", "value").field("x", "order", "abc").field("x", "min", "").field("x", "max", "много")
      .field("x", "title", "Подпись").field("x", "name", "Имя").field("x", "enum", "{}").field("x", "driver", "wb-rules");
    assert.deepEqual(r.store.meta("x"), { type: "value" });
    assert.equal(r.store.title("x"), "x");
  });

  it("JSON важнее старого формата, в каком бы порядке они ни пришли", function () {
    const r = make();
    // как на контроллере: сначала JSON, потом те же поля по одному
    r.meta("finish_at", { order: 15, readonly: false, title: { en: "Завершить к" }, type: "text" });
    r.field("finish_at", "type", "value").field("finish_at", "order", "99").field("finish_at", "readonly", "1");
    assert.deepEqual(r.store.meta("finish_at"), { order: 15, readonly: false, title: { en: "Завершить к" }, type: "text" });
    // и наоборот
    r.field("alarm", "type", "switch").field("alarm", "readonly", "0").field("alarm", "order", "1");
    r.meta("alarm", { order: 3, readonly: true, title: { en: "Авария" }, type: "alarm" });
    assert.deepEqual(r.store.meta("alarm"), { type: "alarm", readonly: true, order: 3, title: { en: "Авария" } });
  });

  it("название устройства: из JSON /meta, из /meta/name, в любом порядке", async function () {
    let r = make();
    r.msg("meta", JSON.stringify({ driver: "wb-rules", title: { en: "Посудомоечная машина" } }));
    assert.equal(r.store.deviceTitle, "Посудомоечная машина");
    assert.deepEqual(await r.flush(), [["@structure"]]);
    r.msg("meta/name", "Другое имя");
    assert.equal(r.store.deviceTitle, "Посудомоечная машина", "JSON важнее");
    assert.deepEqual(await r.flush(), []);

    r = make();
    r.msg("meta/name", "Посудомойка");
    assert.equal(r.store.deviceTitle, "Посудомойка");
    assert.deepEqual(await r.flush(), [["@structure"]], "об имени из старого формата страница тоже узнаёт");
    r.msg("meta", JSON.stringify({ driver: "wb-rules" }));
    assert.equal(r.store.deviceTitle, "Посудомойка", "JSON без названия имя не стирает");
    r.msg("meta", "не json");
    assert.equal(r.store.deviceTitle, "Посудомойка");
    r.msg("meta", JSON.stringify({ title: { ru: "Посудомоечная машина", en: "Dishwasher" } }));
    assert.equal(r.store.deviceTitle, "Посудомоечная машина");
  });
});

// ---------------------------------------------------------------------------
describe("options(id) и list(prefix)", function () {
  it("options: по возрастанию значения, подпись по-русски, ключ — английское имя", function () {
    const r = make();
    // порядок ключей как в JSON контроллера: строки по алфавиту, «32828» раньше «8192»
    r.meta("program", { type: "value", readonly: false, enum: {
      "32828": { en: "001", ru: "Избранное" },
      "8192": { en: "Intensiv70", ru: "Интенсивная 70°" },
      "8196": { en: "Eco50", ru: "Эко 50°" },
      "8203": { en: "Quick65" },
    } });
    assert.deepEqual(r.store.options("program"), [
      { value: "8192", label: "Интенсивная 70°", key: "Intensiv70" },
      { value: "8196", label: "Эко 50°", key: "Eco50" },
      { value: "8203", label: "Quick65", key: "Quick65" },
      { value: "32828", label: "Избранное", key: "001" },
    ]);
  });

  it("options: варианты строкой, без подписи, без enum", function () {
    const r = make();
    r.meta("a", { type: "value", enum: { "0": "Выкл", "1": "Вкл", "10": {}, "2": null } });
    assert.deepEqual(r.store.options("a"), [
      { value: "0", label: "Выкл", key: "" },
      { value: "1", label: "Вкл", key: "" },
      { value: "2", label: "2", key: "" },
      { value: "10", label: "10", key: "" },
    ]);
    r.meta("b", { type: "value" }).meta("c", { type: "value", enum: "0,1" });
    assert.deepEqual(r.store.options("b"), []);
    assert.deepEqual(r.store.options("c"), []);
  });

  it("list: по meta.order, при равном порядке — по имени", function () {
    const r = make();
    r.meta("opt_variospeed", { type: "switch", order: 25 }).meta("opt_extradry", { type: "switch", order: 22 })
      .meta("opt_silence", { type: "switch", order: 24 }).meta("opt_halfload", { type: "switch", order: 23 })
      .meta("set_sound", { type: "value", order: 1 }).val("power", "1");
    assert.deepEqual(r.store.list("opt_"), ["opt_extradry", "opt_halfload", "opt_silence", "opt_variospeed"]);
    assert.deepEqual(r.store.list("set_"), ["set_sound"]);
    assert.deepEqual(r.store.list("prog_"), []);
    r.meta("opt_halfload", { order: 1 });
    assert.deepEqual(r.store.list("opt_"), ["opt_halfload", "opt_extradry", "opt_silence", "opt_variospeed"]);
  });

  it("list: без порядка — по имени, раньше тех, у кого порядок задан", function () {
    const r = make();
    r.val("prog_quick65", "0").val("prog_eco50", "1").val("prog_auto2", "0").meta("prog_001", { type: "switch", order: 2 });
    assert.deepEqual(r.store.list("prog_"), ["prog_auto2", "prog_eco50", "prog_quick65", "prog_001"]);
    assert.deepEqual(r.store.list(""), ["prog_auto2", "prog_eco50", "prog_quick65", "prog_001"]);
  });
});

// ---------------------------------------------------------------------------
describe("уведомления", function () {
  it("пачка сообщений — одно уведомление со всеми изменениями", async function () {
    const r = make();
    r.meta("power", { type: "switch", readonly: false }).val("power", "1").val("state", "Готова").val("power", "0");
    assert.deepEqual(r.events, [], "уведомление отложено до конца пачки");
    assert.deepEqual(await r.flush(), [["@structure", "power", "state"]]);
    r.val("state", "Мойка");
    assert.deepEqual(await r.flush(), [["state"]]);
  });

  it("значение не изменилось — уведомления нет", async function () {
    const r = make();
    r.val("power", "1");
    await r.flush();
    r.val("power", "1").live("power", "1");
    assert.deepEqual(await r.flush(), []);
  });

  it("structure растёт от нового контрола и новых метаданных, но не от значений", async function () {
    const r = make();
    const s = r.store;
    r.val("power", "1");
    assert.equal(s.structure, 1);
    r.val("power", "0").val("power", "1");
    assert.equal(s.structure, 1);
    r.meta("power", { type: "switch" });
    assert.equal(s.structure, 2);
    r.field("power", "order", "27");
    assert.equal(s.structure, 3);
    r.field("power", "order", "28");
    assert.equal(s.structure, 3, "поле уже известно");
    r.meta("run", { type: "switch" });
    assert.equal(s.structure, 5, "новый контрол и его метаданные");
    r.live("run", "");
    assert.equal(s.structure, 6);
  });

  it("отписка", async function () {
    const r = make();
    r.val("power", "1");
    assert.equal((await r.flush()).length, 1);
    assert.equal(r.off(), true);
    r.val("power", "0");
    assert.deepEqual(await r.flush(), []);
  });

  it("ошибка в одном слушателе не мешает остальным", async function () {
    const r = make();
    const errors = mock.method(console, "error", function () {});
    const second = [];
    r.store.subscribe(function () { throw new Error("сломался"); });
    r.store.subscribe(function (changed) { second.push(Array.from(changed)); });
    r.val("power", "1");
    await r.flush();
    assert.deepEqual(second, [["@structure", "power"]]);
    assert.equal(errors.mock.callCount(), 1);
    r.val("power", "0");
    await r.flush();
    assert.equal(second.length, 2, "хранилище работает дальше");
  });
});

// ---------------------------------------------------------------------------
describe("команды", function () {
  it("set() публикует в /controls/<id>/on: 1/0, число, текст", function () {
    const r = make();
    assert.equal(r.store.set("power", true), true);
    r.store.set("run", false);
    r.store.set("delay_h", 3);
    r.store.set("delay_h", 0);
    r.store.set("ratio", 7.5);
    r.store.set("program", "8196");
    r.store.set("finish_at", "07:30");
    r.store.set("finish_at", " ");
    assert.deepEqual(r.t.sent, [
      [C + "power/on", "1"],
      [C + "run/on", "0"],
      [C + "delay_h/on", "3"],
      [C + "delay_h/on", "0"],
      [C + "ratio/on", "7.5"],
      [C + "program/on", "8196"],
      [C + "finish_at/on", "07:30"],
      [C + "finish_at/on", " "],
    ], "команды не retained: третьего аргумента у publish нет");
  });

  it("нет связи: set() и press() возвращают false, ожидания нет", async function () {
    const r = make();
    r.val("power", "0");
    await r.flush();
    r.t.up = false;
    assert.equal(r.store.set("power", true), false);
    assert.equal(r.store.press("start"), false);
    assert.equal(r.store.pending("power"), undefined);
    assert.equal(r.store.shown("power"), "0");
    assert.deepEqual(await r.flush(), []);
  });

  it("до ответа показывается заданное значение: pending, shown, shownBool", async function () {
    const r = make();
    r.val("power", "0").val("delay_h", "0");
    await r.flush();
    r.store.set("power", true);
    r.store.set("delay_h", 2);
    const s = r.store;
    assert.equal(s.pending("power"), "1");
    assert.equal(s.shown("power"), "1");
    assert.equal(s.shownBool("power"), true);
    assert.equal(s.raw("power"), "0", "настоящее значение прежнее");
    assert.equal(s.bool("power"), false);
    assert.equal(s.pending("delay_h"), "2");
    assert.equal(s.shown("delay_h"), "2");
    assert.equal(s.shownBool("delay_h"), false);
    assert.deepEqual(await r.flush(), [["delay_h", "power"]]);
  });

  it("ответ правила снимает ожидание", async function () {
    const r = make();
    r.val("power", "0").val("run", "0");
    r.store.set("power", true);
    r.store.set("run", true);
    await r.flush();
    r.live("power", "1");
    assert.equal(r.store.pending("power"), undefined);
    assert.equal(r.store.shown("power"), "1");
    assert.equal(r.store.shownBool("power"), true);
    assert.equal(r.store.pending("run"), "1", "чужой ответ своё ожидание не снимает");
    assert.deepEqual(await r.flush(), [["power"]]);
    mock.timers.tick(10000);
    assert.equal(r.store.shown("power"), "1");
  });

  it("отказ правила — ответ прежним значением — тоже снимает ожидание и уведомляет", async function () {
    const r = make();
    r.val("run", "0");
    r.store.set("run", true);
    await r.flush();
    r.live("run", "0");
    assert.equal(r.store.pending("run"), undefined);
    assert.equal(r.store.shown("run"), "0");
    assert.equal(r.store.shownBool("run"), false);
    assert.deepEqual(await r.flush(), [["run"]], "значение то же, но показ изменился");
  });

  it("ответа нет: ожидание снимается через ackMs", async function () {
    const r = make();
    r.val("power", "0");
    r.store.set("power", true);
    await r.flush();
    mock.timers.tick(3999);
    assert.equal(r.store.pending("power"), "1");
    assert.deepEqual(await r.flush(), []);
    mock.timers.tick(1);
    assert.equal(r.store.pending("power"), undefined);
    assert.equal(r.store.shown("power"), "0");
    assert.equal(r.store.shownBool("power"), false);
    assert.deepEqual(await r.flush(), [["power"]]);
  });

  it("ackMs настраивается; повторная команда отсчитывает срок заново", async function () {
    const r = make({ ackMs: 1000 });
    r.val("delay_h", "0");
    r.store.set("delay_h", 1);
    mock.timers.tick(700);
    r.store.set("delay_h", 2);
    mock.timers.tick(700);
    assert.equal(r.store.pending("delay_h"), "2", "первый таймер снят");
    mock.timers.tick(300);
    assert.equal(r.store.pending("delay_h"), undefined);
    assert.equal(r.store.shown("delay_h"), "0");
  });

  it("потеря связи снимает все ожидания, подключение — нет", async function () {
    const r = make();
    r.link("connected").val("power", "0").val("run", "0");
    r.store.set("power", true);
    r.store.set("run", true);
    r.link("connected");
    assert.equal(r.store.pending("power"), "1");
    await r.flush();
    r.link("reconnecting", "соединение потеряно");
    assert.equal(r.store.pending("power"), undefined);
    assert.equal(r.store.pending("run"), undefined);
    assert.equal(r.store.shownBool("power"), false);
    assert.deepEqual(await r.flush(), [["@link", "power", "run"]]);
    mock.timers.tick(10000);
    assert.deepEqual(await r.flush(), [], "таймеры ожидания сняты");
  });

  it("press(): «1» в /on, ожидания нет", async function () {
    const r = make();
    r.meta("start", { type: "pushbutton", readonly: false });
    await r.flush();
    assert.equal(r.store.press("start"), true);
    assert.deepEqual(r.t.sent, [[C + "start/on", "1"]]);
    assert.equal(r.store.pending("start"), undefined);
    assert.deepEqual(await r.flush(), []);
  });

  it("stop(): транспорт закрыт, ожидания и слушатели сняты", async function () {
    const r = make();
    r.val("power", "0");
    r.store.set("power", true);
    await r.flush();
    r.store.stop();
    assert.equal(r.t.closes, 1);
    assert.equal(r.store.pending("power"), undefined);
    mock.timers.tick(10000);
    r.val("power", "1");
    assert.deepEqual(await r.flush(), []);
  });
});

// ---------------------------------------------------------------------------
describe("журнал событий из «Последнее событие»", function () {
  it("запись из retained — не при нас, следующая — при нас; новые в начале", async function () {
    const r = make();
    r.val("last_message", "10.11 21:32  ✅ Мойка завершена: Эко 50°. Можно разгружать");
    assert.deepEqual(r.store.log, [
      { at: "10.11 21:32", text: "✅ Мойка завершена: Эко 50°. Можно разгружать", live: false },
    ]);
    assert.deepEqual(await r.flush(), [["@log", "@structure", "last_message"]]);
    r.live("last_message", "10.11 22:08  Программу нельзя сменить во время мойки");
    assert.deepEqual(r.store.log, [
      { at: "10.11 22:08", text: "Программу нельзя сменить во время мойки", live: true },
      { at: "10.11 21:32", text: "✅ Мойка завершена: Эко 50°. Можно разгружать", live: false },
    ]);
    assert.deepEqual(await r.flush(), [["@log", "last_message"]]);
  });

  it("то же сообщение повторно (после переподключения) в журнал не попадает", async function () {
    const r = make();
    r.live("last_message", "10.11 22:08  Команда отмены программы");
    await r.flush();
    r.val("last_message", "10.11 22:08  Команда отмены программы");
    assert.equal(r.store.log.length, 1);
    assert.equal(r.store.log[0].live, true, "запись осталась «при нас»");
    assert.deepEqual(await r.flush(), []);
    // а новое retained после переподключения — событие, которое мы пропустили
    r.val("last_message", "10.11 22:30  ⛔ Программа прервана");
    assert.deepEqual(r.store.log[0], { at: "10.11 22:30", text: "⛔ Программа прервана", live: false });
    assert.equal(r.store.log.length, 2);
  });

  it("одно и то же событие дважды подряд с другим между ними — три записи", function () {
    const r = make();
    r.live("last_message", "10.11 22:08  Старт отменён: дверь открыта");
    r.live("last_message", "10.11 22:08  Программа уже запущена или отменяется");
    r.live("last_message", "10.11 22:08  Старт отменён: дверь открыта");
    assert.deepEqual(r.store.log.map(function (x) { return x.text; }),
      ["Старт отменён: дверь открыта", "Программа уже запущена или отменяется", "Старт отменён: дверь открыта"]);
  });

  it("без отметки времени — at пустой; пустое и пробелы — не событие", async function () {
    const r = make();
    r.live("last_message", "   ");
    assert.deepEqual(r.store.log, []);
    r.live("last_message", "  просто текст  ");
    assert.deepEqual(r.store.log, [{ at: "", text: "просто текст", live: true }]);
    await r.flush();
    r.live("last_message", "");
    assert.equal(r.store.log.length, 1);
    assert.equal(r.store.text("last_message"), "");
    assert.deepEqual(await r.flush(), [["last_message"]], "значение изменилось, журнал — нет");
    r.live("last_message", "1.11 9:05  не тот формат");
    assert.deepEqual(r.store.log[0], { at: "", text: "1.11 9:05  не тот формат", live: true });
  });

  it("многострочный текст и один пробел после времени разбираются", function () {
    const r = make();
    r.live("last_message", "10.11 22:08 строка 1\nстрока 2");
    assert.deepEqual(r.store.log[0], { at: "10.11 22:08", text: "строка 1\nстрока 2", live: true });
  });

  it("в журнале не больше 60 записей", function () {
    const r = make();
    for (let i = 0; i < 75; i++) r.live("last_message", "10.11 22:08  событие " + i);
    assert.equal(r.store.log.length, 60);
    assert.equal(r.store.log[0].text, "событие 74");
    assert.equal(r.store.log[59].text, "событие 15");
  });

  it("другие контролы в журнал не пишут", function () {
    const r = make();
    r.live("state", "10.11 22:08  Мойка").live("alarm_text", "Нет");
    assert.deepEqual(r.store.log, []);
  });
});

// ---------------------------------------------------------------------------
describe("снимок настоящего контроллера (tests/fixtures/wb7_retained.txt)", function () {
  function feed(filter) {
    const r = make();
    r.link("connected");
    fixture().filter(filter || function () { return true; })
      .forEach(function (x) { r.t.onMessage(x[0], x[1], true); });
    return r;
  }

  it("все контролы, типы, readonly, подписи", async function () {
    const r = feed();
    const s = r.store;
    assert.equal(s.ready, true);
    assert.equal(s.deviceTitle, "Посудомоечная машина");
    assert.equal(s.controls.size, 66);
    assert.deepEqual(await r.flush().then(function (ev) { return ev.length; }), 1, "вся пачка — одно уведомление");

    assert.equal(s.type("state"), "text");
    assert.equal(s.readonly("state"), true, "текст без readonly:false — только для чтения");
    assert.equal(s.title("state"), "Состояние", "подпись приходит как { en }");
    assert.equal(s.text("state"), "Мойка");
    assert.equal(s.type("alarm"), "alarm");
    assert.equal(s.readonly("alarm"), true);
    assert.equal(s.type("power"), "switch");
    assert.equal(s.readonly("power"), false);
    assert.equal(s.bool("power"), true);
    assert.equal(s.readonly("online"), true);
    assert.equal(s.type("finish_at"), "text");
    assert.equal(s.readonly("finish_at"), false);
    assert.equal(s.type("delay_h"), "range");
    assert.equal(s.meta("delay_h").min, 0);
    assert.equal(s.meta("delay_h").max, 24);
    assert.equal(s.meta("set_silencetime").min, 1);
    assert.equal(s.meta("set_silencetime").max, 30);
    assert.equal(s.meta("rssi").units, "dBm");
    assert.equal(s.num("rssi"), -60);
    assert.equal(s.num("progress"), 27);
    assert.equal(s.num("remaining_min"), 98);
  });

  it("кнопки и пустой текст: контрол есть, значения нет", function () {
    const s = feed().store;
    ["start", "abort"].forEach(function (id) {
      assert.equal(s.has(id), true, id);
      assert.equal(s.type(id), "pushbutton", id);
      assert.equal(s.readonly(id), false, id);
      assert.equal(s.raw(id), undefined, id);
    });
    ["finish_at", "start_in"].forEach(function (id) {
      assert.equal(s.has(id), true, id);
      assert.equal(s.raw(id), undefined, id + ": пустой текст брокер не хранит");
      assert.equal(s.text(id), "", id);
    });
  });

  it("программы и настройки-перечисления", function () {
    const s = feed().store;
    assert.deepEqual(s.options("program"), [
      { value: "8192", label: "Интенсивная 70°", key: "Intensiv70" },
      { value: "8195", label: "Авто 45–65°", key: "Auto2" },
      { value: "8196", label: "Эко 50°", key: "Eco50" },
      { value: "8200", label: "Предварительное ополаскивание", key: "PreRinse" },
      { value: "8202", label: "Тихая (ночная)", key: "NightWash" },
      { value: "8203", label: "Быстрая 65°", key: "Quick65" },
      { value: "8215", label: "Уход за машиной", key: "MachineCare" },
      { value: "32828", label: "Избранное", key: "001" },
    ]);
    assert.equal(s.raw("program"), "8192");
    assert.deepEqual(s.options("set_sound"), [
      { value: "0", label: "Выкл", key: "Off" },
      { value: "1", label: "Тихо", key: "Low" },
      { value: "2", label: "Средне", key: "Medium" },
      { value: "3", label: "Громко", key: "High" },
    ]);
    assert.deepEqual(s.options("power"), []);
  });

  it("списки опций, настроек и программ — в порядке контроллера", function () {
    const s = feed().store;
    assert.deepEqual(s.list("opt_"), ["opt_extradry", "opt_halfload", "opt_silence", "opt_variospeed"]);
    assert.deepEqual(s.list("set_"), ["set_cloud", "set_ecodefault", "set_extradry", "set_hardness", "set_hotwater",
      "set_infolight", "set_remotelevel", "set_rinseaid", "set_silencetime", "set_sound", "set_turbidity"]);
    assert.deepEqual(s.list("prog_"), ["prog_001", "prog_auto2", "prog_eco50", "prog_intensiv70", "prog_machinecare",
      "prog_nightwash", "prog_prerinse", "prog_quick65"]);
  });

  it("журнал: одна запись из retained", function () {
    const s = feed().store;
    assert.deepEqual(s.log, [{ at: "01.02 13:10", text: "Программу нельзя сменить во время мойки", live: false }]);
  });

  it("только старый формат метаданных: типы, порядок и границы есть, подписи — id", function () {
    const r = feed(function (x) { return !/\/meta$/.test(x[0]); });
    const s = r.store;
    assert.equal(s.controls.size, 66);
    assert.equal(s.deviceTitle, "Посудомоечная машина", "из /meta/name");
    assert.equal(s.type("state"), "text");
    assert.equal(s.readonly("state"), true);
    assert.equal(s.readonly("power"), false);
    assert.equal(s.type("start"), "pushbutton");
    assert.equal(s.meta("delay_h").max, 24);
    assert.equal(s.meta("set_silencetime").min, 1);
    assert.equal(s.meta("state").order, 65);
    assert.equal(s.title("state"), "state");
    assert.deepEqual(s.options("program"), []);
    assert.deepEqual(s.list("opt_"), ["opt_extradry", "opt_halfload", "opt_silence", "opt_variospeed"]);
  });

  it("порядок прихода сообщений не важен", function () {
    const a = feed().store;
    const lines = fixture().reverse();
    const r = make();
    lines.forEach(function (x) { r.t.onMessage(x[0], x[1], true); });
    const b = r.store;
    assert.equal(b.controls.size, a.controls.size);
    a.controls.forEach(function (c, id) {
      assert.equal(b.raw(id), c.value, id);
      assert.deepEqual(b.meta(id), c.meta, id);
    });
    assert.equal(b.deviceTitle, a.deviceTitle);
  });
});
