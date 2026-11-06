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
                    const majorClass = (property(device, 'Class') >> 8) & 31;
                    this.devices.push({
                        path: object.get_object_path(),
                        name: property(device, 'Alias') || 'Perangkat Bluetooth',
                        icon: property(device, 'Icon') ?? '',
                        type: {1: 'computer', 2: 'phone', 4: 'audio'}[majorClass] ?? '',
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

const CLIPBOARD_LIMIT = 1024 * 1024;
const CLIPBOARD_TYPES = [
    'x-special/gnome-copied-files', 'text/uri-list', 'image/png', 'image/jpeg', 'image/webp',
    'text/plain;charset=utf-8', 'text/plain', 'UTF8_STRING',
];

export class ClipboardShelf {
    constructor(selection, type, onChange) {
        this.entries = [];
        this._selection = selection;
        this._type = type;
        this._onChange = onChange;
        this._signal = selection.connect('owner-changed', (_selection, changed, owner) => {
            if (changed === type) {
                this._pending?.cancel();
                if (owner)
                    this._capture();
            }
        });
        this._capture();
    }

    async _capture() {
        const offered = this._selection.get_mimetypes(this._type) ?? [];
        if (offered.some(type => /passwordmanagerhint|x-sensitive/i.test(type)))
            return;
        const mime = CLIPBOARD_TYPES.find(type => offered.includes(type));
        if (!mime)
            return;
        const pending = new Gio.Cancellable();
        this._pending = pending;
        const output = Gio.MemoryOutputStream.new_resizable();
        try {
            await new Promise((resolve, reject) => {
                this._selection.transfer_async(this._type, mime, CLIPBOARD_LIMIT + 1, output, pending, (selection, result) => {
                    try {
                        resolve(selection.transfer_finish(result));
                    } catch (error) {
                        reject(error);
                    }
                });
            });
            if (pending.is_cancelled() || output.get_data_size() > CLIPBOARD_LIMIT || !output.get_data_size())
                return;
            output.close(null);
            const bytes = output.steal_as_bytes();
            const image = mime.startsWith('image/');
            const files = mime === 'text/uri-list' || mime === 'x-special/gnome-copied-files';
            const text = image ? '' : new TextDecoder().decode(bytes.get_data()).trim();
            if (!image && !text)
                return;
            const entry = {mime, bytes, image, files, text};
            this.entries = [entry, ...this.entries.filter(item => item.mime !== mime || !item.bytes.equal(bytes))].slice(0, 8);
            this._onChange();
        } catch {
            // Owners can disappear or revoke a selection during transfer.
        } finally {
            if (this._pending === pending)
                this._pending = null;
        }
    }

    clear() {
        this._pending?.cancel();
        this.entries = [];
        this._onChange();
    }

    destroy() {
        this._pending?.cancel();
        this._selection.disconnect(this._signal);
        this.entries = [];
    }
}

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

function readProc(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

export function systemSample() {
    const memory = readProc('/proc/meminfo');
    const total = Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]);
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]);
    let rx = 0;
    let tx = 0;
    for (const line of readProc('/proc/net/dev').split('\n')) {
        const [name, data] = line.split(':');
        if (!data || name.trim() === 'lo')
            continue;
        const fields = data.trim().split(/\s+/);
        rx += Number(fields[0]) || 0;
        tx += Number(fields[8]) || 0;
    }
    return {rx, tx, time: now(), memory: total > 0 && Number.isFinite(available) ? (total - available) / 1048576 : null};
}

function processIdentity(pid) {
    const credentials = new Gio.Credentials();
    if (pid <= 1 || pid === credentials.get_unix_pid())
        return null;
    const uid = /^Uid:\s+(\d+)/m.exec(readProc(`/proc/${pid}/status`))?.[1];
    const stat = readProc(`/proc/${pid}/stat`);
    const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return Number(uid) === credentials.get_unix_user() && started ? started : null;
}

async function command(argv, cancel) {
    const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const [stdout] = await process.communicate_utf8_async(null, cancel);
    if (!process.get_successful())
        throw new Error(`${argv[0]} gagal dijalankan.`);
    return stdout ?? '';
}

