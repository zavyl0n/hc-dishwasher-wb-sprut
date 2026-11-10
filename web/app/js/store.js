// Модель устройства Wiren Board по MQTT: значения и метаданные контролов, отправка команд.
// Не знает ничего о посудомойке и о DOM — только соглашения WB о топиках:
//   /devices/<id>/controls/<ctrl>            значение (retained)
//   /devices/<id>/controls/<ctrl>/meta       JSON с типом, названием, enum, min/max...
//   /devices/<id>/controls/<ctrl>/meta/<поле> то же по одному полю (старый формат)
//   /devices/<id>/controls/<ctrl>/on         команда

const LOG_LIMIT = 60;

/** Подпись из meta: строка или объект { ru, en }. */
export function pickTitle(t) {
  if (t === undefined || t === null) return "";
  if (typeof t === "string") return t;
  if (typeof t === "object") return t.ru || t.en || String(Object.values(t)[0] || "");
  return String(t);
}

function isOn(v) { return v === "1" || v === "true"; }

export class DeviceStore {
  /**
   * opts: { device = "dishwasher", transport, ackMs = 4000, now = Date.now }
   * transport — MqttClient или объект с тем же интерфейсом (демо).
   */
  constructor(opts) {
    this.device = opts.device || "dishwasher";
    this.transport = opts.transport;
    this.ackMs = opts.ackMs === undefined ? 4000 : opts.ackMs;
    this.now = opts.now || Date.now;
    this.prefix = "/devices/" + this.device + "/";
    this.controls = new Map();     // id -> { value, meta: {...}, error }
    this.deviceTitle = "";
    this.link = "connecting";      // connecting | connected | reconnecting | closed
    this.linkInfo = "";
    this.ready = false;            // пришёл хотя бы один контрол
    this.structure = 0;            // растёт, когда меняется состав или метаданные контролов
    this.log = [];                 // [{ at, text, live }] — из «Последнее событие», новые в начале
    this._pending = new Map();     // id -> { value, timer }
    this._listeners = new Set();
    this._changed = new Set();
    this._flushScheduled = false;
  }

  start() {
    const t = this.transport;
    t.onMessage = (topic, payload, retained) => this.handleMessage(topic, payload, retained);
    t.onStatus = (status, info) => {
      this.link = status;
      this.linkInfo = info || "";
      if (status !== "connected") this._clearPending();
      this._touch("@link");
    };
    t.subscribe([this.prefix + "#"]);
    t.connect();
  }

  /** fn(changed: Set<string>) — id контролов и служебные «@link», «@structure», «@log». */
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  // ---- чтение -------------------------------------------------------
  has(id) { return this.controls.has(id); }
  raw(id) { const c = this.controls.get(id); return c ? c.value : undefined; }
  meta(id) { const c = this.controls.get(id); return c ? c.meta : {}; }
  type(id) { return this.meta(id).type || ""; }
  readonly(id) { return this.meta(id).readonly === true; }
  title(id) { return pickTitle(this.meta(id).title) || id; }
  error(id) { const c = this.controls.get(id); return c ? c.error || "" : ""; }

  bool(id) { return isOn(this.raw(id)); }
  num(id) {
    const n = parseFloat(this.raw(id));
    return isNaN(n) ? 0 : n;
  }
  text(id) { const v = this.raw(id); return v === undefined ? "" : String(v); }

