"use strict";
// Тесты клиента MQTT для веб-страницы (web/app/js/mqtt.js): кодирование пакетов
// и поведение клиента на поддельном WebSocket. Брокер не нужен.
//   node --test tests/web_mqtt.test.js

const { describe, it, before, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

let M;
before(async function () { M = await import("../web/app/js/mqtt.js"); });

const utf8 = function (s) { return Array.from(Buffer.from(s, "utf8")); };
const bytes = function (u8) { return Array.from(u8); };

// Пакет «как от брокера»: первый байт, длина (до 127), тело
function pkt(first, body) { return Uint8Array.from([first, body.length].concat(body)); }
function str(s) { const b = utf8(s); return [b.length >> 8, b.length & 0xff].concat(b); }
const CONNACK_OK = Uint8Array.of(0x20, 2, 0, 0);
const PINGRESP = Uint8Array.of(0xd0, 0);

describe("кодирование пакетов", function () {
  it("CONNECT без логина", function () {
    assert.deepEqual(bytes(M.encodeConnect({ clientId: "ab", keepAlive: 30 })), [
      0x10, 14,                         // CONNECT, осталось 14 байт
      0, 4, 0x4d, 0x51, 0x54, 0x54,     // "MQTT"
      4,                                // уровень протокола 3.1.1
      0x02,                             // чистая сессия
      0, 30,                            // keep-alive
      0, 2, 0x61, 0x62,                 // идентификатор клиента
    ]);
  });

  it("CONNECT с логином и паролем", function () {
    assert.deepEqual(bytes(M.encodeConnect({ clientId: "c", keepAlive: 300, username: "u", password: "пш" })), [
      0x10, 22,
      0, 4, 0x4d, 0x51, 0x54, 0x54, 4,
      0xc2,                             // логин + пароль + чистая сессия
      0x01, 0x2c,                       // 300 секунд
      0, 1, 0x63,
      0, 1, 0x75,
      0, 4, 0xd0, 0xbf, 0xd1, 0x88,     // «пш» в UTF-8
    ]);
  });

  it("SUBSCRIBE с двумя фильтрами", function () {
    assert.deepEqual(bytes(M.encodeSubscribe(0x0102, ["a/+", "b"])), [
      0x82, 12,                         // SUBSCRIBE с обязательными флагами 0010
      0x01, 0x02,                       // идентификатор пакета
      0, 3, 0x61, 0x2f, 0x2b, 0,        // "a/+", QoS 0
      0, 1, 0x62, 0,                    // "b", QoS 0
    ]);
  });

  it("PUBLISH: обычный, retain и кириллица", function () {
    assert.deepEqual(bytes(M.encodePublish("a/b", "1")), [0x30, 6, 0, 3, 0x61, 0x2f, 0x62, 0x31]);
    assert.deepEqual(bytes(M.encodePublish("a/b", "1", { retain: true })), [0x31, 6, 0, 3, 0x61, 0x2f, 0x62, 0x31]);
    assert.deepEqual(bytes(M.encodePublish("a", "")), [0x30, 3, 0, 1, 0x61]);
    assert.deepEqual(bytes(M.encodePublish("т", "Эко 50°")),
      [0x30, 15, 0, 2, 0xd1, 0x82,
        0xd0, 0xad, 0xd0, 0xba, 0xd0, 0xbe, 0x20, 0x35, 0x30, 0xc2, 0xb0]);
  });

  it("длина пакета на границах 127/128/16383/16384", function () {
    // тело = 2 байта длины темы + 1 байт темы + полезная нагрузка
    const cases = [
      [127, [0x7f]], [128, [0x80, 0x01]],
      [16383, [0xff, 0x7f]], [16384, [0x80, 0x80, 0x01]],
      [2097151, [0xff, 0xff, 0x7f]], [2097152, [0x80, 0x80, 0x80, 0x01]],
    ];
    cases.forEach(function (c) {
      const p = M.encodePublish("t", "x".repeat(c[0] - 3));
      assert.deepEqual(bytes(p.subarray(1, 1 + c[1].length)), c[1], "длина " + c[0]);
      assert.equal(p.length, 1 + c[1].length + c[0]);
      // и обратно: читатель восстанавливает ту же длину
      const got = new M.PacketReader().push(p);
      assert.equal(got.length, 1);
      assert.equal(got[0].body.length, c[0]);
    });
  });
});

describe("разбор потока", function () {
  it("пакет, разрезанный в любом месте", function () {
    // 200 байт нагрузки: длина занимает два байта, разрез попадает и внутрь неё
    const one = M.encodePublish("устройство/тема", "ж".repeat(100), { retain: true });
    const two = M.encodePublish("b", "конец");
    const all = new Uint8Array(one.length + two.length + 2);
    all.set(one, 0); all.set(PINGRESP, one.length); all.set(two, one.length + 2);
    for (let cut = 0; cut <= all.length; cut++) {
      const r = new M.PacketReader();
      const got = r.push(all.slice(0, cut)).concat(r.push(all.slice(cut).buffer));
      assert.equal(got.length, 3, "разрез на " + cut);
      assert.deepEqual([got[0].type, got[0].flags], [3, 1]);
      assert.deepEqual([got[1].type, got[1].body.length], [13, 0]);
      const a = M.parsePublish(got[0].flags, got[0].body);
      assert.deepEqual([a.topic, a.payload, a.retained], ["устройство/тема", "ж".repeat(100), true]);
      assert.equal(M.parsePublish(got[2].flags, got[2].body).payload, "конец");
    }
  });

  it("по одному байту", function () {
    const all = M.encodePublish("a/b", "я".repeat(300));
    const r = new M.PacketReader();
    let got = [];
    for (let i = 0; i < all.length; i++) {
      got = got.concat(r.push(all.subarray(i, i + 1)));
      if (i < all.length - 1) assert.equal(got.length, 0);
    }
    assert.equal(got.length, 1);
    assert.equal(M.parsePublish(got[0].flags, got[0].body).payload, "я".repeat(300));
  });

  it("несколько пакетов в одном куске", function () {
    const all = Uint8Array.from([0x20, 2, 0, 0, 0x90, 3, 0, 1, 0, 0xd0, 0]);
    const got = new M.PacketReader().push(all);
    assert.deepEqual(got.map(function (p) { return p.type; }), [2, 9, 13]);
    assert.deepEqual(bytes(got[1].body), [0, 1, 0]);
  });

  it("пятый байт длины — ошибка", function () {
    assert.throws(function () { new M.PacketReader().push(Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x80, 0x01)); });
    const r = new M.PacketReader();
    assert.deepEqual(r.push(Uint8Array.of(0x30, 0xff, 0xff)), []);
    assert.throws(function () { r.push(Uint8Array.of(0xff, 0xff)); });
  });

  it("parsePublish: кириллица, retain, QoS", function () {
    const body = Uint8Array.from(str("/devices/посудомойка/controls/программа").concat(utf8("Эко 50°")));
    assert.deepEqual(M.parsePublish(1, body), {
      topic: "/devices/посудомойка/controls/программа", payload: "Эко 50°",
      retained: true, qos: 0, packetId: null,
    });
    assert.equal(M.parsePublish(0, body).retained, false);
    const q1 = Uint8Array.from(str("a").concat([0x12, 0x34], utf8("да")));
    assert.deepEqual(M.parsePublish(2, q1), { topic: "a", payload: "да", retained: false, qos: 1, packetId: 0x1234 });
    assert.equal(M.parsePublish(0, Uint8Array.from(str("a"))).payload, "");
    assert.throws(function () { M.parsePublish(0, Uint8Array.of(0, 5, 0x61)); });
  });
});

