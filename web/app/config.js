// Настройки страницы. Файл переживает обновление: установщик его не перезаписывает.
window.DISHWASHER_WEB = {
  device: "dishwasher",   // id виртуального устройства из CFG.id правила dishwasher.js
  mqtt: "",               // адрес MQTT по WebSocket; пусто — ws://<этот же адрес>/mqtt (штатный прокси WB)
  demo: false             // true — без контроллера, с имитацией машины
};
