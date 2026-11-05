#!/usr/bin/env python3
# Contact Bosh-Siemens Home Connect devices
# and connect their messages to the mqtt server
import json
import math
import signal
import ssl
import sys
from functools import partial
from threading import Event, Lock, Thread

import click
import click_config_file
import paho.mqtt.client as mqtt

from HADiscovery import publish_ha_discovery
from HCDevice import HCDevice
from HCSocket import HCSocket
from utils import clean_international_text, now

MAX_COMMAND_BYTES = 64 * 1024
GUARD_STATES = (
    "BSH.Common.Setting.PowerState",
    "BSH.Common.Status.OperationState",
    "BSH.Common.Status.DoorState",
    "BSH.Common.Status.RemoteControlStartAllowed",
)


def hcprint(*args):
    print(now(), *args, flush=True)


def topic_key(name):
    return name.lower().replace(".", "_")


def reject_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"non-finite JSON number: {value}")
    return number


def command_identifier(value):
    return type(value) is int or (isinstance(value, str) and bool(value))


def parse_command(payload, resource):
    if len(payload) > MAX_COMMAND_BYTES:
        raise ValueError("payload too large")
    data = json.loads(payload.decode("utf-8"), parse_constant=reject_constant, parse_float=finite_float)
    entries = data if isinstance(data, list) else [data]
    if not entries or any(not isinstance(entry, dict) for entry in entries):
        raise ValueError("expected a command object or a non-empty array of command objects")
    for entry in entries:
        if resource == "/ro/values":
            identifier = entry.get("uid", entry.get("name"))
            if not command_identifier(identifier) or entry.get("value") is None:
                raise ValueError("missing setting identifier or value")
        else:
            if not command_identifier(entry.get("program")):
                raise ValueError("missing program identifier")
            options = entry.get("options", [])
            if not isinstance(options, list) or any(
                not isinstance(option, dict) or not command_identifier(option.get("uid")) or option.get("value") is None
                for option in options
            ):
                raise ValueError("invalid program options")
    return data


class DeviceChannel:
    """Keep one current snapshot for each appliance, independent of the broker."""

    def __init__(self, client, device, topic, broker_ready, debug, discovery_file, events_as_sensors):
        self.client = client
        self.config = device
        self.topic = topic
        self.name = device["name"]
        self.broker_ready = broker_ready
        self.debug = debug
        self.discovery_file = discovery_file
        self.events_as_sensors = events_as_sensors
        names = {f.get("name", "") for f in device["features"].values()}
        self.commands = {f"{topic}/set": "/ro/values"}
        for action, feature in (("activeProgram", "ActiveProgram"), ("selectedProgram", "SelectedProgram")):
            if f"BSH.Common.Root.{feature}" in names:
                self.commands[f"{topic}/{action}"] = f"/ro/{action}"
        self._event_keys = {key for key in names if ".Event." in key}
        self._state_keys = set(GUARD_STATES)
        self._state = {}
        self._events = {}
        self._published = {}
        self._device = None
        self._ready = False
        self._discovery_published = False
        self._lock = Lock()

    def attach(self, device):
        with self._lock:
            self._device = device
            self._ready = False
            self._state.clear()
            self._discovery_published = False
            self._flush()

    def receive(self, device, values):
        if not values:
            return
        if self.debug:
            hcprint(self.name, values)
        with self._lock:
            if device is not self._device:
                return
            for key, value in values.items():
                if ".Event." in key:
                    if key in self._event_keys:
                        self._events[key] = json.dumps({"event_type": value})
                        self._published.pop(f"event/{topic_key(key)}", None)
                elif value is not None or key in self._state_keys:
                    device.state[key] = value
                    self._state[key] = json.dumps(value) if isinstance(value, dict) else str(value)
                    self._state_keys.add(key)
            if self._ready:
                self._flush()

    def mark_ready(self, device):
        with self._lock:
            if device is self._device and device.connected:
                self._ready = True
                self._flush()

    def detach(self, device):
        with self._lock:
            if device is self._device:
                self._ready = False
                self._device = None
                self._state.clear()
                self._flush()

    def republish(self):
        with self._lock:
            self._published.clear()
            self._discovery_published = False
            return self._flush(reset=True)

    def send(self, resource, payload):
        with self._lock:
            if self._ready and self._device.connected and self._published.get("LWT") == "online":
                self._device.get(resource, 1, "POST", payload)
            else:
                hcprint(self.name, "ignoring command while appliance is offline or initializing")

    def _publish(self, topic, payload):
        if self._published.get(topic) == payload:
            return True
        info = self.client.publish(f"{self.topic}/{topic}", payload, retain=True)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            return False
        self._published[topic] = payload
        return True

    def _flush(self, reset=False):
        if not self.broker_ready.is_set() or not self.client.is_connected():
            return False
        if (reset or not self._ready) and not self._publish("LWT", "offline"):
            return False
        for key in sorted(self._state_keys):
            payload = self._state.get(key, "") if self._ready else ""
            if not self._publish(f"state/{topic_key(key)}", payload):
                return False
        for key, payload in self._events.items():
            if not self._publish(f"event/{topic_key(key)}", payload):
                return False
        if not self._ready:
            return True
        if not self._publish("LWT", "online"):
            return False
        self._publish_discovery()
        return True

    def _publish_discovery(self):
        if not self.discovery_file or self._discovery_published:
            return
        state = self._device.state
        if "mac" not in state and "swVersion" not in state:
            return
        try:
            publish_ha_discovery(
                self.discovery_file, self.config, state, self.client, self.topic, self.events_as_sensors
            )
            self._discovery_published = True
        except Exception as e:
            hcprint(self.name, "could not publish discovery:", e)


