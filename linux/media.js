import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BUS = 'org.freedesktop.DBus';
const BUS_PATH = '/org/freedesktop/DBus';
const PREFIX = 'org.mpris.MediaPlayer2.';
const PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');
Gio._promisify(Gio.DBusProxy, 'new', 'new_finish');
Gio._promisify(Gio.DBusProxy.prototype, 'call', 'call_finish');

export class MediaPlayers {
    constructor(onChange, onSeek) {
        this._onChange = onChange;
        this._onSeek = onSeek;
        this._players = new Map();
        this._cancel = new Gio.Cancellable();
        this._bus = Gio.DBus.session;
        this._subscription = this._bus.signal_subscribe(
            BUS, BUS, 'NameOwnerChanged', BUS_PATH, 'org.mpris.MediaPlayer2',
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_bus, _sender, _path, _interface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deep_unpack();
                if (!name.startsWith(PREFIX))
                    return;
                if (oldOwner)
                    this._remove(name);
                if (newOwner)
                    this._add(name);
            });
        this._discover();
    }

    async _discover() {
        try {
            const reply = await this._bus.call(BUS, BUS_PATH, BUS, 'ListNames', null,
                null, Gio.DBusCallFlags.NONE, 2000, this._cancel);
            if (!this._cancel.is_cancelled()) {
                for (const name of reply.deep_unpack()[0].filter(name => name.startsWith(PREFIX)))
                    this._add(name);
            }
        } catch (error) {
            if (!this._cancel.is_cancelled())
                console.warn(`RageNotch: MPRIS discovery failed: ${error.message}`);
        }
    }

    async _add(name) {
        if (this._players.has(name))
            return;
        const entry = {};
        this._players.set(name, entry);
        try {
            const proxy = await Gio.DBusProxy.new(this._bus,
                Gio.DBusProxyFlags.DO_NOT_AUTO_START | Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES,
                null, name, PATH, PLAYER, this._cancel);
            if (this._players.get(name) !== entry)
                return;
            if (!proxy.g_name_owner) {
                this._remove(name);
                return;
            }
            entry.proxy = proxy;
            entry.changed = proxy.connect('g-properties-changed', () => this._emit());
            entry.seeked = proxy.connect('g-signal', (_proxy, _sender, signal, args) => {
                if (signal === 'Seeked' && this.current?.proxy === proxy)
                    this._onSeek(args.deep_unpack()[0] / 1e6);
            });
            this._emit();
        } catch {
            if (this._players.get(name) === entry)
                this._remove(name);
        }
    }

    _remove(name) {
        const entry = this._players.get(name);
        if (entry?.proxy) {
            entry.proxy.disconnect(entry.changed);
            entry.proxy.disconnect(entry.seeked);
        }
        if (this._players.delete(name))
            this._emit();
    }

    _emit() {
        const tracks = [];
        for (const [name, {proxy}] of this._players) {
            if (!proxy?.g_name_owner)
                continue;
            const get = property => proxy.get_cached_property(property)?.recursiveUnpack();
            const metadata = get('Metadata') ?? {};
            const status = get('PlaybackStatus');
            if (!metadata['xesam:title'] || metadata['mpris:trackid'] === NO_TRACK)
                continue;
            const artists = metadata['xesam:artist'];
            tracks.push({
                name,
                proxy,
                id: metadata['mpris:trackid'] ?? '',
                title: metadata['xesam:title'],
                artist: Array.isArray(artists) ? artists.join(', ') : artists ?? '',
                lookupArtist: Array.isArray(artists) ? artists[0] ?? '' : artists ?? '',
                album: metadata['xesam:album'] ?? '',
                art: metadata['mpris:artUrl'] ?? '',
                duration: (metadata['mpris:length'] ?? 0) / 1e6,
                playing: status === 'Playing',
                status,
                rate: get('Rate') || 1,
                previous: get('CanGoPrevious') === true,
                next: get('CanGoNext') === true,
                playPause: get('CanControl') === true &&
                    get(status === 'Playing' ? 'CanPause' : 'CanPlay') === true,
            });
        }

        // Preserve the selected player when multiple players have the same playback status.
        const previous = tracks.find(track => track.proxy === this.current?.proxy);
        this.current = (previous?.playing && previous) || tracks.find(track => track.playing) ||
            (previous?.status === 'Paused' && previous) || tracks.find(track => track.status === 'Paused') ||
            previous || tracks[0] || null;
        this._onChange(this.current);
    }

    async position(track) {
        const result = await this._bus.call(track.proxy.g_name_owner, PATH, PROPERTIES, 'Get',
            new GLib.Variant('(ss)', [PLAYER, 'Position']), null,
            Gio.DBusCallFlags.NO_AUTO_START, 1500, this._cancel);
        return result.recursiveUnpack()[0] / 1e6;
    }

    async control(method) {
        const proxy = this.current?.proxy;
        if (!proxy)
            return;
        try {
            await proxy.call(method, null, Gio.DBusCallFlags.NO_AUTO_START, 2000, this._cancel);
        } catch (error) {
            if (!this._cancel.is_cancelled())
                console.warn(`RageNotch: ${method} failed: ${error.message}`);
        }
    }

    destroy() {
        this._cancel.cancel();
        this._bus.signal_unsubscribe(this._subscription);
        this._onChange = () => {};
        for (const name of this._players.keys())
            this._remove(name);
    }
}