  /** Варианты enum: [{ value: "0", label: "Выкл", key: "Off" }] в порядке значений. */
  options(id) {
    const e = this.meta(id).enum;
    if (!e || typeof e !== "object") return [];
    return Object.keys(e)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => {
        const item = e[k];
        const key = item && typeof item === "object" ? item.en || "" : "";
        return { value: k, label: pickTitle(item) || k, key };
      });
  }

  /** id контролов с данным префиксом, в порядке meta.order. */
  list(prefix) {
    const ids = [];
    this.controls.forEach((c, id) => { if (id.indexOf(prefix) === 0) ids.push(id); });
    return ids.sort((a, b) => (this.meta(a).order || 0) - (this.meta(b).order || 0) || a.localeCompare(b));
  }

  // ---- команды ------------------------------------------------------
  /** Значение, которое пользователь только что задал и которое ещё не подтверждено. */
  pending(id) {
    const p = this._pending.get(id);
    return p ? p.value : undefined;
  }
  /** Что показывать: неподтверждённое значение пользователя или фактическое. */
  shown(id) {
    const p = this._pending.get(id);
    return p ? p.value : this.raw(id);
  }
  shownBool(id) { return isOn(this.shown(id)); }

  /** Отправить команду. value: boolean | number | string. Возвращает false, если нет связи. */
  set(id, value) {
    let payload;
    if (typeof value === "boolean") payload = value ? "1" : "0";
    else payload = String(value);
    if (!this.transport.publish(this.prefix + "controls/" + id + "/on", payload)) return false;
    const old = this._pending.get(id);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      this._pending.delete(id);
      this._touch(id);
    }, this.ackMs);
    this._pending.set(id, { value: payload, timer });
    this._touch(id);
    return true;
  }
  press(id) { return this.transport.publish(this.prefix + "controls/" + id + "/on", "1"); }

  stop() {
    this._clearPending();
    this._listeners.clear();
    if (this.transport.close) this.transport.close();
  }

  // ---- входящие сообщения -------------------------------------------
  handleMessage(topic, payload, retained) {
    if (topic.indexOf(this.prefix) !== 0) return;
    const rest = topic.slice(this.prefix.length);
    if (rest === "meta") {
      let title = "";
      try { title = pickTitle(JSON.parse(payload).title); } catch (e) { /* не JSON */ }
      if (title) this.deviceTitle = title;                 // JSON без названия не стирает имя из meta/name
      this._touch("@structure");
      return;
    }
    if (rest === "meta/name") {
      if (!this.deviceTitle && payload) {
        this.deviceTitle = payload;
        this._touch("@structure");
      }
      return;
    }
    if (rest.indexOf("controls/") !== 0) return;
    const parts = rest.slice("controls/".length).split("/");
    const id = parts[0];
    if (!id) return;

    if (parts.length === 1) return this._onValue(id, payload, retained);
    if (parts[1] === "on") return;                       // чужие команды нас не интересуют
    if (parts[1] !== "meta") return;
    if (parts.length === 2) return this._onMetaJson(id, payload);
    if (parts.length === 3) return this._onMetaField(id, parts[2], payload);
  }

  _ctrl(id) {
    let c = this.controls.get(id);
    if (!c) {
      c = { value: undefined, meta: {}, error: "" };
      this.controls.set(id, c);
      this.structure++;
      this._touch("@structure");
    }
    return c;
  }

  _onValue(id, payload, retained) {
    // Пустое сообщение — контрол удалён (пустым бывает только текст, а тип без метаданных неизвестен).
    // Брокер пересылает его подписчикам без признака retained, поэтому на retained не смотрим.
    if (payload === "" && this.type(id) && this.type(id) !== "text") {
      this.controls.delete(id);
      this.structure++;
      this._touch("@structure");
      return;
    }
    const c = this._ctrl(id);
    const p = this._pending.get(id);
    if (p) {                                             // любой ответ правила снимает ожидание
      clearTimeout(p.timer);
      this._pending.delete(id);
    }
    const changed = c.value !== payload;
    c.value = payload;
    this.ready = true;
    if (id === "last_message" && payload.trim() && (changed || !this.log.length)) this._addLog(payload, !retained);
    if (changed || p) this._touch(id);
  }

  _onMetaJson(id, payload) {
    if (payload === "") return;
    let m;
    try { m = JSON.parse(payload); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const c = this._ctrl(id);
    const next = Object.assign({}, c.meta, m);
    if (JSON.stringify(next) === JSON.stringify(c.meta)) return;
    c.meta = next;
    if (typeof m.error === "string") c.error = m.error;
    this.structure++;
    this._touch("@structure");
    this._touch(id);
  }

  _onMetaField(id, field, payload) {
    if (payload === "" && !this.controls.has(id)) return;         // хвост удалённого контрола
    const c = this._ctrl(id);
    if (field === "error") {
      if (c.error !== payload) { c.error = payload; this._touch(id); }
      return;
    }
    let v = payload;
    if (field === "readonly") v = payload === "1" || payload === "true";
    else if (field === "order" || field === "min" || field === "max" || field === "precision") {
      v = parseFloat(payload);
      if (isNaN(v)) return;
    } else if (field !== "type" && field !== "units") return;   // title/enum берём только из JSON
    if (c.meta[field] !== undefined) return;                      // JSON-метаданные важнее
    c.meta = Object.assign({}, c.meta, { [field]: v });
    this.structure++;
    this._touch("@structure");
    this._touch(id);
  }

  _addLog(raw, live) {
    // формат правила: «10.11 21:32  текст»; live — событие случилось при нас, а не пришло из retained
    const m = /^(\d{2}\.\d{2} \d{2}:\d{2})\s+([\s\S]*)$/.exec(raw);
    const entry = m ? { at: m[1], text: m[2], live } : { at: "", text: raw.trim(), live };
    const top = this.log[0];
    if (top && top.at === entry.at && top.text === entry.text) return;
    this.log.unshift(entry);
    if (this.log.length > LOG_LIMIT) this.log.length = LOG_LIMIT;
    this._touch("@log");
  }

  _clearPending() {
    this._pending.forEach((p, id) => { clearTimeout(p.timer); this._changed.add(id); });
    this._pending.clear();
  }

  _touch(what) {
    this._changed.add(what);
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    // сообщения приходят пачками (сотня retained при подключении) — отдаём изменения одним разом
    Promise.resolve().then(() => {
      this._flushScheduled = false;
      const changed = this._changed;
      this._changed = new Set();
      this._listeners.forEach((fn) => {
        try { fn(changed); } catch (e) { console.error(e); }
      });
    });
  }
}
