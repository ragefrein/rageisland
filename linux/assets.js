import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');
Gio._promisify(GdkPixbuf.Pixbuf, 'new_from_stream_at_scale_async', 'new_from_stream_finish');
Gio._promisify(Soup.Session.prototype, 'send_async', 'send_finish');
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

export function parseLyrics(source) {
    const offset = Number(source.match(/\[offset:\s*([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
    const lines = [];
    for (const line of source.split(/\r?\n/)) {
        const marks = [...line.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
        if (!marks.length)
            continue;
        const last = marks[marks.length - 1];
        const text = line.slice(last.index + last[0].length).trim();
        for (const [, minutes, seconds, fraction] of marks) {
            const time = Number(minutes) * 60 + Number(seconds) + Number(`0.${fraction ?? '0'}`);
            lines.push({time: time - offset, text});
        }
    }
    return lines.sort((a, b) => a.time - b.time);
}

export function lyricAt(lines, position) {
    let low = 0;
    let high = lines.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (lines[mid].time <= position)
            low = mid + 1;
        else
            high = mid;
    }
    return low - 1;
}

export class MediaAssets {
    constructor() {
        this._session = new Soup.Session({timeout: 8, user_agent: 'RageNotch/0.1'});
        this._lyricsCache = new Map();
        this._lyricsRetryAfter = 0;
    }

    async lyrics(track, cancel) {
        if (!track.lookupArtist)
            return {message: 'Artis lagu tidak tersedia.'};

        const fields = {track_name: track.title, artist_name: track.lookupArtist};
        if (track.album)
            fields.album_name = track.album;
        if (track.duration >= 1 && track.duration <= 3600)
            fields.duration = track.duration.toFixed(2);
        const query = Object.entries(fields).map(([key, value]) =>
            `${key}=${encodeURIComponent(value)}`).join('&');

        if (this._lyricsCache.has(query))
            return this._lyricsCache.get(query);
        if (GLib.get_monotonic_time() < this._lyricsRetryAfter)
            return {message: 'LRCLIB sibuk. Coba buka lagi nanti.', retry: true};

        const request = Soup.Message.new('GET', `https://lrclib.net/api/get?${query}`);
        const bytes = await this._session.send_and_read_async(request, GLib.PRIORITY_DEFAULT, cancel);
        const status = request.get_status();
        if (status === 429 || status === 503) {
            const header = request.get_response_headers().get_one('Retry-After');
            const wait = /^\d+$/.test(header ?? '') ? Number(header) :
                Math.max(1, (Date.parse(header) - Date.now()) / 1000) || 60;
            this._lyricsRetryAfter = GLib.get_monotonic_time() + (wait + Math.random() * 0.3 * wait) * 1e6;
            return {message: 'LRCLIB sibuk. Coba buka lagi nanti.', retry: true};
        }
        if (status !== 200 && status !== 404)
            throw new Error(`LRCLIB HTTP ${status}`);
        const body = status === 200 ? JSON.parse(new TextDecoder().decode(bytes.get_data())) : {};
        const lines = parseLyrics(body.syncedLyrics ?? '');
        const result = {lines, message: body.instrumental ? 'Lagu instrumental.' : 'Lirik sinkron tidak tersedia.'};
        if (this._lyricsCache.size >= 24)
            this._lyricsCache.delete(this._lyricsCache.keys().next().value);
        this._lyricsCache.set(query, result);
        return result;
    }

    async artwork(uri, cancel) {
        let stream;
        try {
            if (uri.startsWith('file://')) {
                const file = Gio.File.new_for_uri(uri);
                if (!file.is_native())
                    return null;
                stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancel);
            } else if (/^https?:\/\//i.test(uri)) {
                const request = Soup.Message.new('GET', uri);
                stream = await this._session.send_async(request, GLib.PRIORITY_DEFAULT, cancel);
                if (request.get_status() !== 200)
                    return null;
            } else {
                return null;
            }
            return await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, 64, 64, true, cancel);
        } finally {
            if (stream)
                await stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
    }

    destroy() {
        this._session.abort();
    }
}

export function artworkColor(pixbuf) {
    const pixels = pixbuf.get_pixels();
    const channels = pixbuf.get_n_channels();
    const stride = pixbuf.get_rowstride();
    const colors = new Map();
    for (let y = 0; y < pixbuf.height; y += 2) {
        for (let x = 0; x < pixbuf.width; x += 2) {
            const i = y * stride + x * channels;
            if (channels === 4 && pixels[i + 3] < 128)
                continue;
            const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]];
            const saturation = Math.max(...rgb) - Math.min(...rgb);
            const key = rgb.map(value => value >> 5).join(',');
            const bin = colors.get(key) ?? {score: 0, rgb};
            bin.score += 32 + saturation;
            colors.set(key, bin);
        }
    }
    let best = {score: 0, rgb: [126, 144, 222]};
    for (const color of colors.values()) {
        if (color.score > best.score)
            best = color;
    }
    return best.rgb.map(value => Math.round(0.72 * value + 65));
}
