import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.DBusProxy, 'new_for_bus', 'new_for_bus_finish');
Gio._promisify(Gio.DBusObjectManagerClient, 'new_for_bus', 'new_for_bus_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');

const now = () => GLib.get_monotonic_time() / 1e6;

export class FocusTimer {
    constructor(focusMinutes, breakMinutes, onChange, onFinish) {
        this._durations = {focus: focusMinutes * 60, break: breakMinutes * 60};
        this._onChange = onChange;
        this._onFinish = onFinish;
        this.phase = 'focus';
        this.remaining = this._durations.focus;
        this.running = false;
    }

    toggle() {
        if (this.running) {
            this._tick();
            this._stop();
        } else {
            this._deadline = now() + this.remaining;
            this.running = true;
            this._source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => this._tick());
        }
        this._onChange(this);
    }

    reset(phase = this.phase) {
        this._stop();
        this.phase = phase;
        this.remaining = this._durations[phase];
        this._onChange(this);
    }

    _tick() {
        const remaining = Math.max(0, this._deadline - now());
        if (remaining === 0) {
            const completed = this.phase;
            this.reset(completed === 'focus' ? 'break' : 'focus');
            this._onFinish(completed);
            return GLib.SOURCE_REMOVE;
        }
        const displayChanged = Math.ceil(remaining) !== Math.ceil(this.remaining);
        this.remaining = remaining;
        if (displayChanged)
            this._onChange(this);
        return GLib.SOURCE_CONTINUE;
    }

    _stop() {
        if (this._source)
            GLib.Source.remove(this._source);
        this._source = 0;
        this.running = false;
    }

    destroy() {
        this._stop();
    }
}

export class WhiteNoise {
    constructor(onChange) {
        this._onChange = onChange;
        this.available = GLib.find_program_in_path('gst-launch-1.0') !== null;
    }

    get playing() {
        return !!this._process;
    }

    start() {
        if (!this.available || this.playing)
            return;
        try {
            this._process = Gio.Subprocess.new([
                'gst-launch-1.0', '-q', 'audiotestsrc', 'wave=white-noise', 'volume=0.04',
                'is-live=true', '!', 'audioconvert', '!', 'audioresample', '!', 'autoaudiosink',
            ], Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._watch(this._process);
            this._onChange();
        } catch {
            this._onChange('White noise tidak dapat diputar.');
        }
    }

    async _watch(process) {
        try {
            await process.wait_async(null);
        } catch {
            // Stop can finish the process before the wait completes.
        }
        if (process === this._process) {
            this._process = null;
            this._onChange('White noise berhenti. Periksa output audio.');
        }
    }

    stop() {
        const process = this._process;
        if (!process)
            return;
        this._process = null;
        process.force_exit();
        this._onChange();
    }
}

function property(proxy, name) {
    return proxy?.get_cached_property(name)?.deep_unpack();
}

export class SystemStatus {
    constructor(config, onChange, onConnect) {
        this._onChange = onChange;
        this._onConnect = onConnect;
        this._cancel = new Gio.Cancellable();
        this._subscriptions = [];
        this.devices = [];
        if (config.battery)
            this._connectPower();
        if (config.bluetooth)
            this._connectBluetooth();
    }

    _watch(object, signals, callback) {
        for (const signal of signals)
            this._subscriptions.push([object, object.connect(signal, callback)]);
    }

    async _connectPower() {
        try {
            const power = await Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, 'org.freedesktop.UPower',
                '/org/freedesktop/UPower/devices/DisplayDevice', 'org.freedesktop.UPower.Device', this._cancel);
            if (this._cancel.is_cancelled())
                return;
            const update = () => {
                const percentage = property(power, 'Percentage');
                this.battery = power.g_name_owner && property(power, 'IsPresent') && Number.isFinite(percentage) ?
                    {percentage: Math.round(percentage), state: property(power, 'State')} : null;
                this._onChange();
            };
            this._watch(power, ['g-properties-changed', 'notify::g-name-owner'], update);
            update();
        } catch (error) {
            if (!this._cancel.is_cancelled())
                console.warn(`RageNotch: UPower: ${error.message}`);
        }
    }

    async _connectBluetooth() {
        try {
            const manager = await Gio.DBusObjectManagerClient.new_for_bus(Gio.BusType.SYSTEM,
                Gio.DBusObjectManagerClientFlags.DO_NOT_AUTO_START, 'org.bluez', '/', null, this._cancel);
            if (this._cancel.is_cancelled())
                return;
            const update = (announce = true) => {
                const previous = new Set(this.devices.map(device => device.path));
                this.devices = [];
                for (const object of manager.get_objects()) {
                    const device = object.get_interface('org.bluez.Device1');
                    if (!property(device, 'Connected'))
                        continue;
                    this.devices.push({
                        path: object.get_object_path(),
                        name: property(device, 'Alias') || 'Perangkat Bluetooth',
                        percentage: property(object.get_interface('org.bluez.Battery1'), 'Percentage'),
                    });
                }
                this._onChange();
                if (announce) {
                    const connected = this.devices.find(device => !previous.has(device.path));
                    if (connected)
                        this._onConnect(connected);
                }
            };
            this._watch(manager, ['object-added', 'object-removed', 'interface-added', 'interface-removed'],
                () => update());
            this._watch(manager, ['interface-proxy-properties-changed'], (_manager, _object, proxy) => {
                if (['org.bluez.Device1', 'org.bluez.Battery1'].includes(proxy.g_interface_name))
                    update();
            });
            update(false);
        } catch (error) {
            if (!this._cancel.is_cancelled())
                console.warn(`RageNotch: BlueZ: ${error.message}`);
        }
    }

    destroy() {
        this._cancel.cancel();
        for (const [object, signal] of this._subscriptions)
            object.disconnect(signal);
        this._subscriptions = [];
    }
}
