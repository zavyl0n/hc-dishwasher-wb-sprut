"use strict";
// Поддельный контроллер для разработки (web/tools/fake-wb.mjs): разбор параметров и сквозная
// проверка «страница — брокер — контроллер» на настоящем mosquitto. На стороне страницы —
// те же модули, что в браузере: mqtt.js, store.js, model.js.
//   node --experimental-websocket --test tests/web_fakewb.test.js   (Node 20)
//   node --test tests/web_fakewb.test.js                            (Node 22+)
// Без mosquitto или глобального WebSocket сквозные тесты пропускаются.

const { describe, it, before, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const TOOL = path.join(__dirname, "..", "web", "tools", "fake-wb.mjs");
// дочернему Node нужен тот же флаг, с которым запущены тесты
const NODE_FLAGS = process.execArgv.filter(function (a) { return a === "--experimental-websocket"; });

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

// В CI пропуск недопустим, как и в tests/web_broker.test.js
if (SKIP && process.env.REQUIRE_BROKER === "1") {
  it("брокер обязателен (REQUIRE_BROKER=1)", function () { assert.fail("тест с брокером пропущен: " + SKIP); });
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

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

// ---------------------------------------------------------------------------
describe("fake-wb: параметры", function () {
  const run = function (args, flags) {
    return spawnSync(process.execPath, (flags || NODE_FLAGS).concat([TOOL]).concat(args), { encoding: "utf8", timeout: 10000 });
  };

  it("--help печатает строку запуска", function () {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /fake-wb\.mjs \[--url ws:\/\/127\.0\.0\.1:18883\] \[--speed 60\] \[--scenario running\|idle\] \[--device dishwasher\]/);
  });

  it("неизвестный параметр и неверные значения — код 2 и пояснение", function () {
    [
      [["--bogus"], /неизвестный параметр --bogus/],
      [["--speed", "0"], /--speed должен быть положительным числом/],
      [["--speed=abc"], /--speed должен быть положительным числом/],
      [["--scenario", "party"], /--scenario: running или idle/],
      [["--url", "mqtt://127.0.0.1:1883"], /--url должен начинаться с ws:\/\/ или wss:\/\//],
      [["--device", "a/b"], /--device/],
      [["--url"], /у параметра --url нет значения/],
    ].forEach(function (c) {
      const r = run(c[0]);
      assert.equal(r.status, 2, c[0].join(" "));
      assert.match(r.stderr, c[1], c[0].join(" "));
    });
  });

  it("без глобального WebSocket подсказывает флаг и выходит с кодом 1", function () {
    const r = run(["--url", "ws://127.0.0.1:9"], ["--no-experimental-websocket"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /нет глобального WebSocket/);
    assert.match(r.stderr, /node --experimental-websocket web\/tools\/fake-wb\.mjs/);
  });
});

// ---------------------------------------------------------------------------
describe("fake-wb и страница через настоящий mosquitto", function () {
  let Mqtt, Store, Model, dir, port, url, broker = null, brokerLog = "";
  let stores = [], tools = [];
  let seq = 0;

  async function startBroker() {
    brokerLog = "";
    const child = spawn(BIN, ["-c", path.join(dir, "mosquitto.conf")], { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", function (d) { brokerLog += d; });
    child.exited = new Promise(function (r) { child.on("exit", r); child.on("error", r); });
    broker = child;
    const end = Date.now() + 5000;
    while (!(await portOpen(port))) {
      if (child.exitCode !== null || Date.now() > end) throw new Error("mosquitto не запустился:\n" + brokerLog);
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

  // Запущенный fake-wb: ждём, пока он опубликует устройство
  async function fakeWb(device, args) {
    const child = spawn(process.execPath,
      NODE_FLAGS.concat([TOOL, "--url", url, "--device", device]).concat(args || []), { stdio: ["pipe", "pipe", "pipe"] });
    child.out = "";
    child.stdout.on("data", function (d) { child.out += d; });
    child.stderr.on("data", function (d) { child.out += d; });
    child.exited = new Promise(function (r) { child.on("exit", function (code, signal) { r({ code: code, signal: signal }); }); });
    tools.push(child);
    await waitFor("fake-wb опубликовал устройство\n" + child.out, function () {
      if (child.exitCode !== null) throw new Error("fake-wb завершился:\n" + child.out);
      return /опубликовано \d+ retained-сообщений/.test(child.out);
    });
    return child;
  }

  // Страница: клиент MQTT и хранилище, как в main.js
  async function page(device) {
    const client = new Mqtt.MqttClient({ url: url, clientId: "page-" + (++seq), reconnectMin: 100, reconnectMax: 400 });
    const store = new Store.DeviceStore({ device: device, transport: client });
    stores.push(store);
    store.start();
    await waitFor("страница получила устройство " + device, function () {
      return store.link === "connected" && store.has("state") && store.has("water_forecast") && store.type("water_forecast");
    });
    return store;
  }

  before(async function () {
    if (SKIP) return;
    Mqtt = await import("../web/app/js/mqtt.js");
    Store = await import("../web/app/js/store.js");
    Model = await import("../web/app/js/model.js");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dw-fake-wb-"));
    port = await freePort();
    url = "ws://127.0.0.1:" + port;
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

  afterEach(async function () {
    stores.forEach(function (s) { s.stop(); });
    stores = [];
    const running = tools;
    tools = [];
    running.forEach(function (c) { if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL"); });
    await Promise.all(running.map(function (c) { return c.exited; }));
  });

  after(async function () {
    try { await stopBroker(); } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("публикует устройство как контроллер: страница видит выключенную машину", { skip: SKIP }, async function () {
    await fakeWb("dw_a", ["--scenario", "idle"]);
    const s = await page("dw_a");
    await waitFor("все значения", function () { return s.has("fw") && s.raw("fw") !== undefined; });
    assert.equal(s.controls.size, 66);
    assert.equal(s.deviceTitle, "Посудомоечная машина");
    assert.equal(s.type("state"), "text");
    assert.equal(s.readonly("state"), true);
    assert.equal(s.readonly("power"), false);
    assert.equal(s.type("start"), "pushbutton");
    assert.equal(s.meta("delay_h").max, 24);
    assert.equal(s.options("program").length, 8);
    assert.equal(s.log.length, 1);
    assert.equal(s.log[0].live, false);
    const v = Model.derive(s, false);
    assert.equal(v.link, "ok");
    assert.equal(v.mode, "off");
    assert.equal(v.dial.value, "Выключена");
    assert.equal(v.action.disabled, false);
    assert.equal(v.selected.key, "Eco50");
  });

  it("команды страницы: питание, программа, старт; мойка идёт и завершается", { skip: SKIP }, async function () {
    await fakeWb("dw_b", ["--scenario", "idle", "--speed", "900"]);   // час мойки — за 4 секунды
    const s = await page("dw_b");
    const mode = function () { return Model.derive(s, false).mode; };

    assert.equal(s.set("power", true), true);
    assert.equal(s.shownBool("power"), true);
    await waitFor("включение", function () { return s.bool("power") && mode() === "ready"; });
    assert.equal(s.pending("power"), undefined);

    s.set("program", 8203);
    await waitFor("выбор программы", function () { return s.raw("program") === "8203" && s.pending("program") === undefined; });
    assert.equal(Model.derive(s, false).selected.title, "Быстрая 65°");

    assert.equal(s.press("start"), true);
    await waitFor("мойка началась", function () { return mode() === "running"; });
    assert.equal(s.text("active_program"), "Быстрая 65°");
    assert.match(s.log[0].text, /^▶ Мойка началась: Быстрая 65°, окончание ≈ \d\d:\d\d/);
    assert.equal(s.log[0].live, true);

    // запись в контрол только для чтения контроллер не слушает, выключение во время мойки — отклоняет
    s.set("state", "Готова");
    s.set("power", false);
    await waitFor("отказ в выключении", function () { return /Выключение отменено/.test(s.text("last_message")); });
    assert.equal(s.bool("power"), true);
    assert.equal(s.text("state"), "Мойка");

    await waitFor("мойка завершена", function () { return mode() === "finished"; }, 20000);
    const v = Model.derive(s, false);
    assert.equal(v.dial.value, "Чисто");
    assert.equal(v.unloadPending, true);
    assert.match(s.log[0].text, /^✅ Мойка завершена: Быстрая 65°\. Можно разгружать$/);
    assert.equal(s.num("progress"), 100);
  });

  it("пульт на стандартном вводе: дверь, связь с машиной, индикаторы", { skip: SKIP }, async function () {
    const wb = await fakeWb("dw_c", ["--scenario", "idle"]);
    const s = await page("dw_c");
    wb.stdin.write("door 1\n");
    await waitFor("дверь открыта", function () { return s.bool("door_open"); });
    wb.stdin.write("flag salt_empty 1\nonline 0\n");
    await waitFor("нет связи с машиной", function () { return s.has("online") && !s.bool("online") && s.bool("salt_empty"); });
    assert.equal(Model.derive(s, false).link, "machine");
    assert.equal(s.num("salt_level"), 0);
    wb.stdin.write("online 1\ndoor 0\nчто-то не то\n");
    await waitFor("связь вернулась", function () { return s.bool("online") && !s.bool("door_open"); });
    await waitFor("подсказка по пульту", function () { return /пульт: door 1\|0, remote 1\|0, online 1\|0, flag </.test(wb.out); });
  });

  it("SIGTERM: выходит сам, retained остаются; следующий запуск стирает устаревшее", { skip: SKIP }, async function () {
    const first = await fakeWb("dw_d", ["--scenario", "running"]);
    let s = await page("dw_d");
    await waitFor("идёт мойка", function () { return s.text("state") === "Мойка" && s.text("remaining") !== ""; });
    first.kill("SIGTERM");
    assert.deepEqual(await first.exited, { code: 0, signal: null });
    assert.match(first.out, /SIGTERM: отключаюсь, retained-сообщения остаются у брокера/);
    s.stop();

    // контроллера нет, а новая страница всё равно видит последнее состояние
    s = await page("dw_d");
    await waitFor("retained после остановки", function () { return s.text("state") === "Мойка" && s.text("active_program") === "Эко 50°"; });
    s.stop();

    await fakeWb("dw_d", ["--scenario", "idle"]);
    s = await page("dw_d");
    await waitFor("состояние нового запуска", function () { return s.text("state") === "Выключена"; });
    await sleep(100);
    ["active_program", "remaining", "phase"].forEach(function (id) {
      assert.equal(s.has(id), true, id);
      assert.equal(s.raw(id), undefined, id + ": пустой текст у брокера стёрт");
    });
    assert.equal(Model.derive(s, false).mode, "off");
  });

  it("после перезапуска брокера публикует устройство заново", { skip: SKIP }, async function () {
    const wb = await fakeWb("dw_e", ["--scenario", "idle"]);
    await stopBroker();
    await waitFor("fake-wb заметил обрыв", function () { return /нет связи с брокером/.test(wb.out); });
    await startBroker();                         // брокер без хранилища: retained потеряны
    await waitFor("повторная публикация", function () {
      return (wb.out.match(/опубликовано \d+ retained-сообщений/g) || []).length >= 2;
    }, 10000);
    const s = await page("dw_e");
    await waitFor("значения", function () { return s.text("state") === "Выключена" && s.raw("fw") !== undefined; });
    assert.equal(s.controls.size, 66);
  });
});
