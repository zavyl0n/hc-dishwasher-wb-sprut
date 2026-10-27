"use strict";
// Эмулятор wb-rules для тестов правила: ровно те функции, которыми пользуется rule/dishwasher.js.
//
// - правило выполняется в отдельном контексте vm, где убраны функции новее ES5
//   (wb-rules работает на Duktape, ES5): случайный .includes() или Object.assign упадёт в тесте;
// - время поддельное: таймеры и Date идут от e.advance(), а не от настоящих часов;
// - запись правила в контрол проверяется по типу контрола (switch — boolean, value — число...);
// - whenChanged срабатывает и от записи самого правила, как в wb-rules.
const fs = require("fs");
const vm = require("vm");

// Встроенные функции новее ES5, которых нет в Duktape (с запасом: убираем и спорные).
const NOT_ES5 = {
  "String.prototype": ["includes", "startsWith", "endsWith", "repeat", "padStart", "padEnd", "trimStart",
    "trimEnd", "trimLeft", "trimRight", "codePointAt", "normalize", "at", "replaceAll", "matchAll"],
  "Array.prototype": ["find", "findIndex", "findLast", "findLastIndex", "fill", "includes", "flat", "flatMap",
    "entries", "keys", "values", "copyWithin", "at", "toSorted", "toReversed", "toSpliced", "with"],
  "Array": ["from", "of"],
  "Object": ["assign", "entries", "values", "fromEntries", "is", "setPrototypeOf", "getOwnPropertyDescriptors",
    "groupBy", "hasOwn"],
  "Number": ["isInteger", "isSafeInteger", "isFinite", "isNaN", "parseFloat", "parseInt", "EPSILON",
    "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER"],
  "Math": ["trunc", "sign", "cbrt", "log2", "log10", "log1p", "expm1", "hypot", "clz32", "fround", "imul"],
  "this": ["Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Reflect", "globalThis", "queueMicrotask",
    "structuredClone", "WeakRef", "FinalizationRegistry", "BigInt"],
};

const STRIP_ES5 = Object.keys(NOT_ES5).map(function (obj) {
  return NOT_ES5[obj].map(function (k) { return "delete " + obj + "[" + JSON.stringify(k) + "];"; }).join("\n");
}).join("\n");

// Date, идущий от поддельных часов; объекты — настоящие Date этого контекста
const FAKE_DATE = "(function (now) {\n" +
  "  var Real = Date;\n" +
  "  function D() {\n" +
  "    if (!(this instanceof D)) return new Real(now()).toString();\n" +
  "    if (arguments.length === 0) return new Real(now());\n" +
  "    var a = [null]; for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);\n" +
  "    return new (Function.prototype.bind.apply(Real, a))();\n" +
  "  }\n" +
  "  D.now = function () { return now(); };\n" +
  "  D.UTC = Real.UTC; D.parse = Real.parse; D.prototype = Real.prototype;\n" +
  "  return D;\n" +
  "})";

function typeOk(cellType, v) {
  if (cellType === "switch" || cellType === "alarm") return typeof v === "boolean";
  if (cellType === "value" || cellType === "range") return typeof v === "number" && !isNaN(v);
  if (cellType === "text") return typeof v === "string";
  return true;
}

// Подменить значения в блоке CFG правила: { tgToken: "x", resetDelayOnStart: false }
function patchCfg(src, cfg) {
  Object.keys(cfg || {}).forEach(function (k) {
    const re = new RegExp("(\\b" + k + ":\\s*)(\"[^\"]*\"|[^,\\n]+?)(\\s*,|\\s*\\n)");
    if (!re.test(src)) throw new Error("в CFG нет поля " + k);
    src = src.replace(re, function (_, a, __, c) { return a + JSON.stringify(cfg[k]) + c; });
  });
  return src;
}

/**
 * Загрузить правило. opts: { cfg: {...}, start: мс от эпохи (по умолчанию 2026-03-10 20:00 МСК) }
 */
