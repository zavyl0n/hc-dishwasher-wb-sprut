"use strict";
// Проверка ES5-сценария для Duktape (tests/duktape/) без самого Duktape:
// синтаксис ES5 (acorn) и прогон в контексте Node без функций новее ES5.
// В CI тот же сценарий запускается в настоящем Duktape (.github/workflows/tests.yml).
process.env.TZ = "Europe/Moscow";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { STRIP_ES5 } = require("./wbrules");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const HARNESS = "tests/duktape/harness.js";
const SMOKE = "tests/duktape/smoke.js";

let acorn = null;
try { acorn = require("acorn"); } catch (err) { /* необязательная зависимость */ }

describe("сценарий Duktape", () => {
  for (const f of [HARNESS, SMOKE]) {
    it("ES5: " + f, { skip: !acorn && "нет пакета acorn (npm install)" }, () => {
      acorn.parse(read(f), { ecmaVersion: 5 });
    });
  }

  for (const rule of ["rule/dishwasher.js", "examples/SMV4HVX31E/dishwasher.js"]) {
    it("проходит в ES5-контексте: " + rule, () => {
      const out = [];
      const ctx = vm.createContext({ print: (s) => out.push(String(s)) });
      vm.runInContext(STRIP_ES5, ctx);
      for (const f of [HARNESS, rule, SMOKE]) vm.runInContext(read(f), ctx, { filename: f });
      assert.match(out.join("\n"), /^DUKTAPE OK: \d+ проверок$/);
    });
  }
});
