// Экран: связывает DeviceStore с разметкой index.html.
// Списки (программы, опции, настройки) строятся один раз по составу контролов и дальше только
// обновляются: кнопки не пересоздаются на каждое сообщение MQTT.

import { icon } from "./icons.js";
import { derive, splitTitle, settingHint, optionHint, parseNote, PHASES } from "./model.js";

// Очистка текстового контрола: правило обрезает пробелы, а пустую команду MQTT контроллер
// может не принять — пробел работает в обоих случаях.
const CLEAR_TEXT = " ";
const DEVICE_WAIT_MS = 4000;      // сколько ждать контролы после подключения
const NOTE_SHOW_MS = 15000;       // сколько держать на виду ответ правила на действие

const $ = (id) => document.getElementById(id);

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  Object.keys(attrs || {}).forEach((k) => {
    const v = attrs[k];
    if (v === false || v === undefined || v === null) return;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.indexOf("on") === 0) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  });
  (children || []).forEach((c) => { if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return node;
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
function setAttr(node, name, value) { if (node.getAttribute(name) !== String(value)) node.setAttribute(name, value); }
function setHidden(node, hidden) { if (node.hidden !== hidden) node.hidden = hidden; }
function setIcon(node, name, size) {
  if (node.dataset.icon === name) return;
  node.dataset.icon = name;
  node.replaceChildren();
  if (name) node.appendChild(icon(name, size));
}

function makeSwitch(label, onToggle) {
  const b = el("button", { type: "button", class: "switch", role: "switch", "aria-checked": "false", "aria-label": label },
    [el("span", { class: "switch__thumb" })]);
  b.addEventListener("click", () => { if (!b.disabled) onToggle(b.getAttribute("aria-checked") !== "true"); });
  return b;
}
function updateSwitch(b, on, disabled, busy) {
  setAttr(b, "aria-checked", on ? "true" : "false");
  b.disabled = !!disabled;
  b.classList.toggle("is-busy", !!busy);
}

export function mountUI(opts) {
  const store = opts.store;
  const demo = !!opts.demo;
  const sim = opts.sim || null;
  const app = $("app");

  let view = "wash";
  let deviceWaitOver = false;
  let deviceWaitTimer = null;
  let builtStructure = -1;
  let frame = 0;
  let noteTimer = null;
  const refs = { programs: [], options: [], settings: [], demo: [] };

  // ---------------- тема ----------------
  const themeBtn = $("theme");
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let theme = media.matches ? "dark" : "light";
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", theme);
    setIcon(themeBtn, theme === "dark" ? "sun" : "moon", 20);
    themeBtn.setAttribute("aria-label", theme === "dark" ? "Включить светлую тему" : "Включить тёмную тему");
  }
  themeBtn.addEventListener("click", () => { theme = theme === "dark" ? "light" : "dark"; applyTheme(); });
  media.addEventListener("change", (e) => { theme = e.matches ? "dark" : "light"; applyTheme(); });
  applyTheme();

  // ---------------- вкладки ----------------
  const tabs = Array.prototype.slice.call(document.querySelectorAll(".tab"));
  function showView(name) {
    view = name;
    tabs.forEach((t) => {
      if (t.dataset.view === name) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    render();
    window.scrollTo(0, 0);
  }
  tabs.forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));

  // ---------------- подтверждение ----------------
  const dialog = $("confirm");
  function confirmAction(title, text, okLabel, cancelLabel) {
    return new Promise((resolve) => {
      setText($("confirm-title"), title);
      setText($("confirm-text"), text);
      setText($("confirm-ok"), okLabel);
      setText($("confirm-cancel"), cancelLabel || "Не надо");
      dialog.returnValue = "cancel";
      dialog.addEventListener("close", function done() {
        dialog.removeEventListener("close", done);
        resolve(dialog.returnValue === "ok");
      });
      dialog.showModal();
    });
  }
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close("cancel"); });

  // ---------------- главное действие и питание ----------------
  const actBtn = $("act-btn");
  let lastView = null;
  actBtn.addEventListener("click", async () => {
    const v = lastView;
    if (!v || v.action.disabled) return;
    if (v.action.kind === "start") { store.set("run", true); return; }
    if (v.action.kind === "cancel") { store.set("run", false); return; }
    const delayed = v.mode === "delayed";
    const ok = await confirmAction(
      delayed ? "Отменить отложенный старт?" : "Отменить программу?",
      delayed ? "Машина не начнёт мойку в назначенное время."
        : "Машина сольёт воду и остановится. Посуда может остаться грязной.",
      delayed ? "Отменить старт" : "Отменить программу",
      delayed ? "Оставить" : "Пусть моет");
    if (ok) store.set("run", false);
  });

  const powerBtn = $("power");
  powerBtn.addEventListener("click", () => {
    if (powerBtn.disabled) return;
    store.set("power", powerBtn.getAttribute("aria-checked") !== "true");
  });

  // ---------------- когда запускать ----------------
  const modeBtns = Array.prototype.slice.call($("schedule-mode").querySelectorAll("button"));
  const finishInput = $("finish-time");
  setIcon($("delay-minus"), "minus", 18);
  setIcon($("delay-plus"), "plus", 18);
  let lastFinish = "07:00";

  function setSchedule(mode) {
    const v = lastView;
    if (!v) return;
    if (mode === "now") {
      if (v.finishAt) store.set("finish_at", CLEAR_TEXT);
      if (v.delayH !== 0) store.set("delay_h", 0);
    } else if (mode === "delay") {
      if (v.finishAt) store.set("finish_at", CLEAR_TEXT);
      if (v.delayH === 0) store.set("delay_h", 1);
    } else {
      store.set("finish_at", lastFinish);
    }
  }
  modeBtns.forEach((b) => b.addEventListener("click", () => { if (!b.disabled) setSchedule(b.dataset.mode); }));
  $("delay-minus").addEventListener("click", () => {
    if (lastView && lastView.delayH > 1) store.set("delay_h", lastView.delayH - 1);
  });
  $("delay-plus").addEventListener("click", () => {
    if (lastView && lastView.delayH < lastView.delayMax) store.set("delay_h", lastView.delayH + 1);
  });
  finishInput.addEventListener("change", () => {
    if (!/^\d{2}:\d{2}$/.test(finishInput.value)) return;
    lastFinish = finishInput.value;
    store.set("finish_at", finishInput.value);
  });

  // ---------------- построение списков ----------------
  function buildPrograms(v) {
    const box = $("programs");
    box.replaceChildren();
    refs.programs = v.programs.map((p) => {
      const mark = el("span", { class: "program__mark" });
      mark.appendChild(icon("check", 14));
      const iconBox = el("span", { class: "program__icon" });
      iconBox.appendChild(icon(p.hint.icon, 22));
      const b = el("button", { type: "button", class: "program", role: "radio", "aria-checked": "false" }, [
        iconBox,
        el("span", { class: "program__text" }, [
          el("span", { class: "program__title", text: p.title }),
          p.hint.text ? el("span", { class: "program__hint", text: p.hint.text }) : null
        ]),
        mark
      ]);
      b.addEventListener("click", () => {
        if (b.disabled || b.getAttribute("aria-checked") === "true") return;
        if (p.ctrl) store.set(p.ctrl, true);
        else store.set("program", p.uid);
      });
      box.appendChild(b);
      return { uid: p.uid, node: b };
    });
  }

  function buildOptions() {
    const box = $("options");
    box.replaceChildren();
    refs.options = store.list("opt_").map((id) => {
      const t = splitTitle(store.title(id));
      const hint = optionHint(id) || (t.note ? t.note.charAt(0).toUpperCase() + t.note.slice(1) : "");
      const sw = makeSwitch(t.name, (on) => store.set(id, on));
      box.appendChild(el("li", { class: "row" }, [
        el("div", { class: "row__text" }, [
          el("span", { class: "row__title", text: t.name }),
          hint ? el("span", { class: "row__hint", text: hint }) : null
        ]),
        sw
      ]));
      return { id, sw };
    });
    setHidden($("options-card"), refs.options.length === 0);
  }

  async function changeSetting(id, value, key) {
    if (id === "set_remotelevel" && key === "Monitoring") {
      const ok = await confirmAction("Оставить только мониторинг?",
        "Машина перестанет принимать команды по сети — отсюда и из Sprut.hub. Вернуть управление, скорее всего, получится только в меню самой машины.",
        "Оставить только мониторинг", "Не менять");
      if (!ok) { render(); return; }
    }
    store.set(id, value);
  }

  function buildSettings() {
    const box = $("settings");
    box.replaceChildren();
    refs.settings = store.list("set_").map((id) => {
      const t = splitTitle(store.title(id));
      const hint = settingHint(id);
      const type = store.type(id);
      const options = store.options(id);
      const ref = { id, kind: "", node: null, items: [] };
      const labelId = "lbl-" + id;
      let control;

      if (type === "switch") {
        ref.kind = "switch";
        ref.node = control = makeSwitch(t.name, (on) => changeSetting(id, on));
      } else if (options.length) {
        const total = options.reduce((n, o) => n + o.label.length, 0);
        if (options.length <= 4 && total <= 22) {
          ref.kind = "segmented";
          control = el("div", { class: "segmented segmented--compact", role: "radiogroup", "aria-labelledby": labelId });
          ref.items = options.map((o) => {
            const b = el("button", { type: "button", role: "radio", "aria-checked": "false", text: o.label });
            b.addEventListener("click", () => { if (!b.disabled) changeSetting(id, o.value, o.key); });
            control.appendChild(b);
            return { value: o.value, node: b };
          });
          ref.node = control;
        } else {
          ref.kind = "select";
          const sel = el("select", { class: "select", "aria-labelledby": labelId });
          options.forEach((o) => sel.appendChild(el("option", { value: o.value, text: o.label })));
          sel.addEventListener("change", () => {
            const o = options.filter((x) => x.value === sel.value)[0];
            changeSetting(id, sel.value, o ? o.key : "");
          });
          ref.node = sel;
          control = el("div", { class: "select-wrap" }, [sel]);
          control.appendChild(icon("chevron-down", 16));
        }
      } else if (type === "range" || type === "value") {
        ref.kind = "stepper";
        const meta = store.meta(id);
        const unit = meta.units === "min" ? " мин" : meta.units ? " " + meta.units : "";
        const out = el("output", { class: "stepper__value" });
        const minus = el("button", { type: "button", class: "stepper__btn", "aria-label": "Меньше" });
        const plus = el("button", { type: "button", class: "stepper__btn", "aria-label": "Больше" });
        minus.appendChild(icon("minus", 18));
        plus.appendChild(icon("plus", 18));
        const step = (d) => {
          const cur = Math.round(parseFloat(store.shown(id)) || 0);
          const next = Math.max(meta.min === undefined ? cur + d : meta.min, Math.min(meta.max === undefined ? cur + d : meta.max, cur + d));
          if (next !== cur) store.set(id, next);
        };
        minus.addEventListener("click", () => step(-1));
        plus.addEventListener("click", () => step(1));
        ref.out = out; ref.minus = minus; ref.plus = plus; ref.unit = unit;
        ref.node = control = el("div", { class: "stepper", role: "group", "aria-labelledby": labelId }, [minus, out, plus]);
      } else {
        return null;
      }

      box.appendChild(el("li", { class: "row row--" + ref.kind }, [
        el("div", { class: "row__text" }, [
          el("span", { class: "row__title", id: labelId, text: t.name + (t.note ? " — " + t.note : "") }),
          hint ? el("span", { class: "row__hint", text: hint }) : null
        ]),
        control
      ]));
      return ref;
    }).filter(Boolean);
  }

  function buildDemo() {
    if (!demo || !sim) return;
    setHidden($("demo"), false);
    const box = $("demo-controls");
    const toggles = [
      ["Дверь открыта", (on) => sim.setDoor(on), () => sim.m.door],
      ["Соль заканчивается", (on) => sim.setFlag("salt_low", on), () => sim.m.flags.salt_low],
      ["Нет ополаскивателя", (on) => sim.setFlag("rinse_empty", on), () => sim.m.flags.rinse_empty],
      ["Проверить фильтр", (on) => sim.setFlag("filter_check", on), () => sim.m.flags.filter_check],
      ["Протечка (AquaStop)", (on) => sim.setFlag("aquastop", on), () => sim.m.flags.aquastop],
      ["Запретить удалённый старт", (on) => sim.setRemote(!on), () => !sim.m.remote],
      ["Машина пропала из сети", (on) => sim.setOnline(!on), () => !sim.m.online]
    ];
    toggles.forEach((t) => {
      const sw = makeSwitch(t[0], (on) => { t[1](on); updateSwitch(sw, t[2]()); });
      box.appendChild(el("label", { class: "demo__item" }, [el("span", { text: t[0] }), sw]));
      refs.demo.push({ sw, get: t[2] });
    });
    box.appendChild(el("button", { type: "button", class: "btn btn--quiet demo__skip", text: "Перемотать программу к концу",
      onclick: () => sim.skipToEnd() }));
  }

  // ---------------- обновление ----------------
  const LINK_TEXT = {
    connecting: "Подключение…", broker: "Нет связи с контроллером", nodevice: "Устройство не найдено",
    machine: "Машина не на связи", ok: "На связи"
  };

  function renderScreen(v) {
    const screen = $("screen");
    const lost = v.link === "broker" && !v.loaded;
    const missing = v.link === "nodevice";
    setHidden(screen, !(lost || missing));
    if (!(lost || missing)) return false;
    const key = lost ? "broker" : "nodevice";
    if (screen.dataset.key === key) return true;
    screen.dataset.key = key;
    setIcon($("screen-icon"), lost ? "unplug" : "circle-alert", 32);
    const tips = $("screen-tips");
    const actions = $("screen-actions");
    tips.replaceChildren();
    actions.replaceChildren();
    if (lost) {
      setText($("screen-title"), "Нет связи с контроллером");
      setText($("screen-text"), "Страница не может подключиться к MQTT на Wiren Board. Попытки продолжаются сами.");
      ["Телефон или компьютер должен быть в домашней сети.",
       "Если на веб-интерфейс контроллера стоит пароль, войдите в него в этом же браузере и вернитесь сюда.",
       "На контроллере должны работать mosquitto и nginx."].forEach((t) => tips.appendChild(el("li", { text: t })));
      actions.appendChild(el("a", { class: "btn btn--quiet", href: "/", text: "Открыть интерфейс контроллера" }));
      actions.appendChild(el("a", { class: "btn btn--quiet", href: "?demo=1", text: "Посмотреть демо" }));
    } else {
      setText($("screen-title"), "Устройство «" + store.device + "» не найдено");
      setText($("screen-text"), "Связь с контроллером есть, но посудомойки в MQTT нет.");
      ["Правило dishwasher.js должно лежать в /etc/wb-rules и загружаться без ошибок.",
       "Если в правиле изменён CFG.id, укажите тот же id в config.js этой страницы."].forEach((t) => tips.appendChild(el("li", { text: t })));
    }
    return true;
  }

  function renderHero(v) {
    setText($("headline"), v.headline);
    updateSwitch(powerBtn, v.power, !v.canPower, store.pending("power") !== undefined);
    powerBtn.title = v.powerHint;

    const d = v.dial;
    const dial = $("dial");
    setAttr(dial, "data-tone", d.tone);
    dial.classList.toggle("is-waving", d.wave);
    dial.classList.toggle("is-spinning", d.icon === "loader-circle");
    $("dial-arc").setAttribute("stroke-dasharray", d.ring + " 100");
    $("dial-arc").style.opacity = d.ring > 0 ? "1" : "0"; // иначе круглый конец линии виден точкой
    // вода поднимается вместе с ходом программы, но остаётся ниже цифр
    $("dial-water").style.transform = "translateY(" + (208 - d.ring * 0.26) + "px)";
    setIcon($("dial-icon"), d.icon, 30);
    setHidden($("dial-icon"), !d.icon);
    setText($("dial-label"), d.label);
    setHidden($("dial-label"), !d.label);
    const val = $("dial-value");
    setText(val, d.value);
    val.classList.toggle("dial__value--text", !/^[\d:%]+$/.test(d.value));
    setText($("dial-sub"), d.sub);
    setHidden($("dial-sub"), !d.sub);
    setAttr($("dial-center"), "aria-label", [d.label, d.value, d.sub].filter(Boolean).join(", "));

    const phases = $("phases");
    setHidden(phases, v.phaseIndex < 0);
    if (v.phaseIndex >= 0) {
      const bars = phases.querySelectorAll(".phases__bars span");
      for (let i = 0; i < bars.length; i++) {
        setAttr(bars[i], "data-s", i < v.phaseIndex ? "done" : i === v.phaseIndex ? "now" : "next");
      }
      setText($("phases-label"), PHASES[v.phaseIndex] + " · этап " + (v.phaseIndex + 1) + " из " + PHASES.length);
    }

    const list = $("notices");
    const sig = v.issues.map((i) => i.id + i.level + i.text).join("|");
    if (list.dataset.sig !== sig) {
      list.dataset.sig = sig;
      list.replaceChildren();
      v.issues.forEach((i) => {
        const li = el("li", { class: "notice", "data-level": i.level });
        li.appendChild(icon(i.level === "error" ? "triangle-alert" : i.level === "warn" ? "circle-alert" : "info", 18));
        li.appendChild(el("span", { text: i.text }));
        list.appendChild(li);
      });
    }
  }

  function renderAction(v) {
    const a = v.action;
    setText(actBtn, a.label);
    actBtn.disabled = a.disabled;
    actBtn.className = "btn " + (a.kind === "start" ? "btn--primary" : "btn--stop");
    actBtn.classList.toggle("is-busy", store.pending("run") !== undefined);
    setText($("act-hint"), a.hint);
    setHidden($("act-hint"), !a.hint);
  }

  function renderPrograms(v) {
    refs.programs.forEach((r) => {
      const p = v.programs.filter((x) => x.uid === r.uid)[0];
      const selected = !!p && p.selected;
      setAttr(r.node, "aria-checked", selected ? "true" : "false");
      r.node.disabled = !v.canSelect;
      r.node.tabIndex = selected || (!v.selected && r === refs.programs[0]) ? 0 : -1;
    });
  }

  function renderOptions(v) {
    const off = !v.online || v.mode === "aborting" || v.mode === "error" || v.mode === "unknown";
    refs.options.forEach((r) => updateSwitch(r.sw, store.shownBool(r.id), off, store.pending(r.id) !== undefined));
  }

  function renderSchedule(v) {
    const card = $("schedule-card");
    // Пока программа идёт или ждёт отложенного старта, расписание менять нельзя, а правило
    // к этому моменту уже сбросило delay_h и finish_at — карточка показывала бы «Сразу».
    const show = v.hasDelay && !v.busy;
    setHidden(card, !show);
    if (!show) return;
    const locked = !v.online || v.busy || v.mode === "error" || v.mode === "unknown";
    modeBtns.forEach((b) => {
      setAttr(b, "aria-checked", b.dataset.mode === v.schedule ? "true" : "false");
      b.disabled = locked;
    });
    setHidden($("schedule-delay"), v.schedule !== "delay");
    setHidden($("schedule-finish"), v.schedule !== "finish");
    setText($("delay-value"), v.delayH + " ч");
    $("delay-minus").disabled = locked || v.delayH <= 1;
    $("delay-plus").disabled = locked || v.delayH >= v.delayMax;
    finishInput.disabled = locked;
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(v.finishAt);
    if (m && document.activeElement !== finishInput) {
      const hhmm = (m[1].length === 1 ? "0" : "") + m[1] + ":" + m[2];
      if (finishInput.value !== hhmm) finishInput.value = hhmm;
      lastFinish = hhmm;
    }
    setText($("schedule-preview"), v.endText ? "Окончание " + v.endText.replace(/, если запустить сейчас$/, "") : "");
  }

  function renderStatus(v) {
    const box = $("supplies");
    if (!box.children.length) {
      v.supplies.forEach((s) => {
        box.appendChild(el("li", { class: "supply", "data-id": s.id }, [
          el("span", { class: "supply__title", text: s.title }),
          el("span", { class: "supply__meter", "aria-hidden": "true" }, [el("i"), el("i"), el("i")]),
          el("span", { class: "supply__text" })
        ]));
      });
    }
    v.supplies.forEach((s, i) => {
      const li = box.children[i];
      setAttr(li, "data-level", s.level);
      setText(li.querySelector(".supply__text"), s.text);
    });

    const facts = $("facts");
    const sig = v.facts.map((f) => f.label + "=" + f.value).join("|");
    if (facts.dataset.sig !== sig) {
      facts.dataset.sig = sig;
      facts.replaceChildren();
      v.facts.forEach((f) => {
        facts.appendChild(el("div", { class: "fact" }, [el("dt", { text: f.label }), el("dd", { text: f.value })]));
      });
    }

    const badge = $("status-badge");
    setHidden(badge, v.attention === 0);
    setText(badge, String(v.attention));
    setAttr(badge, "aria-label", "требуют внимания: " + v.attention);
  }

  function renderLog() {
    const list = $("log");
    const sig = store.log.length + ":" + (store.log[0] ? store.log[0].at + store.log[0].text : "");
    if (list.dataset.sig === sig) return;
    list.dataset.sig = sig;
    list.replaceChildren();
    store.log.forEach((e) => {
      const n = parseNote(e.text);
      list.appendChild(el("li", { class: "log__item", "data-level": n.level }, [
        el("time", { class: "log__time", text: e.at }),
        el("span", { class: "log__text", text: n.text })
      ]));
    });
    setHidden($("log-note"), false);
    if (!store.log.length) setText($("log-note"), "Событий пока нет. Они появляются, когда машина или правило что-то сообщают.");
    else setText($("log-note"), "Показаны события с момента открытия страницы и последнее до него.");

    // свежий ответ правила — рядом с кнопкой действия
    const top = store.log[0];
    if (top && top.live) {
      const n = parseNote(top.text);
      const note = $("act-note");
      note.replaceChildren(icon(n.level === "error" ? "triangle-alert" : n.level === "warn" ? "circle-alert" : n.level === "ok" ? "circle-check" : "info", 16),
        el("span", { text: n.text }));
      setAttr(note, "data-level", n.level);
      setHidden(note, false);
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => setHidden(note, true), NOTE_SHOW_MS);
    }
  }

  function renderSettings(v) {
    setHidden($("settings-note"), v.online);
    refs.settings.forEach((r) => {
      const off = !v.online;
      const busy = store.pending(r.id) !== undefined;
      const shown = store.shown(r.id);
      if (r.kind === "switch") updateSwitch(r.node, store.shownBool(r.id), off, busy);
      else if (r.kind === "segmented") {
        r.items.forEach((it) => {
          setAttr(it.node, "aria-checked", String(Math.round(parseFloat(shown))) === it.value ? "true" : "false");
          it.node.disabled = off;
        });
      } else if (r.kind === "select") {
        const val = String(Math.round(parseFloat(shown)));
        if (document.activeElement !== r.node && r.node.value !== val) r.node.value = val;
        r.node.disabled = off;
      } else if (r.kind === "stepper") {
        const cur = Math.round(parseFloat(shown) || 0);
        const meta = store.meta(r.id);
        setText(r.out, cur + r.unit);
        r.minus.disabled = off || (meta.min !== undefined && cur <= meta.min);
        r.plus.disabled = off || (meta.max !== undefined && cur >= meta.max);
      }
    });
  }

  function renderNow() {
    frame = 0;
    const v = lastView = derive(store, deviceWaitOver);

    // ждём контролы ограниченное время, потом говорим, что устройства нет
    if (store.link === "connected" && !store.ready) {
      if (!deviceWaitTimer && !deviceWaitOver) {
        deviceWaitTimer = setTimeout(() => { deviceWaitTimer = null; deviceWaitOver = true; render(); }, DEVICE_WAIT_MS);
      }
    } else {
      clearTimeout(deviceWaitTimer);
      deviceWaitTimer = null;
      deviceWaitOver = false;
    }

    const link = $("link");
    setAttr(link, "data-link", v.link);
    setText($("link-text"), (demo ? "Демо · " : "") + (v.link === "broker" && store.linkInfo && !v.loaded ? LINK_TEXT.broker : LINK_TEXT[v.link]));

    const banner = $("banner");
    let bannerText = "";
    if (v.link === "broker" && v.loaded) bannerText = "Нет связи с контроллером — данные могли устареть. Переподключаюсь…";
    else if (demo) bannerText = "Демо-режим: машина ненастоящая, время идёт в " + (sim ? sim.speed : 60) + " раз быстрее.";
    setText(banner, bannerText);
    setHidden(banner, !bannerText);
    setAttr(banner, "data-kind", v.link === "broker" && v.loaded ? "warn" : "info");

    const blocked = renderScreen(v);
    const loading = !blocked && !v.loaded;
    setAttr(app, "data-loaded", v.loaded ? "true" : "false");
    setHidden($("skeleton"), !loading);
    ["wash", "status", "settings"].forEach((name) => {
      setHidden($("view-" + name), blocked || loading || view !== name);
    });
    if (blocked || loading) return;

    if (builtStructure !== store.structure) {
      builtStructure = store.structure;
      buildPrograms(v);
      buildOptions();
      buildSettings();
    }
    renderHero(v);
    renderAction(v);
    renderPrograms(v);
    renderOptions(v);
    renderSchedule(v);
    renderStatus(v);
    renderLog();
    renderSettings(v);
    refs.demo.forEach((r) => updateSwitch(r.sw, r.get()));
    setAttr(app, "data-mode", v.mode);
  }

  function render() {
    if (frame) return;
    frame = window.requestAnimationFrame(renderNow);
  }

  // стрелки внутри группы программ — как у радиокнопок
  $("programs").addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!keys[e.key]) return;
    const nodes = refs.programs.map((r) => r.node);
    const i = nodes.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    nodes[(i + keys[e.key] + nodes.length) % nodes.length].focus();
  });

  buildDemo();
  store.subscribe(render);
  render();
  return { render, showView };
}
