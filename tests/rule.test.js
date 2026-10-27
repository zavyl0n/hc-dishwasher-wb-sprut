"use strict";
// Тесты правила wb-rules в эмуляторе (tests/wbrules.js).
//   node --test tests/
// Время в тестах поддельное: 10.03.2026, 20:00 по Москве.
process.env.TZ = "Europe/Moscow";

const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { load } = require("./wbrules");

const ROOT = path.join(__dirname, "..");
const B = "homeconnect/dishwasher";
const UID = { power: 539, abort: 512, sir: 558, eco: 8196, auto2: 8195, quick65: 8203, fav: 32828,
  extradry: 5121, variospeed: 5127, sound: 4364, silencetime: 4382, infolight: 4378 };

// Что брокер отдаёт правилу при старте wb-rules: машина включена и готова, выбрана Эко 50°
const READY = {
  bsh_common_setting_powerstate: "On",
  bsh_common_status_operationstate: "Ready",
  bsh_common_status_doorstate: "Closed",
  bsh_common_status_remotecontrolstartallowed: "True",
  bsh_common_root_selectedprogram: "Eco50",
  bsh_common_option_remainingprogramtime: "13500",
  dishcare_dishwasher_option_extradry: "False",
  dishcare_dishwasher_option_variospeedplus: "False",
  dishcare_dishwasher_setting_soundlevelsignal: "Low",
  dishcare_dishwasher_setting_infolight: "True",
};

function boot(file, opts) {
  opts = opts || {};
  const e = load(path.join(ROOT, file), opts);
  e.mqtt("homeconnect/LWT", opts.bridge || "online", true);
  e.mqtt(B + "/LWT", opts.device || "online", true);
  const st = Object.assign({}, READY, opts.state || {});
  Object.keys(st).forEach(function (k) { e.mqtt(B + "/state/" + k, st[k], true); });
  e.clear();
  return e;
}
const hc = (e, key, v) => e.mqtt(B + "/state/" + key, v, false);
const op = (e, v) => hc(e, "bsh_common_status_operationstate", v);
const event = (e, key, type, retained) => e.mqtt(B + "/event/" + key, JSON.stringify({ event_type: type }), retained);
const sentTo = (e, topic) => e.commands().filter(c => c.topic === B + "/" + topic).map(c => c.data);
const sets = (e) => sentTo(e, "set");
const starts = (e) => sentTo(e, "activeProgram");
const noErrors = (e) => assert.deepEqual(e.errors, [], "нарушения контракта wb-rules");
const MIN = 60000;

