#!/usr/bin/env node
// Поддельный Wiren Board для разработки и сквозных проверок страницы без контроллера и без машины.
//
// Подключает имитацию посудомойки (web/app/js/sim.js) к НАСТОЯЩЕМУ брокеру MQTT по WebSocket
// тем же клиентом, что и страница (web/app/js/mqtt.js), и ведёт себя как контроллер с правилом
// dishwasher.js:
//   - публикует retained /devices/<id>/meta, /controls/<ctrl> и /controls/<ctrl>/meta
//     (и метаданные в старом формате: meta/name, meta/type, meta/order, meta/readonly, meta/min, meta/max);
//   - слушает команды /devices/<id>/controls/+/on и отвечает на них, как правило;
//   - время идёт само: секунда настоящего времени — это --speed секунд машины.
//
// Запуск:
//   node web/tools/fake-wb.mjs [--url ws://127.0.0.1:18883] [--speed 60] [--scenario running|idle]
//                              [--device dishwasher] [--verbose]
//   Node 20–21: node --experimental-websocket web/tools/fake-wb.mjs ...   (в Node 22+ флаг не нужен)
//
//   --url       адрес брокера по WebSocket (по умолчанию ws://127.0.0.1:18883)
//   --speed     во сколько раз ускорить машину (60: программа на 3:45 пройдёт за 3 мин 45 с; 1 — как в жизни)
//   --scenario  running — идёт «Эко 50°», прошла треть (по умолчанию); idle — машина выключена
//   --device    id устройства (CFG.id правила), по умолчанию dishwasher
//   --verbose   печатать каждую публикацию, а не только команды, состояние и события
//
// Брокер — любой mosquitto со слушателем WebSocket, например:
//
//   # /tmp/fake-wb/mosquitto.conf
//   allow_anonymous true
//   persistence false
//   listener 18883 127.0.0.1
//   protocol websockets
//   listener 18830 127.0.0.1          # обычный MQTT — для mosquitto_sub / mosquitto_pub
//
//   mosquitto -c /tmp/fake-wb/mosquitto.conf &
//   node web/tools/fake-wb.mjs --scenario idle &
//   python3 -m http.server 8080 -d web/app
//   # страница: http://127.0.0.1:8080/?mqtt=ws://127.0.0.1:18883
//   # команда руками: mosquitto_pub -p 18830 -t /devices/dishwasher/controls/power/on -m 1
//   # что публикуется: mosquitto_sub -p 18830 -v -t '/devices/dishwasher/#'
//
// Пульт (строки на стандартный ввод), то, чего командами MQTT не сделать:
//   door 1|0       открыть / закрыть дверь
//   remote 1|0     разрешить / запретить удалённый старт
//   online 1|0     связь с машиной есть / пропала
//   flag <имя> 1|0 aquastop, salt_empty, salt_low, rinse_empty, rinse_low, filter_check, care_needed, fw_update
//   skip           перемотать программу (или задержку старта) к концу
//
// По Ctrl+C (SIGINT) и SIGTERM просто отключается: retained-сообщения остаются у брокера,
// как после остановки wb-rules. Следующий запуск перезапишет их своими.

import { createInterface } from "node:readline";
import { MqttClient } from "../app/js/mqtt.js";
import { Simulator } from "../app/js/sim.js";

const SCENARIOS = ["running", "idle"];
const FLAGS = ["aquastop", "salt_empty", "salt_low", "rinse_empty", "rinse_low", "filter_check", "care_needed", "fw_update"];
const USAGE = "node web/tools/fake-wb.mjs [--url ws://127.0.0.1:18883] [--speed 60] " +
  "[--scenario " + SCENARIOS.join("|") + "] [--device dishwasher] [--verbose]";