function load(rulePath, opts) {
  opts = opts || {};
  let clock = opts.start !== undefined ? opts.start : Date.UTC(2026, 2, 10, 17, 0, 0);
  const timers = [];
  let timerId = 0;
  const cells = {};      // "dishwasher/power" -> значение
  const defs = {};       // описание контролов
  const rules = [];
  const trackers = [];
  const queue = [];
  const e = {
    cells, defs, rules,
    sent: [],            // [topic, payload] — что правило опубликовало в MQTT
    logs: [],            // ["info", "..."]
    telegram: [],        // тексты, ушедшие в Telegram
    errors: [],          // нарушения контракта wb-rules (тип, неизвестный контрол...)
    now: function () { return clock; },
  };

  function setCell(path, v, fromRule) {
    if (!(path in defs)) {
      e.errors.push("запись в несуществующий контрол " + path);
      return;
    }
    if (fromRule && !typeOk(defs[path].type, v)) {
      e.errors.push("в " + path + " (" + defs[path].type + ") записано " + JSON.stringify(v));
    }
    if (cells[path] === v) return;
    cells[path] = v;
    fire(path, v);
  }
  function fire(path, v) {
    rules.forEach(function (r) {
      if (r.paths.indexOf(path) >= 0) {
        const parts = path.split("/");
        queue.push(function () { r.then(v, parts[0], parts[1]); });
      }
    });
  }
  function drain() {
    let n = 0;
    while (queue.length) {
      if (++n > 100000) throw new Error("бесконечный цикл правил");
      queue.shift()();
    }
  }
  function topicRe(p) {
    return new RegExp("^" + p.replace(/[.^$()|[\]\\{}*?]/g, "\\$&").replace(/\+/g, "[^/]+").replace(/#$/, ".*") + "$");
  }
  function addTimer(fn, ms, every) {
    timers.push({ id: ++timerId, at: clock + Math.max(0, ms || 0), fn: fn, every: every });
    return timerId;
  }
  function delTimer(id) {
    const i = timers.findIndex(function (t) { return t.id === id; });
    if (i >= 0) timers.splice(i, 1);
  }

  const log = function () { e.logs.push(["info", [].join.call(arguments, " ")]); };
  ["debug", "info", "warning", "error"].forEach(function (lvl) {
    log[lvl] = function (m) { e.logs.push([lvl, String(m)]); };
  });

  const api = {
    log: log,
    dev: new Proxy({}, {
      get: function (_, k) { return cells[k]; },
      set: function (_, k, v) { setCell(k, v, true); return true; },
    }),
    Notify: {
      sendTelegramMessage: function (token, chat, text) { e.telegram.push(text); },
      sendEmail: function () {}, sendSMS: function () {},
    },
    publish: function (topic, payload) { e.sent.push([topic, String(payload)]); },
    defineVirtualDevice: function (id, d) {
      Object.keys(d.cells).forEach(function (c) {
        const def = d.cells[c];
        defs[id + "/" + c] = def;
        if (def.type !== "pushbutton") cells[id + "/" + c] = def.value;
        if (def.type !== "pushbutton" && !typeOk(def.type, def.value)) {
          e.errors.push("начальное значение " + id + "/" + c + " (" + def.type + ") = " + JSON.stringify(def.value));
        }
      });
    },
    defineRule: function (name, d) {
      if (rules.some(function (r) { return r.name === name; })) e.errors.push("правило " + name + " определено дважды");
      rules.push({ name: name, paths: [].concat(d.whenChanged), then: d.then });
    },
    trackMqtt: function (pattern, cb) { trackers.push({ re: topicRe(pattern), cb: cb }); },
    setTimeout: function (fn, ms) { return addTimer(fn, ms); },
    setInterval: function (fn, ms) { return addTimer(fn, ms, ms); },
    clearTimeout: delTimer,
    clearInterval: delTimer,
  };

  const ctx = vm.createContext(api);
  vm.runInContext(STRIP_ES5, ctx);
  ctx.Date = vm.runInContext(FAKE_DATE, ctx)(function () { return clock; });
  const src = patchCfg(fs.readFileSync(rulePath, "utf8"), opts.cfg);
  vm.runInContext(src, ctx, { filename: rulePath });
  drain();

  // ---- управление из теста ----
  e.ctx = ctx;
  /** сообщение от брокера (hcpy или will брокера) */
  e.mqtt = function (topic, payload, retained) {
    trackers.forEach(function (t) {
      if (t.re.test(topic)) {
        queue.push(function () { t.cb({ topic: topic, value: String(payload), retained: !!retained, qos: 0 }); });
      }
    });
    drain();
    return e;
  };
  /** пользователь меняет контрол в веб-интерфейсе WB или в Sprut.hub */
  e.user = function (ctrl, v) { setCell("dishwasher/" + ctrl, v, false); drain(); return e; };
  /** нажатие кнопки (pushbutton) */
  e.press = function (ctrl) { fire("dishwasher/" + ctrl, true); drain(); return e; };
  /** промотать время на ms миллисекунд, выполняя таймеры по порядку */
  e.advance = function (ms) {
    const end = clock + ms;
    for (;;) {
      timers.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
      const t = timers[0];
      if (!t || t.at > end) break;
      clock = t.at;
      if (t.every) t.at += t.every; else timers.shift();
      t.fn();
      drain();
    }
    clock = end;
    return e;
  };
  e.get = function (ctrl) { return cells["dishwasher/" + ctrl]; };
  e.last = function () { return cells["dishwasher/last_message"]; };
  /** команды, отправленные в hcpy: [{topic: "set"|"activeProgram"|..., data: {...}}] */
  e.commands = function () {
    return e.sent.map(function (s) {
      let data;
      try { data = JSON.parse(s[1]); } catch (err) { data = s[1]; }
      return { topic: s[0], data: data };
    });
  };
  e.clear = function () { e.sent.length = 0; e.telegram.length = 0; return e; };
  return e;
}

module.exports = { load, patchCfg, NOT_ES5 };