// ---------------------------------------------------------------------------
// Общие тесты: правило из rule/ и готовый пример должны вести себя одинаково
// ---------------------------------------------------------------------------
for (const file of ["rule/dishwasher.js", "examples/SMV4HVX31E/dishwasher.js"]) {
  describe(file, () => {
    describe("загрузка и отображение", () => {
      it("загружается без нарушений контракта wb-rules", () => {
        const e = boot(file);
        noErrors(e);
        assert.equal(e.get("online"), true);
        assert.equal(e.get("state"), "Готова");
        assert.equal(e.get("power"), true);
        assert.equal(e.get("run"), false);
      });

      it("связь: нужна и служба hcpy, и подключение к машине", () => {
        assert.equal(boot(file, { device: "offline" }).get("online"), false);
        assert.equal(boot(file, { bridge: "offline" }).get("online"), false, "hcpy остановлена, у машины устаревший online");
        const e = boot(file);
        e.mqtt("homeconnect/LWT", "offline");
        assert.equal(e.get("online"), false);
        assert.match(e.last(), /служба hcpy не работает/);
        e.mqtt("homeconnect/LWT", "online").mqtt(B + "/LWT", "online");
        assert.equal(e.get("online"), true);
        assert.match(e.last(), /Связь с машиной восстановлена/);
        e.mqtt(B + "/LWT", "offline");
        assert.match(e.last(), /Потеряна связь с машиной$/);
      });

      it("ход программы: состояние, фаза, прогресс, осталось, окончание", () => {
        const e = boot(file);
        op(e, "Run");
        hc(e, "dishcare_dishwasher_status_programphase", "MainWash");
        hc(e, "bsh_common_option_programprogress", "42");
        hc(e, "bsh_common_option_remainingprogramtime", "3600");
        hc(e, "bsh_common_root_activeprogram", "Eco50");
        assert.equal(e.get("state"), "Мойка");
        assert.equal(e.get("running"), true);
        assert.equal(e.get("run"), true);
        assert.equal(e.get("phase"), "Мойка");
        assert.equal(e.get("progress"), 42);
        assert.equal(e.get("remaining"), "1 ч 00 мин");
        assert.equal(e.get("remaining_min"), 60);
        assert.equal(e.get("remaining_sec"), 3600);
        assert.equal(e.get("end_time"), "21:00");
        assert.equal(e.get("active_program"), "Эко 50°");
        noErrors(e);
      });

      it("отложенный старт: «Старт через» и окончание с учётом задержки", () => {
        const e = boot(file);
        hc(e, "bsh_common_option_startinrelative", "7200");
        op(e, "DelayedStart");
        assert.equal(e.get("state"), "Отложенный старт");
        assert.equal(e.get("start_in"), "2 ч 00 мин (в 22:00)");
        assert.equal(e.get("end_time"), "01:45 завтра");
        assert.equal(e.get("remaining_sec"), 7200 + 13500);
      });

      it("«Окончание» до старта: прогноз, если запустить сейчас", () => {
        const e = boot(file);
        e.user("delay_h", 2);
        assert.equal(e.get("end_time"), "≈ 01:45 завтра, если запустить сейчас");
      });

      it("выбранная программа: выключатели работают как радиокнопки", () => {
        const e = boot(file);
        assert.equal(e.get("prog_eco50"), true);
        hc(e, "bsh_common_root_selectedprogram", "Auto2");
        assert.equal(e.get("program"), UID.auto2);
        assert.equal(e.get("prog_auto2"), true);
        assert.equal(e.get("prog_eco50"), false);
        hc(e, "bsh_common_root_selectedprogram", "001");
        assert.equal(e.get("prog_001"), true, "избранное");
        assert.deepEqual(e.sent, [], "эхо от машины не должно порождать команд");
      });

      it("опции и настройки машины читаются в контролы", () => {
        const e = boot(file);
        hc(e, "dishcare_dishwasher_option_extradry", "True");
        hc(e, "dishcare_dishwasher_setting_soundlevelsignal", "High");
        hc(e, "dishcare_dishwasher_setting_silenceondemanddefaulttime", "600");
        hc(e, "dishcare_dishwasher_setting_infolight", "False");
        hc(e, "dishcare_dishwasher_setting_waterhardness", "H00");
        assert.equal(e.get("opt_extradry"), true);
        assert.equal(e.get("set_sound"), 3);
        assert.equal(e.get("set_silencetime"), 10);
        assert.equal(e.get("set_infolight"), false);
        assert.equal(e.get("set_hardness"), 0);
        hc(e, "dishcare_dishwasher_setting_soundlevelsignal", "Unknown");
        assert.equal(e.get("set_sound"), 3, "неизвестное значение не сбрасывает контрол");
        assert.deepEqual(e.sent, []);
        noErrors(e);
      });

      it("события: соль, ополаскиватель, AquaStop, аварии", () => {
        const e = boot(file);
        event(e, "dishcare_dishwasher_event_saltnearlyempty", "Present");
        assert.equal(e.get("salt_low"), true);
        assert.equal(e.get("salt_level"), 10);
        event(e, "dishcare_dishwasher_event_saltlack", "Present");
        assert.equal(e.get("salt_level"), 0);
        event(e, "dishcare_dishwasher_event_rinseaidlack", "Confirmed");
        assert.equal(e.get("rinse_level"), 0, "Confirmed — подтверждено, но всё ещё нет");
        event(e, "bsh_common_event_aquastopoccured", "Present");
        assert.equal(e.get("aquastop"), true);
        assert.equal(e.get("alarm"), true);
        assert.match(e.get("alarm_text"), /AquaStop/);
        event(e, "bsh_common_event_aquastopoccured", "Off");
        assert.equal(e.get("aquastop"), false);
        assert.equal(e.get("alarm"), false);
        assert.equal(e.get("alarm_text"), "Нет");
        noErrors(e);
      });

      it("коды ошибок машины попадают в аварии; битый JSON не ломает правило", () => {
        const e = boot(file);
        hc(e, "bsh_common_status_errorcodeslist", JSON.stringify({ list: ["E:24"] }));
        assert.equal(e.get("alarm"), true);
        assert.equal(e.get("alarm_text"), "Коды ошибок: E:24");
        hc(e, "bsh_common_status_errorcodeslist", "{not json");
        assert.equal(e.get("alarm"), false);
        assert.equal(e.logs.filter(l => l[0] === "error").length, 0);
      });

      it("повторы и эхо от машины никогда не порождают команд", () => {
        const e = boot(file);
        op(e, "DelayedStart"); op(e, "Run"); op(e, "Pause"); op(e, "Run");
        hc(e, "bsh_common_root_selectedprogram", "Quick65");
        hc(e, "dishcare_dishwasher_option_variospeedplus", "True");
        hc(e, "dishcare_dishwasher_setting_soundlevelsignal", "Off");
        hc(e, "bsh_common_setting_powerstate", "Off");
        hc(e, "bsh_common_setting_powerstate", "On");
        op(e, "Finished"); op(e, "Ready");
        e.advance(20 * MIN);
        assert.deepEqual(e.sent, []);
        noErrors(e);
      });
    });

    describe("команды", () => {
      it("«Старт»: activeProgram с выбранной программой и включёнными опциями", () => {
        const e = boot(file);
        hc(e, "dishcare_dishwasher_option_extradry", "True");
        e.press("start");
        assert.deepEqual(starts(e), [{ program: UID.eco, options: [{ uid: UID.extradry, value: true }] }]);
        assert.match(e.last(), /Команда старта: Эко 50°$/);
      });

      it("плитка «Мойка» (run): включение — старт, выключение во время мойки — отмена", () => {
        const e = boot(file);
        e.user("run", true);
        assert.deepEqual(starts(e), [{ program: UID.eco }]);
        op(e, "Run");
        e.clear();
        e.user("run", false);
        assert.deepEqual(sets(e), [{ uid: UID.abort, value: true }]);
      });

      it("машина выключена: сначала питание, через 5 с — старт", () => {
        const e = boot(file, { state: { bsh_common_setting_powerstate: "Off" } });
        e.press("start");
        assert.deepEqual(sets(e), [{ uid: UID.power, value: "On" }]);
        assert.deepEqual(starts(e), []);
        e.advance(5000);
        assert.deepEqual(starts(e), [{ program: UID.eco }]);
      });

      it("после включения питания старт отменяется, если удалённый старт не разрешён", () => {
        const e = boot(file, { state: { bsh_common_setting_powerstate: "Off", bsh_common_status_remotecontrolstartallowed: "False" } });
        e.press("start");
        e.advance(5000);
        assert.deepEqual(starts(e), []);
        assert.match(e.last(), /удалённый старт не разрешён/);
      });

      for (const [why, opts, re] of [
        ["дверь открыта", { state: { bsh_common_status_doorstate: "Open" } }, /дверь открыта/],
        ["удалённый старт не разрешён", { state: { bsh_common_status_remotecontrolstartallowed: "False" } }, /удалённый старт не разрешён/],
        ["нет связи", { device: "offline" }, /нет связи/],
        ["программа уже идёт", { state: { bsh_common_status_operationstate: "Run" } }, /уже запущена/],
      ]) {
        it("старт не отправляется: " + why, () => {
          const e = boot(file, opts);
          e.press("start");
          assert.deepEqual(starts(e), []);
          assert.match(e.last(), re);
          if (e.get("running")) return;
          e.user("run", true);                  // плитка «Мойка» в Sprut.hub
          assert.deepEqual(starts(e), []);
          assert.equal(e.get("run"), false, "плитка сразу возвращается");
        });
      }

      it("«Отменить программу»: AbortProgram только когда программа идёт", () => {
        const e = boot(file);
        e.press("abort");
        assert.deepEqual(sets(e), []);
        assert.match(e.last(), /Нечего отменять/);
        op(e, "DelayedStart");
        e.press("abort");
        assert.deepEqual(sets(e), [{ uid: UID.abort, value: true }]);
      });

      it("выбор программы → selectedProgram; во время мойки — отказ и возврат", () => {
        const e = boot(file);
        e.user("prog_quick65", true);
        assert.deepEqual(sentTo(e, "selectedProgram"), [{ program: UID.quick65 }]);
        e.user("prog_eco50", false);
        assert.equal(e.get("prog_eco50"), true, "выключить выбранную программу нельзя");
        op(e, "Run");
        e.clear();
        e.user("program", UID.auto2);
        assert.deepEqual(e.sent, []);
        assert.equal(e.get("program"), UID.eco);
        assert.match(e.last(), /нельзя сменить во время мойки/);
      });

      it("опция до старта → selectedProgram с опцией; во время мойки → set", () => {
        const e = boot(file);
        e.user("opt_variospeed", true);
        assert.deepEqual(sentTo(e, "selectedProgram"), [{ program: UID.eco, options: [{ uid: UID.variospeed, value: true }] }]);
        op(e, "Run");
        e.clear();
        e.user("opt_extradry", true);
        assert.deepEqual(sets(e), [{ uid: UID.extradry, value: true }]);
      });

      it("настройки: значение уходит в формате машины", () => {
        const e = boot(file);
        e.user("set_sound", 3);
        e.user("set_silencetime", 10);
        e.user("set_infolight", false);
        assert.deepEqual(sets(e), [
          { uid: UID.sound, value: 3 },
          { uid: UID.silencetime, value: 600 },
          { uid: UID.infolight, value: false },
        ]);
        e.clear();
        e.user("set_silencetime", 99);
        assert.deepEqual(sets(e), [{ uid: UID.silencetime, value: 1800 }], "ограничение по max из devices.json");
      });

      it("питание: выключение в Ready уходит, во время программы — нет", () => {
        const e = boot(file);
        e.user("power", false);
        assert.deepEqual(sets(e), [{ uid: UID.power, value: "Off" }]);
        for (const st of ["Run", "Pause", "DelayedStart", "ActionRequired"]) {
          const b = boot(file, { state: { bsh_common_status_operationstate: st } });
          b.user("power", false);
          assert.deepEqual(sets(b), [], st);
          assert.equal(b.get("power"), true, st);
          assert.match(b.last(), /Выключение отменено/, st);
        }
      });

      it("машина не приняла команду — контрол возвращается через 15 с; приняла — остаётся", () => {
        const e = boot(file);
        e.user("set_sound", 3);
        e.advance(15000);
        assert.equal(e.get("set_sound"), 1);
        assert.ok(e.logs.some(l => l[0] === "warning" && /не применила set_sound/.test(l[1])));
        e.user("set_sound", 2);
        hc(e, "dishcare_dishwasher_setting_soundlevelsignal", "Medium");
        e.advance(15000);
        assert.equal(e.get("set_sound"), 2);
      });
    });

    describe("отложенный старт", () => {
      it("«Отложить старт, ч» → StartInRelative в секундах", () => {
        const e = boot(file);
        e.user("delay_h", 3);
        e.press("start");
        assert.deepEqual(starts(e), [{ program: UID.eco, options: [{ uid: UID.sir, value: 10800 }] }]);
        assert.match(e.last(), /отложенный на 3 ч 00 мин/);
      });

      it("«Завершить к 07:00»: задержка = до 07:00 минус длительность программы", () => {
        const e = boot(file);
        e.user("finish_at", "07:00");
        e.press("start");
        // 20:00 → 07:00 = 11 ч = 39600 с; Эко 50° — 13500 с
        assert.deepEqual(starts(e), [{ program: UID.eco, options: [{ uid: UID.sir, value: 39600 - 13500 }] }]);
      });

      it("«Завершить к» берёт длительность, которую сообщила машина, и формат 7.30", () => {
        const e = boot(file);
        hc(e, "bsh_common_option_remainingprogramtime", "9000");   // например, с VarioSpeed
        e.user("finish_at", "7.30");
        e.press("start");
        assert.deepEqual(starts(e)[0].options, [{ uid: UID.sir, value: 41400 - 9000 }]);
      });

      it("задержка округляется вниз до шага (60 с)", () => {
        const e = boot(file, { start: Date.UTC(2026, 2, 10, 17, 0, 25) });  // 20:00:25
        e.user("finish_at", "07:00");
        e.press("start");
        assert.equal(starts(e)[0].options[0].value, 26040);
      });

      it("неверное время — старт не уходит, понятное сообщение", () => {
        const e = boot(file);
        e.user("finish_at", "25:00");
        e.press("start");
        assert.deepEqual(starts(e), []);
        assert.match(e.last(), /Неверное время «Завершить к»: «25:00»/);
      });

      it("не успевает к сроку — старт сразу и предупреждение", () => {
        const e = boot(file);
        e.user("finish_at", "21:00");
        e.press("start");
        assert.deepEqual(starts(e), [{ program: UID.eco }]);
        assert.match(e.last(), /к 21:00 не успеет, окончание ≈ 23:45$/);
      });

      it("успевает с запасом меньше шага — без ложного предупреждения", () => {
        const e = boot(file);
        e.user("finish_at", "23:46");          // 20:00 + 3:45 = 23:45, запас 1 мин
        e.press("start");
        assert.deepEqual(starts(e)[0].options, [{ uid: UID.sir, value: 60 }]);
        assert.doesNotMatch(e.last(), /не успеет/);
      });

      it("поля сбрасываются, когда машина начала программу; если не начала — остаются", () => {
        const e = boot(file);
        e.user("delay_h", 3).user("finish_at", "07:00");
        e.press("start");
        e.advance(15000);
        assert.equal(e.get("delay_h"), 3);
        assert.equal(e.get("finish_at"), "07:00");
        op(e, "DelayedStart");
        assert.equal(e.get("delay_h"), 0);
        assert.equal(e.get("finish_at"), "");
        op(e, "Run"); op(e, "Finished"); op(e, "Ready");
        e.clear();
        e.user("run", true);
        assert.deepEqual(starts(e), [{ program: UID.eco }], "следующий старт — сразу");
      });

      it("пауза → продолжение не трогает поля", () => {
        const e = boot(file, { state: { bsh_common_status_operationstate: "Run" } });
        e.user("delay_h", 2);
        op(e, "Pause"); op(e, "Run");
        assert.equal(e.get("delay_h"), 2);
      });

      it("resetDelayOnStart: false — поля сохраняются", () => {
        const e = boot(file, { cfg: { resetDelayOnStart: false } });
        e.user("finish_at", "07:00");
        e.press("start");
        op(e, "DelayedStart");
        assert.equal(e.get("finish_at"), "07:00");
      });

      it("«Завершить к» через ночь перехода на летнее время", { todo: "известная ошибка: +24 ч вместо «завтра в ЧЧ:ММ» — окончание на час позже" }, () => {
        const prev = process.env.TZ;
        process.env.TZ = "Europe/Berlin";      // 29.03.2026 02:00 → 03:00
        try {
          const e = boot(file, { start: Date.UTC(2026, 2, 28, 21, 0, 0) });  // 28.03, 22:00 CET
          e.user("finish_at", "07:00");
          e.press("start");
          // до 29.03 07:00 CEST — 8 ч (28800 с), минус 13500 с программы
          assert.equal(starts(e)[0].options[0].value, 28800 - 13500);
        } finally {
          process.env.TZ = prev;
        }
      });
    });

    describe("уведомления", () => {
      const TG = { cfg: { tgToken: "123:TEST", tgChatId: "42" } };

      it("старт и окончание мойки; напоминание «не выгружена» через час", () => {
        const e = boot(file, TG);
        op(e, "Run");
        e.advance(3000);
        assert.match(e.telegram[0], /^Посудомойка: ▶ Мойка началась: Эко 50°, окончание ≈ 23:45$/);
        op(e, "Finished");
        assert.equal(e.get("finished"), true);
        assert.match(e.get("finished_at"), /^10\.03 20:00 \(Эко 50°\)$/);
        assert.match(e.telegram[1], /Мойка завершена: Эко 50°\. Можно разгружать/);
        e.advance(60 * MIN);
        assert.match(e.telegram[2], /Посуда чистая, но ещё не выгружена/);
        assert.equal(e.telegram.length, 3);
      });

      it("открыли дверь после мойки — напоминания нет, «завершена» сбрасывается", () => {
        const e = boot(file, TG);
        op(e, "Run"); op(e, "Finished");
        hc(e, "bsh_common_status_doorstate", "Open");
        assert.equal(e.get("finished"), false);
        e.advance(120 * MIN);
        assert.ok(!e.telegram.some(t => /не выгружена/.test(t)));
      });

      it("notifyStart: false — о старте только в «Последнем событии»", () => {
        const e = boot(file, { cfg: { tgToken: "123:TEST", tgChatId: "42", notifyStart: false } });
        op(e, "Run");
        e.advance(3000);
        assert.deepEqual(e.telegram, []);
        assert.match(e.last(), /Мойка началась/);
      });

      it("отложенный старт: время начала и окончания", () => {
        const e = boot(file, TG);
        hc(e, "bsh_common_option_startinrelative", "7200");
        op(e, "DelayedStart");
        e.advance(3000);
        assert.match(e.telegram[0], /Отложенный старт: Эко 50°, начнётся в 22:00, окончание ≈ 01:45 завтра/);
      });

      it("событие Present → одно уведомление; retained при старте и повтор — без уведомления", () => {
        const e = load(path.join(ROOT, file), TG);
        e.mqtt(B + "/LWT", "online", true);
        event(e, "dishcare_dishwasher_event_saltlack", "Present", true);   // было до перезапуска wb-rules
        event(e, "bsh_common_event_aquastopoccured", "Off", true);
        assert.deepEqual(e.telegram, []);
        assert.equal(e.get("salt_empty"), true);
        event(e, "bsh_common_event_aquastopoccured", "Present");
        event(e, "bsh_common_event_aquastopoccured", "Present");
        assert.equal(e.telegram.length, 1);
        assert.match(e.telegram[0], /AquaStop/);
      });

      it("ActionRequired и Error уходят в Telegram", () => {
        const e = boot(file, TG);
        op(e, "Run"); op(e, "ActionRequired"); op(e, "Error");
        assert.ok(e.telegram.some(t => /требует действия/.test(t)));
        assert.ok(e.telegram.some(t => /Ошибка посудомоечной машины/.test(t)));
      });

      it("без токена Telegram ничего не отправляется", () => {
        const e = boot(file);
        op(e, "Run"); op(e, "Finished");
        e.advance(120 * MIN);
        assert.deepEqual(e.telegram, []);
        assert.match(e.last(), /не выгружена/);
      });

      it("значения после перезапуска wb-rules не порождают уведомлений", () => {
        const e = boot(file, Object.assign({ state: { bsh_common_status_operationstate: "Finished" } }, TG));
        e.advance(120 * MIN);
        assert.deepEqual(e.telegram, []);
      });
    });

    describe("мелочи (известные)", () => {
      it("начальные значения контролов в пределах min/max", { todo: "«длительность тихого режима» стартует с 0 при min 1" }, () => {
        const e = boot(file);
        const bad = Object.keys(e.defs).filter(k => {
          const d = e.defs[k];
          return d.type === "range" && (d.value < d.min || d.value > d.max);
        });
        assert.deepEqual(bad, []);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Правило, сгенерированное для другой модели: нет отложенного старта и отмены
// ---------------------------------------------------------------------------
describe("сгенерированное правило: модель без отложенного старта и отмены", () => {
  const py = spawnSync(process.platform === "win32" ? "python" : "python3", ["--version"]);
  const skip = py.status !== 0 && "нужен python3";
  let file, dir;
  if (!skip) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hc-kit-"));
    after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const devs = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "other_model.json"), "utf8"));
    devs[1].name = "dishwasher";             // в фикстуре кириллица — для теста генератора
    fs.writeFileSync(path.join(dir, "in.json"), JSON.stringify(devs));
    const r = spawnSync("python3", [path.join(ROOT, "tools", "make_kit.py"), path.join(dir, "in.json"), "--out", dir]);
    assert.equal(r.status, 0, String(r.stderr));
    file = path.relative(ROOT, path.join(dir, "dishwasher.js"));
  }

  it("загружается, программы и настройки этой модели", { skip }, () => {
    const e = boot(file, { state: { bsh_common_root_selectedprogram: "LearningDishwasher" } });
    noErrors(e);
    assert.equal(e.get("prog_learningdishwasher"), true);
    assert.equal(e.defs["dishwasher/prog_002"].title, "Программа: Избранное 2");
    assert.equal("dishwasher/set_infolight" in e.defs, false, "настройка только для чтения не показывается");
    e.user("set_silencetime", 12);
    assert.deepEqual(sets(e), [{ uid: UID.silencetime, value: 12 }], "без пересчёта в минуты");
  });

  it("отложенный старт и отмена — понятный отказ без команд", { skip }, () => {
    const e = boot(file);
    e.user("delay_h", 2);
    e.press("start");
    assert.deepEqual(starts(e), []);
    assert.match(e.last(), /Отложенный старт не поддерживается/);
    e.user("delay_h", 0);
    e.press("start");
    assert.deepEqual(starts(e), [{ program: UID.eco }]);
    op(e, "Run");
    e.clear();
    e.press("abort");
    assert.deepEqual(sets(e), []);
    assert.match(e.last(), /Отмена программы не поддерживается/);
  });
});

// ---------------------------------------------------------------------------
// Синтаксис ES5 (wb-rules работает на Duktape)
// ---------------------------------------------------------------------------
describe("синтаксис ES5", () => {
  let acorn = null;
  try { acorn = require("acorn"); } catch (err) { /* необязательная зависимость */ }
  for (const file of ["rule/dishwasher.js", "examples/SMV4HVX31E/dishwasher.js"]) {
    it(file, { skip: !acorn && "нет пакета acorn (npm install)" }, () => {
      acorn.parse(fs.readFileSync(path.join(ROOT, file), "utf8"), { ecmaVersion: 5 });
    });
  }
});