// Поддельный WebSocket: запоминает отправленное, тест сам играет роль брокера
class FakeWS {
  constructor(url, protocols) {
    this.url = url; this.protocols = protocols; this.sent = []; this.closed = false;
    FakeWS.all.push(this);
  }
  send(data) {
    if (this.closed) throw new Error("сокет закрыт");
    this.sent.push(Uint8Array.from(data));
  }
  close() { this.closed = true; }
  // действия «со стороны сервера»
  open() { if (this.onopen) this.onopen({}); }
  recv(u8) { if (this.onmessage) this.onmessage({ data: Uint8Array.from(u8).buffer }); }
  drop() { this.closed = true; if (this.onclose) this.onclose({ code: 1006 }); }
  types() { return this.sent.map(function (p) { return p[0] >> 4; }); }
}
FakeWS.all = [];

describe("клиент на поддельном WebSocket", function () {
  let c, log, msgs;
  const last = function () { return FakeWS.all[FakeWS.all.length - 1]; };

  function make(opts) {
    c = new M.MqttClient(Object.assign({ url: "ws://wb/mqtt", clientId: "t", WebSocketImpl: FakeWS }, opts || {}));
    log = []; msgs = [];
    c.onStatus = function (s, info) { log.push(info === undefined ? s : s + ": " + info); };
    c.onMessage = function (t, p, r) { msgs.push([t, p, r]); };
    return c;
  }
  // Доводит до состояния «подключён» и возвращает сокет
  function up(opts) {
    make(opts);
    c.connect();
    const ws = last();
    ws.open(); ws.recv(CONNACK_OK);
    return ws;
  }

  beforeEach(function () {
    FakeWS.all = [];
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  });
  afterEach(function () {
    if (c) c.close();
    c = null;
    mock.timers.reset();
  });

  it("порядок рукопожатия: CONNECT, после CONNACK — SUBSCRIBE, затем connected", function () {
    make();
    c.subscribe(["a/+", "б/#"]); // до connect(): только запоминается
    c.connect();
    const ws = last();
    assert.equal(ws.url, "ws://wb/mqtt");
    assert.deepEqual(ws.protocols, ["mqtt"]);
    assert.equal(ws.binaryType, "arraybuffer");
    assert.deepEqual(ws.sent, []); // до открытия сокета ничего не шлём
    ws.open();
    assert.deepEqual(ws.sent, [M.encodeConnect({ clientId: "t", keepAlive: 30 })]);
    assert.equal(c.connected, false);
    assert.deepEqual(log, ["connecting"]);

    let sentAtConnected = null;
    const prev = c.onStatus;
    c.onStatus = function (s, info) { if (s === "connected") sentAtConnected = ws.sent.length; prev(s, info); };
    ws.recv(CONNACK_OK);
    assert.equal(sentAtConnected, 2, "SUBSCRIBE уходит раньше события connected");
    assert.deepEqual(ws.sent[1], M.encodeSubscribe(1, ["a/+", "б/#"]));
    assert.equal(c.connected, true);
    assert.deepEqual(log, ["connecting", "connected"]);
  });

  it("идентификатор клиента по умолчанию и логин", function () {
    c = new M.MqttClient({ url: "ws://x", WebSocketImpl: FakeWS, username: "u", password: "p", keepAlive: 10 });
    assert.match(c.clientId, /^dw-web-[0-9a-z]+$/);
    c.connect(); last().open();
    assert.deepEqual(last().sent[0],
      M.encodeConnect({ clientId: c.clientId, keepAlive: 10, username: "u", password: "p" }));
  });

  it("publish: false без соединения, true и верные байты при соединении", function () {
    make();
    assert.equal(c.publish("a", "1"), false);
    c.subscribe(["x"]); // тоже не бросает
    c.connect();
    assert.equal(c.publish("a", "1"), false);
    const ws = last();
    ws.open();
    assert.equal(c.publish("a", "1"), false); // CONNACK ещё не пришёл
    ws.recv(CONNACK_OK);
    assert.equal(c.publish("/devices/dishwasher/controls/power/on", "1"), true);
    assert.equal(c.publish("т", "Эко", { retain: true }), true);
    assert.deepEqual(ws.sent.slice(2), [
      M.encodePublish("/devices/dishwasher/controls/power/on", "1"),
      M.encodePublish("т", "Эко", { retain: true }),
    ]);
    ws.drop();
    assert.equal(c.connected, false);
    assert.equal(c.publish("a", "1"), false);
    c.close();
    assert.equal(c.publish("a", "1"), false);
  });

  it("subscribe при соединении шлёт только новые фильтры", function () {
    const ws = up();
    assert.deepEqual(ws.types(), [1]); // подписок нет — SUBSCRIBE не шлём
    c.subscribe(["a", "b"]);
    c.subscribe(["b", "c"]);
    c.subscribe(["c"]);
    assert.deepEqual(ws.sent.slice(1), [M.encodeSubscribe(1, ["a", "b"]), M.encodeSubscribe(2, ["c"])]);
  });

  it("входящие сообщения: тема, текст, признак retained", function () {
    const ws = up();
    const a = M.encodePublish("/devices/dishwasher/controls/program", "Эко 50°", { retain: true });
    const b = M.encodePublish("a", "1");
    const both = new Uint8Array(a.length + b.length);
    both.set(a, 0); both.set(b, a.length);
    ws.recv(both.slice(0, 7)); // пакет приходит двумя кадрами, второй пакет — в том же кадре
    assert.deepEqual(msgs, []);
    ws.recv(both.slice(7));
    assert.deepEqual(msgs, [["/devices/dishwasher/controls/program", "Эко 50°", true], ["a", "1", false]]);
  });

  it("на входящий QoS 1 отвечает PUBACK, QoS 2 просто доставляет", function () {
    const ws = up();
    ws.recv(pkt(0x32, str("a").concat([0x12, 0x34], utf8("да"))));
    assert.deepEqual(msgs, [["a", "да", false]]);
    assert.deepEqual(bytes(ws.sent[ws.sent.length - 1]), [0x40, 2, 0x12, 0x34]);
    const n = ws.sent.length;
    ws.recv(pkt(0x35, str("b").concat([0, 7], utf8("x"))));
    assert.deepEqual(msgs[1], ["b", "x", true]);
    assert.equal(ws.sent.length, n);
    ws.recv(pkt(0x30, str("c").concat(utf8("0")))); // QoS 0 — без ответа
    assert.equal(ws.sent.length, n);
  });

  it("обрыв: переподключение с растущей задержкой и повторная подписка", function () {
    const ws1 = up({ reconnectMin: 100, reconnectMax: 350 });
    c.subscribe(["a/+"]);
    ws1.drop();
    assert.equal(c.connected, false);
    assert.deepEqual(log.slice(-1), ["reconnecting: соединение потеряно"]);
    mock.timers.tick(99);
    assert.equal(FakeWS.all.length, 1);
    mock.timers.tick(1);
    assert.equal(FakeWS.all.length, 2);

    // брокер недоступен: 200, затем 350 (потолок), снова 350
    [200, 350, 350].forEach(function (d) {
      last().drop();
      assert.deepEqual(log.slice(-1), ["reconnecting: не удалось подключиться"]);
      const n = FakeWS.all.length;
      mock.timers.tick(d - 1);
      assert.equal(FakeWS.all.length, n, "рано для задержки " + d);
      mock.timers.tick(1);
      assert.equal(FakeWS.all.length, n + 1);
    });

    const ws = last();
    ws.open(); ws.recv(CONNACK_OK);
    assert.equal(c.connected, true);
    assert.deepEqual(ws.sent, [M.encodeConnect({ clientId: "t", keepAlive: 30 }), M.encodeSubscribe(2, ["a/+"])]);
    assert.deepEqual(log.slice(-1), ["connected"]);
    ws.recv(M.encodePublish("a/b", "1"));
    assert.deepEqual(msgs, [["a/b", "1", false]]);

    // после успешного подключения задержка снова минимальная
    ws.drop();
    const n = FakeWS.all.length;
    mock.timers.tick(100);
    assert.equal(FakeWS.all.length, n + 1);
    // события старого сокета больше ни на что не влияют
    ws1.recv(M.encodePublish("старый", "1"));
    assert.equal(msgs.length, 1);
  });

  it("error без close (так ведёт себя WebSocket в Node 20) тоже ведёт к новой попытке", function () {
    make({ reconnectMin: 100 });
    c.connect();
    last().onerror({ type: "error" });
    assert.deepEqual(log, ["connecting", "reconnecting: не удалось подключиться"]);
    assert.equal(last().closed, true);
    mock.timers.tick(100);
    assert.equal(FakeWS.all.length, 2);
    // error и следом close, как в браузере: одна попытка, а не две
    const ws = last();
    const onclose = ws.onclose;
    ws.onerror({ type: "error" });
    if (ws.onclose) ws.onclose({ code: 1006 });
    assert.equal(onclose !== null && ws.onclose === null, true);
    assert.equal(log.length, 3);
    mock.timers.tick(200);
    assert.equal(FakeWS.all.length, 3);
  });

  it("отказ в CONNACK: причина в статусе, попытки продолжаются", function () {
    make({ reconnectMin: 100 });
    c.subscribe(["a"]);
    c.connect();
    const ws = last();
    ws.open(); ws.recv(Uint8Array.of(0x20, 2, 0, 5));
    assert.equal(c.connected, false);
    assert.deepEqual(log, ["connecting", "reconnecting: брокер отклонил подключение, код 5"]);
    assert.equal(ws.closed, true);
    assert.deepEqual(ws.types(), [1]); // ни SUBSCRIBE, ни DISCONNECT
    mock.timers.tick(100);
    assert.equal(FakeWS.all.length, 2);
    last().open(); last().recv(CONNACK_OK);
    assert.deepEqual(log.slice(-1), ["connected"]);
  });

  it("keep-alive: PINGREQ каждые keepAlive/2, молчание 1.5 × keepAlive — переподключение", function () {
    const ws = up({ keepAlive: 10, reconnectMin: 100 });
    mock.timers.tick(4999);
    assert.deepEqual(ws.types(), [1]);
    mock.timers.tick(1);
    assert.deepEqual(ws.types(), [1, 12]);
    assert.deepEqual(bytes(ws.sent[1]), [0xc0, 0]);
    ws.recv(PINGRESP); // t = 5 с: отсчёт молчания начинается заново
    mock.timers.tick(5000);
    assert.deepEqual(ws.types(), [1, 12, 12]);
    mock.timers.tick(9999); // t = 20 с без одной миллисекунды
    assert.equal(c.connected, true);
    assert.equal(ws.closed, false);
    mock.timers.tick(1);
    assert.equal(c.connected, false);
    assert.equal(ws.closed, true);
    assert.deepEqual(log.slice(-1), ["reconnecting: нет ответа от брокера"]);
    const pings = ws.sent.length;
    mock.timers.tick(100);
    assert.equal(FakeWS.all.length, 2);
    mock.timers.tick(60000); // таймеры старого соединения сняты
    assert.equal(ws.sent.length, pings);
  });

  it("брокер не ответил на CONNECT — тоже «нет ответа от брокера»", function () {
    make({ keepAlive: 10 });
    c.connect();
    last().open();
    mock.timers.tick(15000);
    assert.equal(last().closed, true);
    assert.deepEqual(log, ["connecting", "reconnecting: нет ответа от брокера"]);
  });

  it("мусор вместо пакета: соединение сбрасывается и поднимается заново", function (t) {
    t.mock.method(console, "error", function () {});
    const ws = up({ reconnectMin: 100 });
    ws.recv(Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x80, 0x01));
    assert.equal(c.connected, false);
    assert.equal(ws.closed, true);
    assert.deepEqual(log.slice(-1), ["reconnecting: ошибка протокола"]);
    mock.timers.tick(100);
    assert.equal(FakeWS.all.length, 2);
  });

  it("close(): DISCONNECT, статус closed, таймеров не остаётся", function () {
    const ws = up({ keepAlive: 10 });
    c.close();
    assert.deepEqual(bytes(ws.sent[ws.sent.length - 1]), [0xe0, 0]);
    assert.equal(ws.closed, true);
    assert.equal(c.connected, false);
    assert.deepEqual(log, ["connecting", "connected", "closed"]);
    const n = ws.sent.length;
    mock.timers.tick(600000);
    assert.equal(FakeWS.all.length, 1);
    assert.equal(ws.sent.length, n);
    c.close(); // повторный вызов ничего не делает
    assert.equal(log.length, 3);
  });

  it("close() во время ожидания переподключения отменяет попытку", function () {
    const ws = up({ reconnectMin: 100 });
    ws.drop();
    c.close();
    assert.deepEqual(ws.types(), [1]); // DISCONNECT слать уже некуда
    mock.timers.tick(600000);
    assert.equal(FakeWS.all.length, 1);
    assert.deepEqual(log.slice(-1), ["closed"]);
  });

  it("исключения в обработчиках не ломают клиент", function (t) {
    const errors = t.mock.method(console, "error", function () {});
    make();
    c.onStatus = function () { throw new Error("сбой в onStatus"); };
    c.onMessage = function (topic) { msgs.push(topic); throw new Error("сбой в onMessage"); };
    c.connect();
    const ws = last();
    ws.open(); ws.recv(CONNACK_OK);
    assert.equal(c.connected, true);
    const two = Uint8Array.from(bytes(M.encodePublish("a", "1")).concat(bytes(M.encodePublish("b", "2"))));
    ws.recv(two);
    assert.deepEqual(msgs, ["a", "b"]);
    assert.equal(c.connected, true);
    assert.equal(c.publish("a", "1"), true);
    assert.equal(errors.mock.callCount(), 4); // connecting, connected и два сообщения
  });

  it("конструктор WebSocket бросил исключение — клиент продолжает попытки", function () {
    let fail = true;
    class Flaky extends FakeWS {
      constructor(url, protocols) { if (fail) throw new Error("отказ"); super(url, protocols); }
    }
    make({ WebSocketImpl: Flaky, reconnectMin: 100 });
    c.connect();
    assert.deepEqual(log, ["connecting", "reconnecting: не удалось открыть соединение: отказ"]);
    fail = false;
    mock.timers.tick(100);
    assert.equal(FakeWS.all.length, 1);
  });
});