function fail(text) {
  console.error("fake-wb: " + text + "\n  " + USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const o = { url: "ws://127.0.0.1:18883", speed: 60, scenario: "running", device: "dishwasher", verbose: false };
  for (let i = 0; i < argv.length; i++) {
    let key = argv[i], value;
    const eq = key.indexOf("=");
    if (eq > 0) { value = key.slice(eq + 1); key = key.slice(0, eq); }
    if (key === "-h" || key === "--help") { console.log(USAGE); process.exit(0); }
    if (key === "--verbose") { o.verbose = true; continue; }
    if (["--url", "--speed", "--scenario", "--device"].indexOf(key) < 0) fail("неизвестный параметр " + argv[i]);
    if (value === undefined) value = argv[++i];
    if (value === undefined || value === "") fail("у параметра " + key + " нет значения");
    o[key.slice(2)] = value;
  }
  o.speed = Number(o.speed);
  if (!(o.speed > 0)) fail("--speed должен быть положительным числом");
  if (SCENARIOS.indexOf(o.scenario) < 0) fail("--scenario: " + SCENARIOS.join(" или "));
  if (!/^wss?:\/\//.test(o.url)) fail("--url должен начинаться с ws:// или wss://");
  if (!/^[^/#+\s]+$/.test(o.device)) fail("--device: id устройства без пробелов и символов / # +");
  return o;
}

const opts = parseArgs(process.argv.slice(2));

if (typeof globalThis.WebSocket !== "function") {
  console.error("fake-wb: в этом Node (" + process.version + ") нет глобального WebSocket.\n" +
    "  Node 20–21: node --experimental-websocket web/tools/fake-wb.mjs ...\n" +
    "  Node 22 и новее: флаг не нужен.");
  process.exit(1);
}

function log(text) {
  console.log(new Date().toTimeString().slice(0, 8) + "  " + text);
}

const prefix = "/devices/" + opts.device + "/";
const RETAIN = { retain: true };
const client = new MqttClient({ url: opts.url, clientId: "fake-wb-" + process.pid });

// Значения контролов у контроллера всегда retained; пустая строка стирает сообщение у брокера,
// как и у wb-rules с пустым текстовым контролом. Без связи публикация теряется — после
// подключения брокер получает полный снимок.
const sim = new Simulator({
  device: opts.device, speed: opts.speed, scenario: opts.scenario,
  publish: (topic, payload) => {
    if (!client.publish(topic, payload, RETAIN)) return;
    const id = topic.slice((prefix + "controls/").length);
    if (opts.verbose || id === "state" || id === "last_message") log("→ " + id + " = " + JSON.stringify(payload));
  }
});

// Полный снимок, как после запуска wb-rules
function publishAll() {
  const snapshot = sim.snapshot();
  const have = new Set();
  let n = 0;
  const pub = (topic, payload) => { if (client.publish(topic, String(payload), RETAIN)) n++; };
  snapshot.forEach(([topic, payload]) => {
    have.add(topic);
    pub(topic, payload);
    if (!/\/meta$/.test(topic)) return;
    // старый формат метаданных: контроллер публикует его рядом с JSON
    const meta = JSON.parse(payload);
    if (topic === prefix + "meta") {
      pub(topic + "/name", meta.title.en);
      pub(topic + "/driver", meta.driver);
      return;
    }
    pub(topic + "/type", meta.type);
    pub(topic + "/order", meta.order);
    pub(topic + "/readonly", meta.readonly ? "1" : "0");
    if (meta.min !== undefined) pub(topic + "/min", meta.min);
    if (meta.max !== undefined) pub(topic + "/max", meta.max);
  });
  // пустого текста в снимке нет; стираем значение, которое могло остаться от прошлого запуска
  sim.defs.forEach((d) => {
    const topic = prefix + "controls/" + d.id;
    if (d.type !== "pushbutton" && !have.has(topic)) pub(topic, "");
  });
  return n;
}

let everConnected = false;
client.onStatus = (status, info) => {
  if (status === "connected") {
    everConnected = true;
    const n = publishAll();
    log("подключён к " + opts.url + ": опубликовано " + n + " retained-сообщений, устройство " + prefix.slice(0, -1) +
      ", состояние «" + sim.sent.state + "»");
  } else if (status === "reconnecting") {
    log("нет связи с брокером" + (info ? " (" + info + ")" : "") + ", пробую снова" +
      (everConnected ? "" : ". Нужен mosquitto со слушателем «protocol websockets» на этом адресе"));
  }
};
client.onMessage = (topic, payload, retained) => {
  const m = /\/controls\/([^/]+)\/on$/.exec(topic);
  if (!m) return;
  if (retained) { log("пропущена retained-команда " + topic + " (команды не должны быть retained)"); return; }
  log("← " + m[1] + " = " + JSON.stringify(payload));
  sim.handle(topic, payload);
};

// Пульт: то, что в демо-режиме страницы делают переключатели имитации
function control(line) {
  const a = line.trim().split(/\s+/);
  const on = a[a.length - 1] === "1" || a[a.length - 1] === "on";
  if (!a[0]) return;
  if (a[0] === "door" && a.length === 2) sim.setDoor(on);
  else if (a[0] === "remote" && a.length === 2) sim.setRemote(on);
  else if (a[0] === "online" && a.length === 2) sim.setOnline(on);
  else if (a[0] === "flag" && a.length === 3 && FLAGS.indexOf(a[1]) >= 0) sim.setFlag(a[1], on);
  else if (a[0] === "skip") sim.skipToEnd();
  else { log("пульт: door 1|0, remote 1|0, online 1|0, flag <" + FLAGS.join("|") + "> 1|0, skip"); return; }
  log("пульт: " + a.join(" "));
}
let rl = null;
try {
  rl = createInterface({ input: process.stdin });
  rl.on("line", control);
  rl.on("error", () => {});
} catch (e) { /* стандартного ввода нет — работаем без пульта */ }

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(signal + ": отключаюсь, retained-сообщения остаются у брокера");
  sim.stop();
  client.close();
  if (rl) rl.close();
  setTimeout(() => process.exit(0), 300).unref();   // если что-то ещё держит процесс
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("fake-wb: сценарий " + opts.scenario + ", скорость ×" + opts.speed + ", брокер " + opts.url);
client.subscribe([prefix + "controls/+/on"]);
sim.start();          // до подключения публикации теряются; полный снимок уйдёт после CONNACK
client.connect();
