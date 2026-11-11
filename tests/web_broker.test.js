"use strict";
// Клиент MQTT веб-страницы (web/app/js/mqtt.js) против настоящего mosquitto
// со слушателем WebSocket. Нужен mosquitto и глобальный WebSocket:
//   node --experimental-websocket --test tests/web_broker.test.js   (Node 20)
//   node --test tests/web_broker.test.js                            (Node 22+)
// Без того или другого тесты пропускаются.

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function findMosquitto() {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean).concat(["/usr/sbin"]);
  for (const d of dirs) {
    const p = path.join(d, "mosquitto");
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* ищем дальше */ }
  }
  return null;
}

const BIN = findMosquitto();
const SKIP = !BIN ? "mosquitto не установлен"
  : typeof globalThis.WebSocket === "undefined" ? "нет глобального WebSocket (Node 20: --experimental-websocket)"
    : false;

// В CI пропуск недопустим: без брокера обмен остался бы непроверенным, а прогон — зелёным
if (SKIP && process.env.REQUIRE_BROKER === "1") {
  it("брокер обязателен (REQUIRE_BROKER=1)", function () { assert.fail("тест с брокером пропущен: " + SKIP); });
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// Ждёт выполнения условия; при неудаче сообщает, чего не дождались
async function waitFor(what, cond, timeout) {
  const end = Date.now() + (timeout || 5000);
  for (;;) {
    const v = cond();
    if (v) return v;
    if (Date.now() > end) throw new Error("не дождались: " + what);
    await sleep(10);
  }
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", function () {
      const port = s.address().port;
      s.close(function () { resolve(port); });
    });
  });
}

function portOpen(port) {
  return new Promise(function (resolve) {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", function () { s.destroy(); resolve(true); });
    s.on("error", function () { resolve(false); });
  });
}