class MQTTBridge:
    def __init__(self, client, prefix, devices, debug=False, discovery_file=None, events_as_sensors=False):
        self.status_topic = f"{prefix}LWT"
        self._broker_ready = Event()
        self._accept_commands = False
        self.channels = []
        self.commands = {}
        for device in devices:
            topic = prefix + clean_international_text(device["name"])
            channel = DeviceChannel(
                client, device, topic, self._broker_ready, debug, discovery_file, events_as_sensors
            )
            self.channels.append(channel)
            for command, resource in channel.commands.items():
                if command in self.commands:
                    raise ValueError(f"duplicate appliance MQTT command topic: {command!r}")
                self.commands[command] = (channel, resource)

    def on_connect(self, client, userdata, flags, rc):
        self._accept_commands = False
        self._broker_ready.clear()
        if rc != 0:
            hcprint(f"ERROR MQTT connection failed: {rc}")
            return
        hcprint("MQTT connection established")
        if client.publish(self.status_topic, "offline", retain=True).rc != mqtt.MQTT_ERR_SUCCESS:
            return
        self._broker_ready.set()
        # Consumers may have retained values from the old session. Rebuild every
        # appliance snapshot before announcing that the bridge is usable.
        for channel in self.channels:
            if not channel.republish():
                return
        for topic in self.commands:
            if client.subscribe(topic)[0] != mqtt.MQTT_ERR_SUCCESS:
                return
        self._accept_commands = (
            client.publish(self.status_topic, "online", retain=True).rc == mqtt.MQTT_ERR_SUCCESS
        )

    def on_disconnect(self, client, userdata, rc):
        self._accept_commands = False
        self._broker_ready.clear()
        hcprint(f"MQTT client disconnected: {rc}")

    def on_message(self, client, userdata, msg):
        # With MQTT 3, the broker sets retain on delivery of a saved command
        # during (re)subscription. Live commands must never be replayed.
        if not self._accept_commands or msg.retain:
            return
        topic = "<invalid MQTT topic>"
        try:
            topic = msg.topic
            command = self.commands.get(topic)
            if command is None:
                return
            channel, resource = command
            channel.send(resource, parse_command(msg.payload, resource))
        except Exception as e:
            print(now(), topic, "command rejected:", type(e).__name__, file=sys.stderr, flush=True)


