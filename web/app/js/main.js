// Запуск страницы: настройки -> транспорт (MQTT или имитация) -> модель -> экран.

import { MqttClient } from "./mqtt.js";
import { SimTransport } from "./sim.js";
import { DeviceStore } from "./store.js";
import { mountUI } from "./ui.js";

const cfg = window.DISHWASHER_WEB || {};
const query = new URLSearchParams(window.location.search);
const demo = query.has("demo") ? query.get("demo") !== "0" : !!cfg.demo;

function mqttUrl() {
  if (query.get("mqtt")) return query.get("mqtt");
  if (cfg.mqtt) return cfg.mqtt;
  return (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "/mqtt";
}

const transport = demo
  ? new SimTransport({ device: cfg.device, speed: Number(query.get("speed")) || 60, scenario: query.get("scenario") || "running" })
  : new MqttClient({ url: mqttUrl() });

const store = new DeviceStore({ device: query.get("device") || cfg.device || "dishwasher", transport });
mountUI({ store, demo, sim: demo ? transport.sim : null });
store.start();

// телефон «усыпляет» вкладку и рвёт сокет: при возвращении на страницу не ждём очередной попытки
document.addEventListener("visibilitychange", () => {
  if (!demo && document.visibilityState === "visible" && !transport.connected) {
    transport.close();
    transport.connect();
  }
});