describe("клиент и настоящий mosquitto по WebSocket", function () {
  let M, dir, port, url, broker = null, brokerLog = "";
  let clients = [];
  let seq = 0;

  async function startBroker() {
    brokerLog = "";
    const child = spawn(BIN, ["-c", path.join(dir, "mosquitto.conf")], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", function (d) { brokerLog += d; });
    child.exited = new Promise(function (r) { child.on("exit", r); child.on("error", r); });
    broker = child;
    const end = Date.now() + 5000;
    while (!(await portOpen(port))) {
      if (child.exitCode !== null || Date.now() > end) {
        throw new Error("mosquitto не запустился:\n" + brokerLog);
      }
      await sleep(20);
    }
  }

  async function stopBroker() {
    const child = broker;
    broker = null;
    if (!child) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }

  // Клиент с журналом сообщений и статусов. Сразу подписан на личную тему для sync()
  function client(name, filters) {
    const c = new M.MqttClient({
      url: url, clientId: "test-" + name + "-" + (++seq), keepAlive: 5, reconnectMin: 100, reconnectMax: 400,
    });
    c.msgs = []; c.statuses = [];
    c.syncTopic = "test/sync/" + c.clientId;
    c.onMessage = function (topic, payload, retained) { c.msgs.push({ topic: topic, payload: payload, retained: retained }); };
    c.onStatus = function (s) { c.statuses.push(s); };
    c.subscribe([c.syncTopic].concat(filters || []));
    clients.push(c);
    return c;
  }

  async function up(c) {
    c.connect();
    await waitFor("подключение " + c.clientId, function () { return c.connected; });
    await sync(c);
  }

  // Брокер обрабатывает пакеты одного клиента по порядку: когда метка вернулась,
  // все прежние подписки и публикации этого клиента уже учтены
  async function sync(c) {
    const mark = "метка-" + (++seq);
    assert.equal(c.publish(c.syncTopic, mark), true);
    await waitFor("метка для " + c.clientId, function () {
      return c.msgs.some(function (m) { return m.topic === c.syncTopic && m.payload === mark; });
    });
  }

  const got = function (c, topic) { return c.msgs.filter(function (m) { return m.topic === topic; }); };

  before(async function () {
    if (SKIP) return;
    M = await import("../web/app/js/mqtt.js");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-web-mqtt-"));
    port = await freePort();
    url = "ws://127.0.0.1:" + port + "/mqtt";
    fs.writeFileSync(path.join(dir, "mosquitto.conf"), [
      "listener " + port + " 127.0.0.1",
      "protocol websockets",
      "allow_anonymous true",
      "persistence false",
      "log_dest stderr",
      "",
    ].join("\n"));
    await startBroker();
  });

  afterEach(function () {
    clients.forEach(function (c) { c.close(); });
    clients = [];
  });

  after(async function () {
    clients.forEach(function (c) { c.close(); });
    try { await stopBroker(); } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retained-значения с кириллицей приходят новому подписчику, живые — без признака retained", { skip: SKIP }, async function () {
    const CTL = "/devices/dishwasher/controls/";
    const meta = JSON.stringify({ type: "text", readonly: true, title: { ru: "Программа", en: "Program" } });
    const a = client("a");
    await up(a);
    assert.equal(a.publish(CTL + "program", "Эко 50°", { retain: true }), true);
    assert.equal(a.publish(CTL + "program/meta", meta, { retain: true }), true);
    await sync(a); // брокер точно сохранил оба значения

    const b = client("b", [CTL + "+", CTL + "+/meta"]);
    await up(b);
    await waitFor("retained-сообщения", function () {
      return got(b, CTL + "program").length && got(b, CTL + "program/meta").length;
    });
    assert.deepEqual(got(b, CTL + "program"), [{ topic: CTL + "program", payload: "Эко 50°", retained: true }]);
    assert.deepEqual(got(b, CTL + "program/meta"), [{ topic: CTL + "program/meta", payload: meta, retained: true }]);

    a.publish(CTL + "program", "Авто 45–65°", { retain: true });
    await waitFor("живое сообщение", function () { return got(b, CTL + "program").length === 2; });
    assert.deepEqual(got(b, CTL + "program")[1], { topic: CTL + "program", payload: "Авто 45–65°", retained: false });
    assert.deepEqual(got(a, CTL + "program"), []); // A на эти темы не подписан
  });

  it("команда страницы доходит до контроллера", { skip: SKIP }, async function () {
    const a = client("a", ["/devices/dishwasher/controls/+/on"]);
    const b = client("b");
    await up(a);
    await up(b);
    assert.equal(b.publish("/devices/dishwasher/controls/power/on", "1"), true);
    await waitFor("команда", function () { return got(a, "/devices/dishwasher/controls/power/on").length; });
    assert.deepEqual(got(a, "/devices/dishwasher/controls/power/on"),
      [{ topic: "/devices/dishwasher/controls/power/on", payload: "1", retained: false }]);
    assert.deepEqual(got(b, "/devices/dishwasher/controls/power/on"), []);
  });

  it("сообщение в 70 000 байт проходит без искажений", { skip: SKIP }, async function () {
    let big = "";
    for (let i = 0; big.length < 70000; i++) big += i + ",";
    big = big.slice(0, 70000);
    assert.equal(Buffer.byteLength(big), 70000);
    const a = client("a");
    const b = client("b", ["test/big"]);
    await up(a);
    await up(b);
    assert.equal(a.publish("test/big", big), true);
    assert.equal(a.publish("test/big", "после"), true); // поток после большого пакета не сбился
    await waitFor("большое сообщение", function () { return got(b, "test/big").length === 2; });
    assert.equal(got(b, "test/big")[0].payload.length, 70000);
    assert.equal(got(b, "test/big")[0].payload === big, true);
    assert.equal(got(b, "test/big")[1].payload, "после");
  });

  it("после перезапуска брокера клиент сам переподключается и переподписывается", { skip: SKIP }, async function () {
    const a = client("a");
    const b = client("b", ["test/restart/+"]);
    await up(a);
    await up(b);

    await stopBroker();
    await waitFor("клиенты заметили обрыв", function () { return !a.connected && !b.connected; });
    assert.equal(b.publish("test/restart/x", "в пустоту"), false);
    assert.equal(b.statuses[b.statuses.length - 1], "reconnecting");
    await sleep(250); // несколько неудачных попыток при выключенном брокере
    assert.ok(b.statuses.filter(function (s) { return s === "reconnecting"; }).length >= 2,
      "отказ в соединении замечен сразу, без ожидания keep-alive");
    await startBroker();

    await waitFor("повторное подключение", function () { return a.connected && b.connected; }, 8000);
    assert.equal(b.statuses[b.statuses.length - 1], "connected");
    // subscribe() больше не вызываем: метка приходит только если подписки восстановлены
    await sync(b);
    assert.equal(a.publish("test/restart/x", "снова на связи"), true);
    await waitFor("сообщение после перезапуска", function () { return got(b, "test/restart/x").length; });
    assert.deepEqual(got(b, "test/restart/x"), [{ topic: "test/restart/x", payload: "снова на связи", retained: false }]);
  });
});
