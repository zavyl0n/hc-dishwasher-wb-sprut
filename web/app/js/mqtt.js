// Минимальный клиент MQTT 3.1.1 поверх WebSocket: только QoS 0, чистая сессия.
// Без зависимостей: страница должна работать в локальной сети без интернета.
// Работает в браузере и в Node (нужен глобальный WebSocket или opts.WebSocketImpl).

const enc = new TextEncoder();
const dec = new TextDecoder();

const CONNACK = 2, PUBLISH = 3, PUBACK = 4, PINGRESP = 13;
const PINGREQ_BYTES = Uint8Array.of(0xc0, 0x00);
const DISCONNECT_BYTES = Uint8Array.of(0xe0, 0x00);
const MAX_REMAINING = 268435455; // предел четырёхбайтной длины

// ---------- Кодирование ----------

// Строка MQTT: два байта длины (старший первым) и UTF-8.
function mqttString(s) {
  const b = enc.encode(String(s));
  if (b.length > 65535) throw new RangeError("строка MQTT длиннее 65535 байт");
  const out = new Uint8Array(2 + b.length);
  out[0] = b.length >> 8;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

// «Оставшаяся длина»: по 7 бит на байт, младшие первыми, старший бит — «есть продолжение».
function remainingLength(n) {
  if (n > MAX_REMAINING) throw new RangeError("пакет MQTT слишком большой");
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}

// Собирает пакет: первый байт, длина, части тела.
function packet(firstByte, parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const head = [firstByte, ...remainingLength(len)];
  const out = new Uint8Array(head.length + len);
  out.set(head, 0);
  let pos = head.length;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  return out;
}

export function encodeConnect({ clientId, keepAlive, username, password }) {
  const hasUser = username !== undefined && username !== null;
  const hasPass = password !== undefined && password !== null;
  let flags = 0x02; // чистая сессия
  if (hasUser) flags |= 0x80;
  if (hasPass) flags |= 0x40;
  const ka = Math.max(0, Math.min(65535, Math.round(keepAlive || 0)));
  const parts = [
    mqttString("MQTT"),
    Uint8Array.of(4, flags, ka >> 8, ka & 0xff), // уровень протокола 4 = MQTT 3.1.1
    mqttString(clientId),
  ];
  if (hasUser) parts.push(mqttString(username));
  if (hasPass) parts.push(mqttString(password));
  return packet(0x10, parts);
}

export function encodeSubscribe(packetId, filters) {
  const parts = [Uint8Array.of((packetId >> 8) & 0xff, packetId & 0xff)];
  for (const f of filters) parts.push(mqttString(f), Uint8Array.of(0)); // запрошенный QoS 0
  return packet(0x82, parts);
}

export function encodePublish(topic, payload, { retain } = {}) {
  return packet(retain ? 0x31 : 0x30, [mqttString(topic), enc.encode(String(payload))]);
}

// ---------- Разбор ----------

// Собирает пакеты из потока: в одном кадре WebSocket может быть несколько пакетов,
// а один пакет может прийти несколькими кадрами (разрыв возможен и внутри байтов длины).
export class PacketReader {
  constructor() {
    this._buf = new Uint8Array(0);
  }

  push(chunk) {
    const add = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (this._buf.length === 0) {
      this._buf = add;
    } else {
      const joined = new Uint8Array(this._buf.length + add.length);
      joined.set(this._buf, 0);
      joined.set(add, this._buf.length);
      this._buf = joined;
    }
    const buf = this._buf;
    const packets = [];
    let pos = 0;
    for (;;) {
      if (buf.length - pos < 2) break;
      // Длина тела: от 1 до 4 байт.
      let len = 0, mult = 1, i = pos + 1, complete = false;
      while (i < buf.length) {
        if (i - pos > 4) throw new Error("неверная длина пакета MQTT");
        const b = buf[i++];
        len += (b & 0x7f) * mult;
        mult *= 128;
        if ((b & 0x80) === 0) { complete = true; break; }
      }
      if (!complete) {
        if (i - pos > 4) throw new Error("неверная длина пакета MQTT");
        break; // длина ещё не дочитана
      }
      if (buf.length - i < len) break; // тело ещё не дочитано
      // slice копирует: тело не зависит от буфера кадра.
      packets.push({ type: buf[pos] >> 4, flags: buf[pos] & 0x0f, body: buf.slice(i, i + len) });
      pos = i + len;
    }
    this._buf = pos === buf.length ? new Uint8Array(0) : buf.slice(pos);
    return packets;
  }
}

export function parsePublish(flags, body) {
  const qos = (flags >> 1) & 3;
  if (body.length < 2) throw new Error("обрезанный пакет PUBLISH");
  const tlen = (body[0] << 8) | body[1];
  let pos = 2 + tlen;
  if (pos > body.length) throw new Error("обрезанный пакет PUBLISH");
  const topic = dec.decode(body.subarray(2, pos));
  let packetId = null;
  if (qos > 0) {
    if (pos + 2 > body.length) throw new Error("обрезанный пакет PUBLISH");
    packetId = (body[pos] << 8) | body[pos + 1];
    pos += 2;
  }
  return { topic, payload: dec.decode(body.subarray(pos)), retained: (flags & 1) === 1, qos, packetId };
}

// ---------- Клиент ----------

export class MqttClient {
  constructor(opts) {
    opts = opts || {};
    this.url = opts.url;
    this.clientId = opts.clientId || "dw-web-" + Math.random().toString(16).slice(2, 10);
    this.keepAlive = opts.keepAlive === undefined ? 30 : opts.keepAlive;
    this.username = opts.username;
    this.password = opts.password;
    this.WebSocketImpl = opts.WebSocketImpl || globalThis.WebSocket;
    this.reconnectMin = opts.reconnectMin === undefined ? 1000 : opts.reconnectMin;
    this.reconnectMax = opts.reconnectMax === undefined ? 15000 : opts.reconnectMax;

    this.onMessage = () => {};
    this.onStatus = () => {};

    this._filters = [];      // запомненные подписки
    this._ws = null;
    this._reader = null;
    this._active = false;    // между connect() и close()
    this._connected = false;
    this._delay = this.reconnectMin;
    this._packetId = 0;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._deadTimer = null;
  }

  get connected() {
    return this._connected;
  }

  connect() {
    if (this._active) return;
    this._active = true;
    this._delay = this.reconnectMin;
    this._status("connecting");
    this._open();
  }

  close() {
    if (!this._active) return;
    this._active = false;
    if (this._connected) this._send(DISCONNECT_BYTES);
    this._teardown();
    this._status("closed");
  }

  subscribe(filters) {
    const list = typeof filters === "string" ? [filters] : Array.from(filters || []);
    const fresh = [];
    for (const f of list) {
      if (!this._filters.includes(f)) { this._filters.push(f); fresh.push(f); }
    }
    if (this._connected && fresh.length) this._sendSubscribe(fresh);
  }

  publish(topic, payload, opts) {
    if (!this._connected) return false;
    return this._send(encodePublish(topic, payload, opts || {}));
  }

  // ----- внутреннее -----

  _open() {
    let ws;
    try {
      if (!this.WebSocketImpl) throw new Error("WebSocket недоступен");
      ws = new this.WebSocketImpl(this.url, ["mqtt"]); // mosquitto требует подпротокол
      ws.binaryType = "arraybuffer";
    } catch (e) {
      this._drop("не удалось открыть соединение: " + (e && e.message ? e.message : e));
      return;
    }
    this._ws = ws;
    this._reader = new PacketReader();
    // События от старого сокета после замены игнорируются.
    ws.onopen = () => {
      if (ws !== this._ws) return;
      this._send(encodeConnect({
        clientId: this.clientId, keepAlive: this.keepAlive,
        username: this.username, password: this.password,
      }));
    };
    ws.onmessage = (ev) => {
      if (ws === this._ws) this._onData(ev.data);
    };
    // В браузере за error всегда следует close, а WebSocket в Node 20 при отказе
    // в соединении присылает только error — поэтому сбрасываем по любому из двух.
    ws.onclose = ws.onerror = () => {
      if (ws === this._ws) this._drop(this._connected ? "соединение потеряно" : "не удалось подключиться");
    };
    this._armDeadTimer();   // сторожит и само подключение, и ожидание CONNACK
  }

  _onData(data) {
    if (typeof data === "string") { this._drop("ошибка протокола: текстовый кадр"); return; }
    this._armDeadTimer();
    const ws = this._ws;
    try {
      for (const p of this._reader.push(data)) {
        this._onPacket(p);
        if (ws !== this._ws) return; // соединение сброшено при обработке пакета
      }
    } catch (e) {
      console.error("mqtt:", e);
      this._drop("ошибка протокола");
    }
  }

  _onPacket(p) {
    if (p.type === CONNACK) {
      if (this._connected) return;
      const code = p.body.length >= 2 ? p.body[1] : 255;
      if (code !== 0) { this._drop("брокер отклонил подключение, код " + code); return; }
      this._connected = true;
      this._delay = this.reconnectMin;
      if (this._filters.length) this._sendSubscribe(this._filters);
      if (this.keepAlive > 0) {
        this._pingTimer = setInterval(() => this._send(PINGREQ_BYTES), this.keepAlive * 500);
      }
      this._status("connected");
    } else if (p.type === PUBLISH) {
      const m = parsePublish(p.flags, p.body);
      if (m.qos === 1) this._send(Uint8Array.of(PUBACK << 4, 2, m.packetId >> 8, m.packetId & 0xff));
      try {
        this.onMessage(m.topic, m.payload, m.retained);
      } catch (e) {
        console.error("mqtt: ошибка в onMessage:", e);
      }
    } else if (p.type === PINGRESP) {
      // ответ на PINGREQ: таймер молчания уже переведён в _onData
    }
    // SUBACK и прочее не нужны: подписки QoS 0, подтверждений не ждём
  }

  _sendSubscribe(filters) {
    this._packetId = (this._packetId % 65535) + 1; // идентификатор пакета не бывает нулём
    this._send(encodeSubscribe(this._packetId, filters));
  }

  _send(bytes) {
    if (!this._ws) return false;
    try {
      this._ws.send(bytes);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Брокер молчит 1.5 × keepAlive — считаем связь мёртвой.
  _armDeadTimer() {
    clearTimeout(this._deadTimer);
    this._deadTimer = null;
    if (!(this.keepAlive > 0)) return;
    this._deadTimer = setTimeout(() => this._drop("нет ответа от брокера"), this.keepAlive * 1500);
  }

  // Закрывает сокет и снимает все таймеры.
  _teardown() {
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._deadTimer);
    clearInterval(this._pingTimer);
    this._reconnectTimer = this._deadTimer = this._pingTimer = null;
    this._connected = false;
    const ws = this._ws;
    this._ws = null;
    this._reader = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.onerror = () => {};
      try { ws.close(); } catch (e) { /* уже закрыт */ }
    }
  }

  // Сбрасывает соединение и назначает новую попытку с растущей задержкой.
  _drop(info) {
    this._teardown();
    if (!this._active) return;
    const delay = this._delay;
    this._delay = Math.min(Math.max(delay * 2, 1), this.reconnectMax);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this._active) this._open();
    }, delay);
    this._status("reconnecting", info);
  }

  _status(status, info) {
    try {
      this.onStatus(status, info);
    } catch (e) {
      console.error("mqtt: ошибка в onStatus:", e);
    }
  }
}