export async function developerSockets(cancel) {
    if (!GLib.find_program_in_path('ss'))
        return {ports: [], ssh: null, available: false};
    const output = await command(['ss', '-H', '-a', '-t', '-n', '-p'], cancel);
    const ports = new Map();
    let ssh = 0;
    for (const line of output.split('\n')) {
        const fields = /^\s*(\S+)\s+\d+\s+\d+\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
        if (!fields)
            continue;
        const [, state, local, remote, process = ''] = fields;
        if (state === 'ESTAB' && (/:22$/.test(local) || /:22$/.test(remote) || /"(?:ssh|sshd[^"]*)"/.test(process)))
            ssh++;
        if (state !== 'LISTEN')
            continue;
        const endpoint = /^(.*):(\d+)$/.exec(local);
        if (!endpoint)
            continue;
        let host = endpoint[1].replace(/^\[|\]$/g, '');
        if (host === '*' || host === '0.0.0.0')
            host = '127.0.0.1';
        else if (host === '::')
            host = '::1';
        const address = Gio.InetAddress.new_from_string(host);
        if (!address)
            continue;
        const port = Number(endpoint[2]);
        const owner = /\("([^"]+)",pid=(\d+)/.exec(process);
        const pid = Number(owner?.[2]);
        const started = Number.isInteger(pid) ? processIdentity(pid) : null;
        const entry = {port, host, pid, started, name: owner?.[1] ?? '',
            url: `http://${host.includes(':') ? `[${host}]` : host}:${port}/`};
        const previous = ports.get(port);
        if (!previous || (!previous.started && started))
            ports.set(port, entry);
    }
    const preferred = new Set([3000, 4000, 4173, 4200, 5000, 5173, 5500, 8000, 8080, 8888]);
    const ordered = [...ports.values()].sort((a, b) =>
        Number(preferred.has(b.port)) - Number(preferred.has(a.port)) || a.port - b.port);
    return {ports: ordered, ssh, available: true};
}

export async function stopLocalServer(entry, cancel) {
    const {ports} = await developerSockets(cancel);
    const current = ports.find(port => port.port === entry.port);
    if (!entry.started || current?.pid !== entry.pid || current.started !== entry.started ||
        processIdentity(entry.pid) !== entry.started)
        throw new Error('Proses pada port itu sudah berubah atau bukan milik pengguna ini.');
    await command(['kill', '-TERM', '--', String(entry.pid)], cancel);
}

export async function chooseLocalPath(directory, cancel) {
    if (!GLib.find_program_in_path('zenity'))
        throw new Error('Pemilih file memerlukan Zenity.');
    const title = directory ? 'Pilih folder' : 'Pilih file';
    const argv = ['zenity', '--file-selection', `--title=${title}`];
    if (directory)
        argv.push('--directory');
    const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    const handler = cancel.connect(() => process.force_exit());
    try {
        const [path] = await process.communicate_utf8_async(null, cancel);
        return process.get_successful() ? path?.replace(/\r?\n$/, '') ?? '' : '';
    } finally {
        if (handler)
            cancel.disconnect(handler);
    }
}

export async function gitProject(path, cancel) {
    const git = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', path];
    const root = (await command([...git, 'rev-parse', '--show-toplevel'], cancel)).trim();
    const [heading, ...changes] = (await command([...git, 'status', '--porcelain=v1', '--branch'], cancel)).trimEnd().split('\n');
    let origin = '';
    try {
        origin = (await command([...git, 'remote', 'get-url', 'origin'], cancel)).trim();
    } catch (error) {
        if (cancel?.is_cancelled())
            throw error;
    }
    const github = /^(?:(?:https:\/\/|ssh:\/\/(?:[^@/]+@)?)github\.com\/|[^@/]+@github\.com:)([\w.-]+)\/([\w.-]+)$/i.exec(origin);
    return {
        name: GLib.path_get_basename(root),
        branch: heading.replace(/^## /, ''),
        changes: changes.length,
        url: github ? `https://github.com/${github[1]}/${github[2].replace(/\.git$/, '')}` : '',
    };
}

const EDITORS = [
    [/code-insiders|visual studio code - insiders/i, 'VS Code Insiders'],
    [/vscodium|codium/i, 'VSCodium'],
    [/(^|[.\s_-])code($|[.\s_-])|visual studio code/i, 'VS Code'],
    [/cursor/i, 'Cursor'],
    [/windsurf/i, 'Windsurf'],
    [/android-studio|android studio/i, 'Android Studio'],
    [/jetbrains|intellij|pycharm|webstorm/i, 'JetBrains IDE'],
    [/(^|[.\s_-])zed($|[.\s_-])/i, 'Zed'],
    [/eclipse/i, 'Eclipse'],
    [/org\.gnome\.Builder/i, 'GNOME Builder'],
];

export function editorName(appId, wmClass) {
    const identifier = `${appId ?? ''} ${wmClass ?? ''}`;
    return EDITORS.find(([pattern]) => pattern.test(identifier))?.[1] ?? null;
}
