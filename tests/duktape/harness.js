// Мини-эмулятор wb-rules на чистом ES5 — чтобы запустить правило в настоящем Duktape,
// на котором работает wb-rules:
//   TZ=Europe/Moscow duk tests/duktape/harness.js examples/SMV4HVX31E/dishwasher.js tests/duktape/smoke.js
// Тот же код без Duktape гоняет tests/duktape.test.js (Node, контекст без функций новее ES5).
// Подробный эмулятор для обычных тестов — tests/wbrules.js.
var __wb = (function (global) {
  var clock = Date.UTC(2026, 2, 10, 17, 0, 0);   // 10.03.2026 20:00 МСК
  var RealDate = Date;
  var timers = [], timerId = 0, cells = {}, defs = {}, rules = [], trackers = [], queue = [];
  var w = { sent: [], telegram: [], errors: [], logs: [] };

  function D() {
    if (!(this instanceof D)) return new RealDate(clock).toString();
    if (arguments.length === 0) return new RealDate(clock);
    var a = [null];
    for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
    return new (Function.prototype.bind.apply(RealDate, a))();
  }
  D.now = function () { return clock; };
  D.UTC = RealDate.UTC;
  D.parse = RealDate.parse;
  D.prototype = RealDate.prototype;

  function typeOk(t, v) {
    if (t === "switch" || t === "alarm") return typeof v === "boolean";
    if (t === "value" || t === "range") return typeof v === "number" && !isNaN(v);
    if (t === "text") return typeof v === "string";
    return true;
  }
  function fire(path, v) {
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].paths.indexOf(path) >= 0) {
        (function (r) { queue.push(function () { r.then(v); }); })(rules[i]);
      }
    }
  }
  function setCell(path, v, fromRule) {
    if (!defs.hasOwnProperty(path)) { w.errors.push("нет контрола " + path); return; }
    if (fromRule && !typeOk(defs[path].type, v)) w.errors.push(path + " (" + defs[path].type + ") = " + JSON.stringify(v));
    if (cells[path] === v) return;
    cells[path] = v;
    fire(path, v);
  }
  function drain() {
    var n = 0;
    while (queue.length) {
      if (++n > 100000) throw new Error("бесконечный цикл правил");
      queue.shift()();
    }
  }
  function matches(pattern, topic) {
    var p = pattern.split("/"), t = topic.split("/");
    for (var i = 0; i < p.length; i++) {
      if (p[i] === "#") return true;
      if (i >= t.length || (p[i] !== "+" && p[i] !== t[i])) return false;
    }
    return p.length === t.length;
  }
  function addTimer(fn, ms, every) {
    timers.push({ id: ++timerId, at: clock + Math.max(0, ms || 0), fn: fn, every: every });
    return timerId;
  }
  function delTimer(id) {
    for (var i = 0; i < timers.length; i++) if (timers[i].id === id) { timers.splice(i, 1); return; }
  }

  var log = function (m) { w.logs.push("info " + m); };
  log.debug = log.info = function (m) { w.logs.push("info " + m); };
  log.warning = function (m) { w.logs.push("warning " + m); };
  log.error = function (m) { w.logs.push("error " + m); };

  global.Date = D;
  global.log = log;
  global.dev = new Proxy({}, {
    get: function (t, k) { return cells[k]; },
    set: function (t, k, v) { setCell(k, v, true); return true; }
  });
  global.Notify = { sendTelegramMessage: function (a, b, text) { w.telegram.push(text); } };
  global.publish = function (topic, payload) { w.sent.push([topic, String(payload)]); };
  global.defineVirtualDevice = function (id, d) {
    for (var c in d.cells) {
      if (!d.cells.hasOwnProperty(c)) continue;
      defs[id + "/" + c] = d.cells[c];
      if (d.cells[c].type !== "pushbutton") cells[id + "/" + c] = d.cells[c].value;
    }
  };
  global.defineRule = function (name, d) {
    rules.push({ name: name, paths: [].concat(d.whenChanged), then: d.then });
  };
  global.trackMqtt = function (pattern, cb) { trackers.push({ pattern: pattern, cb: cb }); };
  global.setTimeout = function (fn, ms) { return addTimer(fn, ms); };
  global.setInterval = function (fn, ms) { return addTimer(fn, ms, ms); };
  global.clearTimeout = global.clearInterval = delTimer;

  w.mqtt = function (topic, payload, retained) {
    for (var i = 0; i < trackers.length; i++) {
      if (matches(trackers[i].pattern, topic)) {
        (function (cb) {
          queue.push(function () { cb({ topic: topic, value: String(payload), retained: !!retained, qos: 0 }); });
        })(trackers[i].cb);
      }
    }
    drain();
  };
  w.user = function (ctrl, v) { setCell("dishwasher/" + ctrl, v, false); drain(); };
  w.press = function (ctrl) { fire("dishwasher/" + ctrl, true); drain(); };
  w.advance = function (ms) {
    var end = clock + ms;
    for (;;) {
      timers.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
      var t = timers[0];
      if (!t || t.at > end) break;
      clock = t.at;
      if (t.every) t.at += t.every; else timers.shift();
      t.fn();
      drain();
    }
    clock = end;
  };
  w.get = function (ctrl) { return cells["dishwasher/" + ctrl]; };
  w.last = function () { return cells["dishwasher/last_message"]; };
  /** данные команд в топик homeconnect/dishwasher/<topic> */
  w.commands = function (topic) {
    var out = [];
    for (var i = 0; i < w.sent.length; i++) {
      if (w.sent[i][0] === "homeconnect/dishwasher/" + topic) out.push(JSON.parse(w.sent[i][1]));
    }
    return out;
  };
  w.clear = function () { w.sent.length = 0; w.telegram.length = 0; };
  w.drain = drain;
  return w;
})(this);
