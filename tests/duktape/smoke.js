// Сценарий для правила в Duktape (см. tests/duktape/harness.js). Чистый ES5.
// Падает с исключением на первой ошибке, в конце печатает «DUKTAPE OK: N проверок».
(function (w) {
  var B = "homeconnect/dishwasher", n = 0;
  var MIN = 60000;

  function eq(actual, expected, what) {
    n++;
    var a = JSON.stringify(actual), b = JSON.stringify(expected);
    if (a !== b) throw new Error("FAIL " + what + ": " + a + " !== " + b);
  }
  function ok(cond, what) {
    n++;
    if (!cond) throw new Error("FAIL " + what);
  }
  function hc(key, v) { w.mqtt(B + "/state/" + key, v, false); }
  function op(v) { hc("bsh_common_status_operationstate", v); }

  // как после перезапуска wb-rules: retained от брокера
  w.mqtt("homeconnect/LWT", "online", true);
  w.mqtt(B + "/LWT", "online", true);
  var READY = {
    bsh_common_setting_powerstate: "On",
    bsh_common_status_operationstate: "Ready",
    bsh_common_status_doorstate: "Closed",
    bsh_common_status_remotecontrolstartallowed: "True",
    bsh_common_root_selectedprogram: "Eco50",
    bsh_common_option_remainingprogramtime: "13500",
    dishcare_dishwasher_setting_soundlevelsignal: "Low"
  };
  for (var k in READY) if (READY.hasOwnProperty(k)) w.mqtt(B + "/state/" + k, READY[k], true);
  w.clear();

  eq(w.errors, [], "контракт wb-rules при загрузке");
  eq(w.get("online"), true, "связь");
  eq(w.get("state"), "Готова", "состояние");
  eq(w.get("prog_eco50"), true, "выбранная программа");

  // старт с «Завершить к 07:00»: 11 ч до срока минус 3 ч 45 мин программы
  w.user("finish_at", "07:00");
  w.press("start");
  eq(w.commands("activeProgram"), [{ program: 8196, options: [{ uid: 558, value: 26100 }] }], "старт с задержкой");
  hc("bsh_common_option_startinrelative", "26100");
  op("DelayedStart");
  eq(w.get("finish_at"), "", "«Завершить к» сброшено после старта");
  eq(w.get("start_in"), "7 ч 15 мин (в 03:15 завтра)", "«Старт через»");

  // мойка: уведомление, окончание, «не выгружена»
  op("Run");
  w.advance(3000);
  ok(/Мойка началась: Эко 50°/.test(w.last()), "уведомление о старте: " + w.last());
  hc("bsh_common_option_remainingprogramtime", "3600");
  eq(w.get("end_time"), "21:00", "окончание");
  eq(w.get("remaining"), "1 ч 00 мин", "осталось");
  op("Finished");
  eq(w.get("finished"), true, "мойка завершена");
  w.advance(60 * MIN);
  ok(/не выгружена/.test(w.last()), "напоминание: " + w.last());

  // события и аварии
  w.mqtt(B + "/event/bsh_common_event_aquastopoccured", JSON.stringify({ event_type: "Present" }), false);
  eq(w.get("aquastop"), true, "AquaStop");
  ok(/AquaStop/.test(w.get("alarm_text")), "текст аварии");

  // настройка: команда, затем возврат, если машина не приняла
  w.clear();
  w.user("set_sound", 3);
  eq(w.commands("set"), [{ uid: 4364, value: 3 }], "команда настройки");
  w.advance(15000);
  eq(w.get("set_sound"), 1, "возврат через 15 с");

  // служба hcpy остановилась
  w.mqtt("homeconnect/LWT", "offline", false);
  eq(w.get("online"), false, "связь при остановке hcpy");

  eq(w.errors, [], "контракт wb-rules в конце");
  print("DUKTAPE OK: " + n + " проверок");
})(__wb);