@click.command()
@click.option("-d", "--devices_file", default="config/devices.json")
@click.option("-h", "--mqtt_host", default="localhost")
@click.option("-p", "--mqtt_prefix", default="homeconnect/")
@click.option("--mqtt_port", default=1883, type=int)
@click.option("--mqtt_username")
@click.option("--mqtt_password")
@click.option("--mqtt_ssl", is_flag=True)
@click.option("--mqtt_cafile")
@click.option("--mqtt_certfile")
@click.option("--mqtt_keyfile")
@click.option("--mqtt_clientname", default="hcpy1")
@click.option("--domain_suffix", default="")
@click.option("--debug/--no-debug", default=False)
@click.option("--ha-discovery", is_flag=True)
@click.option("--discovery_file", default="config/discovery.yaml")
@click.option("--events_as_sensors", is_flag=True)
@click_config_file.configuration_option()
def hc2mqtt(
    devices_file: str,
    mqtt_host: str,
    mqtt_prefix: str,
    mqtt_port: int,
    mqtt_username: str,
    mqtt_password: str,
    mqtt_ssl: bool,
    mqtt_cafile: str,
    mqtt_certfile: str,
    mqtt_keyfile: str,
    mqtt_clientname: str,
    domain_suffix: str,
    debug: bool,
    ha_discovery: bool,
    discovery_file: str,
    events_as_sensors: bool,
):

    masked_password = "***" if mqtt_password else None
    click.echo(
        f"Hello {devices_file=} {mqtt_host=} {mqtt_prefix=} "
        f"{mqtt_port=} {mqtt_username=} mqtt_password={masked_password!r} "
        f"{mqtt_ssl=} {mqtt_cafile=} {mqtt_certfile=} {mqtt_keyfile=} {mqtt_clientname=}"
        f"{domain_suffix=} {debug=} {ha_discovery=}"
    )

    with open(devices_file, "r") as f:
        devices = json.load(f)

    client = mqtt.Client(mqtt_clientname)
    bridge = MQTTBridge(
        client, mqtt_prefix, devices, debug, discovery_file if ha_discovery else None, events_as_sensors
    )

    if mqtt_username and mqtt_password:
        client.username_pw_set(mqtt_username, mqtt_password)

    if mqtt_ssl:
        if mqtt_cafile and mqtt_certfile and mqtt_keyfile:
            client.tls_set(
                ca_certs=mqtt_cafile,
                certfile=mqtt_certfile,
                keyfile=mqtt_keyfile,
                cert_reqs=ssl.CERT_REQUIRED,
            )
        else:
            client.tls_set(cert_reqs=ssl.CERT_NONE)

    client.will_set(f"{mqtt_prefix}LWT", payload="offline", qos=0, retain=True)
    client.on_connect = bridge.on_connect
    client.on_disconnect = bridge.on_disconnect
    client.on_message = bridge.on_message
    client.connect(host=mqtt_host, port=mqtt_port, keepalive=70)

    shutdown = Event()

    for channel in bridge.channels:
        thread = Thread(
            target=client_connect,
            args=(channel, domain_suffix, shutdown),
            daemon=True,
        )
        thread.start()

    def handle_exit(signum, frame):
        shutdown.set()
        sys.exit(128 + signum)

    signal.signal(signal.SIGTERM, handle_exit)
    signal.signal(signal.SIGINT, handle_exit)
    # Paho's threaded loop owns socket writes even when device threads publish.
    client.loop_start()
    shutdown.wait()


def client_connect(channel, domain_suffix, shutdown):
    device = channel.config
    host = device["host"]
    name = device["name"]

    retry_delay = 5
    while not shutdown.is_set():
        mydevice = None
        try:
            ws = HCSocket(host, device["key"], device.get("iv", None), domain_suffix, channel.debug)
            mydevice = HCDevice(ws, device, channel.debug)
            channel.attach(mydevice)
            hcprint(name, f"connecting to {host}")
            mydevice.run_forever(
                on_message=partial(channel.receive, mydevice),
                on_open=lambda ws: None,
                on_close=lambda ws, code, message, source=mydevice: channel.detach(source),
                on_ready=partial(channel.mark_ready, mydevice),
            )
            hcprint(name, f"not connected {host}")
            retry_delay = 5
        except Exception as e:
            print(now(), name, "ERROR", e, file=sys.stderr, flush=True)
        finally:
            if mydevice is not None:
                channel.detach(mydevice)

        hcprint(name, f"reconnecting in {retry_delay}s")
        shutdown.wait(retry_delay)
        retry_delay = min(retry_delay * 2, 60)


if __name__ == "__main__":
    hc2mqtt(auto_envvar_prefix="HCPY")
