"use strict";
// Печатает (JSON) все команды, которые правило отправляет в hcpy при типичных действиях
// пользователя. Используется tests/test_hcpy_contract.py: каждую команду проверяют
// настоящие валидаторы hcpy (HCDevice.test_feature / test_program_data).
//   node tests/dump_commands.js [путь к правилу]
process.env.TZ = "Europe/Moscow";
const path = require("path");
const { load } = require("./wbrules");

const file = process.argv[2] || path.join(__dirname, "..", "examples", "SMV4HVX31E", "dishwasher.js");
const B = "homeconnect/dishwasher";
const READY = {
  bsh_common_setting_powerstate: "On",
  bsh_common_status_operationstate: "Ready",
  bsh_common_status_doorstate: "Closed",
  bsh_common_status_remotecontrolstartallowed: "True",
  bsh_common_root_selectedprogram: "Eco50",
  bsh_common_option_remainingprogramtime: "13500",
};

function boot(state) {
  const e = load(file);
  e.mqtt("homeconnect/LWT", "online", true);
  e.mqtt(B + "/LWT", "online", true);
  const st = Object.assign({}, READY, state || {});
  Object.keys(st).forEach(function (k) { e.mqtt(B + "/state/" + k, st[k], true); });
  e.clear();
  return e;
}
const op = (e, v) => e.mqtt(B + "/state/bsh_common_status_operationstate", v);
const out = [];
const take = (e, what) => e.commands().forEach(function (c) {
  out.push({ what: what, topic: c.topic.slice(B.length + 1), data: c.data });
});

let e = boot();
const ctrls = Object.keys(e.defs).map(function (k) { return k.split("/")[1]; });
const options = ctrls.filter(function (c) { return /^opt_/.test(c); });
const programs = ctrls.filter(function (c) { return /^prog_/.test(c); });

// старт: все опции, отложенный старт по часам и по «Завершить к»
e = boot();
options.forEach(function (o) { e.mqtt(B + "/state/" + e.ctx.OPTIONS.filter(function (x) { return x.ctrl === o; })[0].key, "True"); });
e.user("delay_h", 3).press("start");
take(e, "старт: все опции + отложить на 3 ч");
e = boot();
e.user("finish_at", "07:00").press("start");
take(e, "старт: завершить к 07:00");
e = boot({ bsh_common_setting_powerstate: "Off" });
e.press("start").advance(5000);
take(e, "старт при выключенной машине");

// выбор каждой программы и опции до старта; опции во время мойки
programs.forEach(function (p) {
  e = boot({ bsh_common_root_selectedprogram: "None" });
  e.user(p, true);
  take(e, "выбор программы " + p);
});
options.forEach(function (o) {
  e = boot();
  e.user(o, true);
  take(e, "опция до старта " + o);
  e = boot({ bsh_common_status_operationstate: "Run" });
  e.user(o, true);
  take(e, "опция во время мойки " + o);
});

// каждая настройка: все значения enum, края диапазона, вкл/выкл
ctrls.filter(function (c) { return /^set_/.test(c); }).forEach(function (s) {
  const d = e.defs["dishwasher/" + s];
  let values;
  if (d.type === "switch") values = [true, false];
  else if (d.enum) values = Object.keys(d.enum).map(Number);
  else values = [d.min, d.max];
  values.forEach(function (v) {
    e = boot();
    e.user(s, v);
    take(e, "настройка " + s + " = " + v);
  });
});

// питание и отмена
e = boot();
e.user("power", false);
take(e, "питание выкл");
e = boot({ bsh_common_setting_powerstate: "Off" });
e.user("power", true);
take(e, "питание вкл");
e = boot();
op(e, "Run");
e.press("abort");
take(e, "отмена программы");

process.stdout.write(JSON.stringify(out, null, 1) + "\n");
