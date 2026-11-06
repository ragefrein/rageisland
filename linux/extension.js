import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {artworkColor, lyricAt, MediaAssets} from './assets.js';
import {loadConfig, saveTopPanelHidden} from './config.js';
import {MediaPlayers} from './media.js';
import {FocusTimer, SystemStatus, WhiteNoise} from './utilities.js';

const DEFAULT_COLOR = [122, 150, 133];
const timeNow = () => GLib.get_monotonic_time() / 1e6;
const SPOTIFY_ICON = new Gio.BytesIcon({bytes: new GLib.Bytes(new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<circle cx="16" cy="16" r="16" fill="#1ed760"/>' +
    '<path d="M7 12c6-2 13-1 18 2M8.5 16.5c5-1.5 10.5-.75 15 1.5M10 20.5c4-1 8-.5 11.5 1.5" ' +
    'fill="none" stroke="#080808" stroke-linecap="round" stroke-width="2.2"/></svg>',
))});
const MEDIA_ICON = new Gio.ThemedIcon({name: 'audio-x-generic-symbolic'});
const SIGNAL_LEVELS = [0.42, 0.73, 1, 0.55, 0.85, 0.34];
const SIGNAL_REST = [0.44, 1, 0.69];

function drawnIcon(path, color = '#111820') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
        <path d="${path}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    return new Gio.BytesIcon({bytes: new GLib.Bytes(new TextEncoder().encode(svg))});
}

const PLAY_PATH = 'M9 5.5 19 12 9 18.5Z';
const PAUSE_PATH = 'M9 6v12m6-12v12';
const FOCUS_ICONS = {
    start: drawnIcon(PLAY_PATH),
    pause: drawnIcon(PAUSE_PATH),
    reset: drawnIcon('M5 9a7.5 7.5 0 1 1 1.1 8.4M5 4.5V9h4.5'),
    break: drawnIcon('M5 10h12v3a6 6 0 0 1-12 0zm12 0h1.5a2 2 0 0 1 0 4H17M4 20h15M9 6V4m4 2V4'),
    focus: drawnIcon('M8 3h8m-4 0v3m5 1 2-2m0 8a7 7 0 1 1-14 0 7 7 0 0 1 14 0Zm-7-3v3l2 1'),
    noise: drawnIcon('M3 12h3l2-4 3 8 3-10 3 9 2-3h2'),
    mute: drawnIcon('M3 12h3l2-4 3 8 2-5m2 3 2 2 2-4h2M4 4l16 16'),
};
const BATTERY_ICON = drawnIcon('M4.5 8h13v8h-13zm15 2.5v3m-12-1.5h6.5');
const MEDIA_CONTROLS = {
    play: drawnIcon(PLAY_PATH, '#f7f7f7'),
    pause: drawnIcon(PAUSE_PATH, '#f7f7f7'),
    previous: drawnIcon('M7 6v12m10-12-8 6 8 6Z', '#f7f7f7'),
    stop: drawnIcon('M7 7h10v10H7Z', '#f7f7f7'),
    next: drawnIcon('M17 6v12M7 6l8 6-8 6Z', '#f7f7f7'),
};

function label(text, style_class) {
    const actor = new St.Label({text, style_class, y_align: Clutter.ActorAlign.CENTER});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function button(icon, accessible_name, callback, style_class = 'rage-control') {
    const actor = new St.Button({
        style_class, accessible_name, can_focus: true,
        child: new St.Icon({gicon: icon, icon_size: 16}),
    });
    actor.connect('clicked', callback);
    return actor;
}

function signalBars() {
    const bars = new St.BoxLayout({style_class: 'rage-signal', y_align: Clutter.ActorAlign.CENTER});
    for (const scale_y of SIGNAL_REST) {
        const bar = new St.Widget({height: 16, scale_y, style_class: 'rage-signal-bar'});
        bar.set_pivot_point(0.5, 1);
        bars.add_child(bar);
    }
    return bars;
}

function formatTime(seconds, minuteDigits = 1) {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = String(Math.floor(whole / 60)).padStart(minuteDigits, '0');
    return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

export default class RageNotch extends Extension {
    enable() {
        this._config = loadConfig();
        this._expanded = false;
        this._pinned = false;
        this._ignoreHover = false;
        this._position = 0;
        this._positionAt = timeNow();
        this._positionRequest ??= 0;
        this._nextSync = 0;
        this._color = DEFAULT_COLOR;
        this._autoNoiseActive = false;
        this._activePage = null;

        this._build();
        this._clock = new GnomeDesktop.WallClock();
        this._clock.connectObject('notify::clock', () => this._updateClock(), this._root);
        St.Settings.get().connectObject('notify::enable-animations', () => this._syncSignalAnimation(), this._root);
        this._updateClock();
        this._layout(false);
        Main.layoutManager.addTopChrome(this._root, {affectsStruts: false});
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._layout(false);
            this._updateVisibility();
        }, this._root);
        Main.layoutManager.panelBox.connectObject('notify::allocation', () => {
            this._syncTopPanel();
            this._place();
        }, this._root);
        Main.panel.connectObject('parent-set', () => this._updateVisibility(), this._root);
        Main.panel.statusArea.dateMenu?.menu.connectObject('open-state-changed',
            () => this._updateVisibility(), this._root);
        Main.overview.connectObject('showing', () => this._updateVisibility(), 'hidden',
            () => this._updateVisibility(), this._root);
        global.display.connectObject('in-fullscreen-changed', () => this._updateVisibility(), this._root);
        this._updateVisibility();
        this._startUtilities();

        if (this._config.media) {
            this._assets = new MediaAssets();
            this._media = new MediaPlayers(track => this._onTrack(track), position => {
                this._positionRequest++;
                this._setPosition(position);
                this._renderPosition();
            });
        }
    }

    _build() {
        this._root = new St.Widget({
            name: 'ragenotch',
            style_class: 'rage-notch',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
            layout_manager: new Clutter.FixedLayout(),
        });
        this._root.connect('notify::hover', () => this._onHover());

        this._header = new St.Button({style_class: 'rage-header', can_focus: true, accessible_name: 'Buka RageNotch'});
        this._header.connect('clicked', () => this._togglePinned());
        const header = new St.BoxLayout({style_class: 'rage-header-row', x_expand: true});
        this._indicator = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 14,
            style_class: 'rage-indicator', y_align: Clutter.ActorAlign.CENTER});
        this._compactBattery = new St.Icon({gicon: BATTERY_ICON, icon_size: 14, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'rage-battery-badge rage-battery-compact', visible: false});
        this._compactSignal = signalBars();
        this._compactTitle = label('RageNotch', 'rage-compact-title');
        this._compactTitle.x_expand = true;
        this._clockLabel = label('', 'rage-clock');
        this._headerStatus = label('', 'rage-header-status');
        this._compactSource = new St.Icon({gicon: MEDIA_ICON, icon_size: 12, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'rage-source rage-source-compact'});
        header.add_child(this._indicator);
        header.add_child(this._compactBattery);
        header.add_child(this._compactSignal);
        header.add_child(this._compactTitle);
        header.add_child(this._headerStatus);
        header.add_child(this._clockLabel);
        header.add_child(this._compactSource);
        this._header.set_child(header);
        this._root.add_child(this._header);

        this._buildMediaHeader();
        this._body = new St.BoxLayout({vertical: true, style_class: 'rage-body', visible: false});
        this._root.add_child(this._body);
        this._pages = new Map();
        this._tabs = new St.BoxLayout({style_class: 'rage-tabs'});
        this._body.add_child(this._tabs);
        this._mediaPage = new St.BoxLayout({vertical: true});
        if (this._config.media)
            this._addPage('media', 'Media', this._mediaPage);
        else {
            this._mediaPage.hide();
            this._body.add_child(this._mediaPage);
        }
        this._mediaView = new St.BoxLayout({vertical: true, style_class: 'rage-media', visible: false});
        this._mediaPage.add_child(this._mediaView);
        this._progress = new St.Widget({style_class: 'rage-progress', x_expand: true,
            layout_manager: new Clutter.FixedLayout()});
        this._progressFill = new St.Widget({style_class: 'rage-progress-fill', height: 3, width: 0});
        this._progress.add_child(this._progressFill);
        this._mediaView.add_child(this._progress);

        const controls = new St.BoxLayout({style_class: 'rage-controls'});
        this._elapsed = label('00:00', 'rage-time');
        this._duration = label('', 'rage-time');
        this._duration.x_align = Clutter.ActorAlign.END;
        const transport = new St.BoxLayout({style_class: 'rage-transport', x_align: Clutter.ActorAlign.CENTER,
            x_expand: true});
        this._previous = button(MEDIA_CONTROLS.previous, 'Lagu sebelumnya', () => this._media.control('Previous'));
        this._stop = button(MEDIA_CONTROLS.stop, 'Hentikan pemutaran', () => this._media.control('Stop'));
        this._next = button(MEDIA_CONTROLS.next, 'Lagu berikutnya', () => this._media.control('Next'));
        for (const control of [this._previous, this._stop, this._next])
            transport.add_child(control);
        controls.add_child(new St.Bin({width: 48, child: this._elapsed}));
        controls.add_child(transport);
        controls.add_child(new St.Bin({width: 48, child: this._duration}));
        this._mediaView.add_child(controls);

        this._lyricsCard = new St.BoxLayout({vertical: true, style_class: 'rage-lyrics'});
        this._lyricsCard.add_child(label('LIRIK SINKRON', 'rage-caption'));
        this._lyric = label('', 'rage-lyric');
        this._nextLyric = label('', 'rage-subtitle');
        this._lyricsCard.add_child(this._lyric);
        this._lyricsCard.add_child(this._nextLyric);
        this._mediaView.add_child(this._lyricsCard);

        this._idle = new St.BoxLayout({vertical: true, style_class: 'rage-idle'});
        this._idle.add_child(label('SEKARANG DIPUTAR', 'rage-caption'));
        this._idle.add_child(label(this._config.media ? 'Belum ada media' : 'Media dinonaktifkan', 'rage-track-title'));
        this._idle.add_child(label(this._config.media ? 'Putar musik atau video dari aplikasi yang mendukung MPRIS.' :
            'Aktifkan media_player di config.json.', 'rage-subtitle'));
        this._mediaPage.add_child(this._idle);
        if (this._config.pomodoro)
            this._buildFocus();
        if (this._config.calendar)
            this._buildAgenda();
        this._buildSystem();
        this._tabs.visible = this._pages.size > 1;
        this._selectPage(this._pages.keys().next().value);
        this._applyColor();
    }

    _buildMediaHeader() {
        this._mediaHeader = new St.BoxLayout({style_class: 'rage-media-header', visible: false});
        const details = new St.BoxLayout({style_class: 'rage-track-row', x_expand: true});
        this._mediaHeaderToggle = new St.Button({style_class: 'rage-header-toggle', child: details,
            x_expand: true, can_focus: true, accessible_name: 'Sematkan atau tutup RageNotch'});
        this._mediaHeaderToggle.connect('clicked', () => this._togglePinned());
        this._cover = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 48,
            style_class: 'rage-cover', y_align: Clutter.ActorAlign.CENTER});
        const meter = new St.BoxLayout({style_class: 'rage-meter', y_align: Clutter.ActorAlign.CENTER});
        this._mediaSignal = signalBars();
        this._mediaClock = label('', 'rage-clock');
        meter.add_child(this._mediaSignal);
        meter.add_child(this._mediaClock);
        const trackText = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._trackTitle = label('', 'rage-track-title');
        this._artist = label('', 'rage-subtitle');
        trackText.add_child(this._trackTitle);
        trackText.add_child(this._artist);
        details.add_child(this._cover);
        details.add_child(meter);
        details.add_child(trackText);
        this._play = button(MEDIA_CONTROLS.play, 'Putar', () => this._media.control('PlayPause'), 'rage-control rage-play');
        this._play.y_align = Clutter.ActorAlign.CENTER;
        this._mediaSource = new St.Icon({gicon: MEDIA_ICON, icon_size: 16, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'rage-source rage-source-media'});
        this._mediaHeader.add_child(this._mediaHeaderToggle);
        this._mediaHeader.add_child(this._play);
        this._mediaHeader.add_child(this._mediaSource);
        this._root.add_child(this._mediaHeader);
    }

    _addPage(id, title, view) {
        const tab = new St.Button({label: title, style_class: 'rage-tab', can_focus: true, x_expand: true});
        tab.connect('clicked', () => this._selectPage(id));
        view.hide();
        this._tabs.add_child(tab);
        this._body.add_child(view);
        this._pages.set(id, {tab, view});
    }

    _selectPage(id) {
        if (!id || this._activePage === id)
            return;
        this._activePage = id;
        for (const [key, {tab, view}] of this._pages) {
            view.visible = key === id;
            if (key === id)
                tab.add_style_pseudo_class('checked');
            else
                tab.remove_style_pseudo_class('checked');
        }
        if (this._expanded) {
            this._refreshAgenda();
            this._layout(true);
            this._refreshPlayback();
        }
    }

    _buildFocus() {
        const view = new St.BoxLayout({vertical: true, style_class: 'rage-utility-card'});
        const top = new St.BoxLayout({style_class: 'rage-utility-row'});
        this._focusPhase = label('', 'rage-caption');
        this._focusPhase.x_expand = true;
        this._focusTime = label('', 'rage-timer');
        top.add_child(this._focusPhase);
        top.add_child(this._focusTime);
        view.add_child(top);

        const actions = new St.BoxLayout({style_class: 'rage-focus-actions'});
        this._focusToggle = button(FOCUS_ICONS.start, 'Mulai', () => this._focus.toggle(),
            'rage-focus-action rage-focus-toggle');
        const reset = button(FOCUS_ICONS.reset, 'Ulangi', () => this._focus.reset(),
            'rage-focus-action rage-focus-reset');
        this._focusSwitch = button(FOCUS_ICONS.break, 'Ke istirahat', () => {
            this._focus.reset(this._focus.phase === 'focus' ? 'break' : 'focus');
        }, 'rage-focus-action rage-focus-break');
        this._noiseToggle = button(FOCUS_ICONS.noise, 'Putar white noise', () => {
            if (this._noise.playing)
                this._noise.stop();
            else
                this._noise.start();
        }, 'rage-focus-action rage-focus-noise');
        for (const control of [this._focusToggle, reset, this._focusSwitch, this._noiseToggle])
            actions.add_child(control);
        view.add_child(actions);
        this._addPage('focus', 'Fokus', view);
    }

    _buildAgenda() {
        this._agenda = new St.BoxLayout({vertical: true, style_class: 'rage-utility-card'});
        this._agendaDay = label('', 'rage-caption');
        this._agendaItems = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list'});
        const open = new St.Button({label: 'Buka kalender GNOME', style_class: 'rage-action',
            can_focus: true, x_align: Clutter.ActorAlign.START});
        open.connect('clicked', () => {
            this._pinned = false;
            this._ignoreHover = true;
            this._setExpanded(false);
            const menu = Main.panel.statusArea.dateMenu?.menu;
            if (menu) {
                this._restoreTopPanel();
                try {
                    menu.open();
                } finally {
                    this._updateVisibility();
                }
            }
        });
        this._agenda.add_child(this._agendaDay);
        this._agenda.add_child(this._agendaItems);
        this._agenda.add_child(open);
        this._addPage('agenda', 'Agenda', this._agenda);
    }

    _refreshAgenda() {
        const source = this._expanded && this._activePage === 'agenda' ?
            Main.panel.statusArea.dateMenu?._eventSource : null;
        if (source !== this._agendaSource) {
            this._agendaSource?.disconnectObject(this._root);
            this._agendaSource = source;
            source?.connectObject('changed', () => this._renderAgenda(true),
                'notify::has-calendars', () => this._renderAgenda(true), this._root);
        }
        if (this._expanded && this._activePage === 'agenda')
            this._renderAgenda(false);
    }

    _renderAgenda(relayout) {
        const source = this._agendaSource;
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        this._agendaDay.text = start.toLocaleDateString('id-ID', {
            weekday: 'long', day: 'numeric', month: 'long',
        }).toLocaleUpperCase('id-ID');
        let rows;
        if (!source?.hasCalendars) {
            rows = ['Kalender GNOME belum terhubung.'];
        } else if (!source._lastRequestBegin || start < source._lastRequestBegin || end > source._lastRequestEnd) {
            rows = ['Buka kalender GNOME untuk memuat agenda hari ini.'];
        } else {
            const events = source.getEvents(start, end);
            rows = events.slice(0, 4).map(event => {
                const time = event.date <= start && event.end >= end ? 'Seharian' :
                    new Intl.DateTimeFormat('id-ID', {hour: '2-digit', minute: '2-digit'}).format(event.date);
                return `${time}  ·  ${event.summary}`;
            });
            if (!rows.length)
                rows.push('Tidak ada acara hari ini.');
            else if (events.length > rows.length)
                rows.push(`+${events.length - rows.length} acara lainnya`);
        }
        this._setRows(this._agendaItems, rows, relayout);
    }

    _setRows(list, rows, relayout) {
        const children = list.get_children();
        if (children.length === rows.length && children.every((child, index) => child.text === rows[index]))
            return;
        list.destroy_all_children();
        for (const text of rows)
            list.add_child(label(text, 'rage-utility-detail'));
        if (relayout && children.length !== rows.length)
            this._layout(true);
    }

    _buildSystem() {
        const view = new St.BoxLayout({vertical: true, style_class: 'rage-utility-card'});
        if (this._config.battery) {
            const battery = new St.BoxLayout({style_class: 'rage-utility-row'});
            const icon = new St.Icon({gicon: BATTERY_ICON, icon_size: 19, y_align: Clutter.ActorAlign.CENTER,
                style_class: 'rage-battery-badge rage-battery-system'});
            const details = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER});
            this._batteryLabel = label('Baterai tidak tersedia.', 'rage-utility-detail');
            details.add_child(label('BATERAI', 'rage-caption'));
            details.add_child(this._batteryLabel);
            battery.add_child(icon);
            battery.add_child(details);
            view.add_child(battery);
        }
        if (this._config.bluetooth) {
            view.add_child(label('BLUETOOTH', 'rage-caption'));
            this._deviceList = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list'});
            view.add_child(this._deviceList);
            this._setRows(this._deviceList, ['Belum ada perangkat tersambung.'], false);
        }
        this._topPanelToggle = new St.Button({style_class: 'rage-action', can_focus: true,
            x_align: Clutter.ActorAlign.START});
        this._topPanelToggle.connect('clicked', () => {
            const hidden = !this._config.hideTopPanel;
            try {
                saveTopPanelHidden(hidden);
            } catch (error) {
                Main.notifyError('RageNotch tidak dapat menyimpan pengaturan panel', error.message);
                return;
            }
            this._config.hideTopPanel = hidden;
            this._updateVisibility();
        });
        view.add_child(this._topPanelToggle);
        this._addPage('system', 'Sistem', view);
    }

    _startUtilities() {
        if (this._config.pomodoro) {
            this._noise = new WhiteNoise(error => this._renderNoise(error));
            this._focus = new FocusTimer(this._config.focusMinutes, this._config.breakMinutes,
                timer => this._renderFocus(timer), phase => Main.notify('RageNotch',
                    phase === 'focus' ? 'Sesi fokus selesai. Waktunya istirahat.' : 'Istirahat selesai.'));
            this._renderNoise();
            this._renderFocus(this._focus);
        }
        if (this._config.battery || this._config.bluetooth) {
            this._system = new SystemStatus(this._config, () => this._renderSystem(), device => {
                const status = Number.isFinite(device.percentage) ? `${device.percentage}%` : 'ON';
                this._showIndicator('bluetooth-active-symbolic', device.name, status);
            });
        }
        if (this._config.systemHud)
            this._installHud();
    }

    _renderNoise(error) {
        const {available, playing} = this._noise;
        this._noiseToggle.reactive = this._noiseToggle.can_focus = available;
        this._noiseToggle.opacity = available ? 255 : 110;
        this._noiseToggle.child.gicon = playing ? FOCUS_ICONS.mute : FOCUS_ICONS.noise;
        this._noiseToggle.accessible_name = error ?? (!available ? 'White noise memerlukan GStreamer' :
            playing ? 'Matikan white noise' : 'Putar white noise');
        if (error)
            Main.notify('RageNotch', error);
    }

    _renderFocus(timer) {
        const focusing = timer.phase === 'focus';
        this._focusPhase.text = focusing ? 'WAKTU FOKUS' : 'ISTIRAHAT';
        this._focusTime.text = formatTime(Math.ceil(timer.remaining));
        this._focusToggle.child.gicon = timer.running ? FOCUS_ICONS.pause : FOCUS_ICONS.start;
        this._focusToggle.accessible_name = timer.running ? 'Jeda' : 'Mulai';
        if (timer.running)
            this._focusToggle.add_style_pseudo_class('checked');
        else
            this._focusToggle.remove_style_pseudo_class('checked');
        this._focusSwitch.child.gicon = focusing ? FOCUS_ICONS.break : FOCUS_ICONS.focus;
        this._focusSwitch.accessible_name = focusing ? 'Ke istirahat' : 'Ke fokus';
        const autoNoise = this._config.autoWhiteNoise && focusing && timer.running;
        if (autoNoise !== this._autoNoiseActive) {
            this._autoNoiseActive = autoNoise;
            if (autoNoise)
                this._noise.start();
            else
                this._noise.stop();
        }
        this._updateCompact();
    }

    _renderSystem() {
        const {battery, devices} = this._system;
        if (this._batteryLabel) {
            const status = {1: 'Mengisi daya', 2: 'Menggunakan baterai', 3: 'Kosong', 4: 'Penuh',
                5: 'Menunggu pengisian', 6: 'Menunggu pengosongan'};
            this._batteryLabel.text = battery ? `${battery.percentage}%  ·  ${status[battery.state] ?? 'Status daya tidak diketahui'}` :
                'Baterai tidak tersedia.';
        }
        if (this._deviceList) {
            const rows = devices.slice(0, 4).map(({name, percentage}) => Number.isFinite(percentage) ?
                `${name}  ·  ${percentage}%` : name);
            if (!rows.length)
                rows.push('Belum ada perangkat tersambung.');
            else if (devices.length > rows.length)
                rows.push(`+${devices.length - rows.length} perangkat lainnya`);
            this._setRows(this._deviceList, rows, this._expanded && this._activePage === 'system');
        }
        this._updateCompact();
    }

    _installHud() {
        const notch = this;
        this._hud = new InjectionManager();
        this._hud.overrideMethod(Main.osdWindowManager, 'show', original => function (monitor, icon, ...args) {
            const [text, level] = args;
            const iconName = icon instanceof Gio.ThemedIcon ? icon.get_names()[0] : '';
            const volume = iconName?.startsWith('audio-volume-');
            const brightness = iconName?.startsWith('display-brightness-');
            if ((volume || brightness) && (monitor === -1 || monitor === Main.layoutManager.primaryIndex) &&
                notch._showIndicator(iconName, text || (volume ? 'Volume' : 'Kecerahan'),
                    Number.isFinite(level) ? `${Math.round(level * 100)}%` : '')) {
                return;
            }
            return original.call(this, monitor, icon, ...args);
        });
    }

    _showIndicator(icon, title, value) {
        if (!this._root?.visible)
            return false;
        this._flash = {icon, title, value, gicon: new Gio.ThemedIcon({name: icon})};
        this._updateCompact();
        if (this._flashTimer)
            GLib.Source.remove(this._flashTimer);
        this._flashTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1900, () => {
            this._flashTimer = 0;
            this._flash = null;
            this._updateCompact();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }

    _updateClock() {
        const time = GLib.DateTime.new_now_local().format('%H:%M');
        this._clockLabel.text = this._mediaClock.text = time;
        if (this._expanded && this._activePage === 'agenda')
            this._renderAgenda(true);
    }

    _updateCompact() {
        const track = this._track;
        const battery = this._system?.battery;
        const focus = this._focus?.running ? this._focus : null;
        const showTrack = !!track && !focus && !this._flash;
        const showBattery = !!battery && !showTrack && !focus && !this._flash;
        this._compactSignal.visible = this._compactSource.visible = showTrack;
        this._compactBattery.visible = showBattery;
        this._indicator.visible = !showTrack && !showBattery;
        this._compactTitle.visible = !showTrack;
        this._clockLabel.x_expand = showTrack;
        this._indicator.icon_name = this._flash?.icon ?? (focus ? 'alarm-symbolic' : 'audio-x-generic-symbolic');
        this._compactTitle.text = this._flash?.title ?? (focus ? (focus.phase === 'focus' ? 'Fokus' : 'Istirahat') :
            battery ? `${battery.percentage}%` : 'RageNotch');
        this._headerStatus.text = this._flash?.value ?? (focus ? formatTime(Math.ceil(focus.remaining)) : '');
        this._headerStatus.visible = !!this._headerStatus.text;
        this._mediaSource.gicon = this._flash?.gicon ?? this._compactSource.gicon;
        if (track)
            this._artist.text = this._flash ? [this._flash.title, this._flash.value].filter(Boolean).join(' · ') :
                track.artist || 'Artis tidak diketahui';
        this._syncSignalAnimation();
    }

    _syncSignalAnimation() {
        const animate = this._root.visible && this._track?.playing && !this._config.instant &&
            St.Settings.get().enable_animations;
        const visibleSignal = this._mediaHeader.visible ? this._mediaSignal :
            this._compactSignal.visible ? this._compactSignal : null;
        const target = animate ? visibleSignal : null;
        if (target === this._signalTarget)
            return;
        this._stopSignalAnimation();
        if (!target)
            return;

        this._signalTarget = target;
        const bars = target.get_children();
        let phase = 0;
        this._signalTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            bars.forEach((bar, index) => bar.ease({
                scale_y: SIGNAL_LEVELS[(phase + index * 2) % SIGNAL_LEVELS.length],
                duration: 145,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            }));
            phase = (phase + 1) % SIGNAL_LEVELS.length;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSignalAnimation() {
        if (this._signalTimer)
            GLib.Source.remove(this._signalTimer);
        this._signalTimer = 0;
        this._signalTarget?.get_children().forEach((bar, index) => {
            bar.remove_transition('scale-y');
            bar.scale_y = SIGNAL_REST[index];
        });
        this._signalTarget = null;
    }

    _applyColor() {
        const rgb = this._color.join(', ');
        const radius = this._config.style === 'minimalist_pill' && !this._expanded ? 28 : this._config.radius;
        const corners = this._config.style === 'attached_notch' ? `0 0 ${radius}px ${radius}px` : `${radius}px`;
        const glow = this._config.glow && this._expanded && this._color !== DEFAULT_COLOR ?
            `box-shadow: inset 0 0 12px rgba(${rgb}, 0.12);` : '';
        this._root.set_style(`border-radius: ${corners}; ${glow}`);
        this._progressFill?.set_style(`background-color: rgb(${rgb});`);
    }

    _layout(animate) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const compactWidth = this._config.style === 'minimalist_pill' ?
            Math.min(this._config.compactWidth, 158) : this._config.compactWidth;
        const maxWidth = Math.max(1, monitor.width - 24);
        const width = Math.min(maxWidth, this._expanded ? this._config.expandedWidth : compactWidth);
        const showMediaHeader = this._expanded && this._activePage === 'media' && !!this._track;
        this._mediaHeader.visible = showMediaHeader;
        this._header.visible = !showMediaHeader;
        this._syncSignalAnimation();
        const compactHeight = this._config.style === 'minimalist_pill' && !this._expanded ? 30 : 38;
        const headerHeight = showMediaHeader ? 76 : compactHeight;
        this._header.height = headerHeight - 2;
        this._mediaHeader.height = headerHeight - 2;
        this._body.set_position(0, headerHeight - 2);
        this._body.width = Math.max(1, width - 2);
        this._body.visible = this._expanded;
        this._applyColor();
        const height = headerHeight + (this._expanded ?
            this._body.get_preferred_height(this._body.width)[1] : 0);

        if (this._timeline?.is_playing())
            this._timeline.stop();
        const animationsEnabled = St.Settings.get().enable_animations;
        if (!animate || !animationsEnabled || this._config.instant || !this._root.width) {
            this._resize(width, height);
            return;
        }
        this._timeline ??= Clutter.Timeline.new_for_actor(this._root, 1800);
        if (this._frame)
            this._timeline.disconnect(this._frame);
        if (this._completed)
            this._timeline.disconnect(this._completed);
        let x = this._root.width;
        let y = this._root.height;
        let vx = 0;
        let vy = 0;
        const {stiffness, damping} = this._config;
        this._frame = this._timeline.connect('new-frame', timeline => {
            const delta = Math.min(0.05, timeline.get_delta() / 1000);
            const steps = Math.max(1, Math.ceil(delta * 240));
            const dt = delta / steps;
            for (let step = 0; step < steps; step++) {
                vx += (stiffness * (width - x) - damping * vx) * dt;
                vy += (stiffness * (height - y) - damping * vy) * dt;
                x += vx * dt;
                y += vy * dt;
            }
            if (Math.abs(x - width) + Math.abs(y - height) < 0.6 && Math.abs(vx) + Math.abs(vy) < 5) {
                this._resize(width, height);
                timeline.stop();
            } else {
                this._resize(Math.min(maxWidth, x), y);
            }
        });
        this._completed = this._timeline.connect('completed', () => this._resize(width, height));
        this._timeline.rewind();
        this._timeline.start();
    }

    _resize(width, height) {
        const roundedWidth = Math.max(1, Math.round(width));
        this._root.set_size(roundedWidth, Math.max(1, Math.round(height)));
        this._header.width = Math.max(1, roundedWidth - 2);
        this._mediaHeader.width = this._header.width;
        this._place();
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const panel = Main.layoutManager.panelBox;
        const [panelX, panelY] = panel.get_transformed_position();
        const panelAtTop = panel.visible && !this._hiddenTopPanel && Math.abs(panelY - monitor.y) < 2 &&
            panelX < monitor.x + monitor.width && panelX + panel.width > monitor.x;
        const margin = this._config.style === 'attached_notch' ? 0 : this._config.margin;
        const {position} = this._config;
        const left = position === 'top_left' ? 12 : position === 'top_right' ?
            monitor.width - this._root.width - 12 : (monitor.width - this._root.width) / 2;
        this._root.set_position(monitor.x + Math.round(left), monitor.y + (panelAtTop ? panel.height : 0) + margin);
    }

    _updateVisibility() {
        this._syncTopPanel();
        const monitor = Main.layoutManager.primaryMonitor;
        const visible = !!monitor && !Main.overview.visible && Main.sessionMode.hasWindows &&
            !(this._config.hideFullscreen && monitor.inFullscreen) &&
            !(this._config.hideTopPanel && Main.panel.statusArea.dateMenu?.menu.isOpen);
        const visibilityChanged = this._root.visible !== visible;
        this._root.visible = visible;
        if (!visible) {
            this._pinned = false;
            this._ignoreHover = false;
            this._clearHover();
            this._setExpanded(false, false);
        }
        if (visibilityChanged)
            this._refreshPlayback();
        this._syncSignalAnimation();
        this._place();
    }

    _syncTopPanel() {
        const {panelBox, primaryMonitor} = Main.layoutManager;
        const panel = Main.panel;
        const [, y] = panelBox.get_transformed_position();
        // Keep a combined Zorin taskbar alone. Only collapse the stock panel
        // inside the shell's top box so its reserved height disappears too.
        const supported = !!primaryMonitor && panel.get_parent() === panelBox &&
            Math.abs(y - primaryMonitor.y) < 2;
        this._topPanelToggle.visible = supported;
        this._topPanelToggle.label = this._config.hideTopPanel ? 'Tampilkan panel atas' : 'Sembunyikan panel atas';
        const hide = supported && this._config.hideTopPanel && Main.sessionMode.hasWindows &&
            !Main.overview.visible && !panel.statusArea.dateMenu?.menu.isOpen;
        if (hide && panel.visible) {
            this._hiddenTopPanel ??= {panel, panelBox, clipToAllocation: panelBox.clip_to_allocation};
            // Panel effects can paint outside their zero-height background actors.
            panelBox.clip_to_allocation = true;
            panel.hide();
        } else if (!hide) {
            this._restoreTopPanel();
        }
    }

    _restoreTopPanel() {
        const hidden = this._hiddenTopPanel;
        this._hiddenTopPanel = null;
        if (hidden) {
            hidden.panelBox.clip_to_allocation = hidden.clipToAllocation;
            hidden.panel.show();
        }
    }

    _clearHover() {
        if (this._hoverTimer)
            GLib.Source.remove(this._hoverTimer);
        this._hoverTimer = 0;
    }

    _onHover() {
        this._clearHover();
        if (!this._root.hover) {
            this._ignoreHover = false;
            if (!this._pinned)
                this._setExpanded(false);
        } else if (!this._ignoreHover && this._config.expandOnHover && !this._expanded) {
            this._hoverTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._config.hoverDelay, () => {
                this._hoverTimer = 0;
                this._setExpanded(true);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _togglePinned() {
        this._clearHover();
        this._pinned = !this._pinned;
        this._ignoreHover = !this._pinned;
        this._setExpanded(this._pinned);
    }

    _setExpanded(expanded, animate = true) {
        if (this._expanded === expanded)
            return;
        this._expanded = expanded;
        this._header.accessible_name = expanded ? 'RageNotch terbuka' : 'Buka RageNotch';
        this._refreshAgenda();
        this._layout(animate);
        this._refreshPlayback();
    }

    _onTrack(track) {
        const old = this._track;
        const changed = old?.proxy !== track?.proxy || old?.id !== track?.id || old?.title !== track?.title ||
            old?.lookupArtist !== track?.lookupArtist || old?.album !== track?.album || old?.duration !== track?.duration;
        this._setPosition(changed ? 0 : this._currentPosition());
        this._track = track;
        if (old?.name !== track?.name) {
            const spotify = /^org\.mpris\.MediaPlayer2\.spotify(?:d|[.-]|$)/i.test(track?.name ?? '');
            this._compactSource.gicon = spotify ? SPOTIFY_ICON : MEDIA_ICON;
            this._compactSource.icon_size = spotify ? 22 : 12;
            this._mediaSource.icon_size = spotify ? 32 : 16;
            for (const source of [this._compactSource, this._mediaSource]) {
                if (spotify)
                    source.add_style_class_name('rage-source-spotify');
                else
                    source.remove_style_class_name('rage-source-spotify');
            }
        }
        for (const signal of [this._compactSignal, this._mediaSignal])
            signal.opacity = track?.playing ? 255 : 92;
        this._updateCompact();
        this._mediaView.visible = !!track;
        this._idle.visible = !track;
        this._lyricsCard.visible = this._config.lyrics;
        if (track) {
            this._trackTitle.text = track.title;
            this._duration.text = track.duration > 0 ? formatTime(track.duration, 2) : '–:––';
            this._play.child.gicon = track.playing ? MEDIA_CONTROLS.pause : MEDIA_CONTROLS.play;
            this._play.accessible_name = track.playing ? 'Jeda' : 'Putar';
            for (const [control, enabled] of [[this._play, track.playPause], [this._previous, track.previous],
                [this._stop, track.stop], [this._next, track.next]]) {
                control.reactive = control.can_focus = enabled;
                control.opacity = enabled ? 255 : 92;
            }
        }
        if (changed) {
            this._stopLyrics();
            this._lyricResult = null;
        }
        if (old?.art !== track?.art)
            this._updateArtwork(track?.art);
        if (this._expanded && this._activePage === 'media' && !!old !== !!track)
            this._layout(true);
        if (changed || old?.status !== track?.status || old?.rate !== track?.rate)
            this._refreshPlayback();
    }

    async _updateArtwork(uri) {
        this._artCancel?.cancel();
        this._artCancel = null;
        this._cover.gicon = null;
        this._cover.icon_name = 'audio-x-generic-symbolic';
        this._color = DEFAULT_COLOR;
        this._applyColor();
        if (!uri)
            return;
        const cancel = new Gio.Cancellable();
        this._artCancel = cancel;
        try {
            const pixbuf = await this._assets.artwork(uri, cancel);
            if (!pixbuf || cancel.is_cancelled())
                return;
            const image = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
            image.set_data(pixbuf.get_pixels(), pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 :
                Cogl.PixelFormat.RGB_888, pixbuf.width, pixbuf.height, pixbuf.get_rowstride());
            this._cover.gicon = image;
            if (this._config.glow) {
                this._color = artworkColor(pixbuf);
                this._applyColor();
            }
        } catch {
            // Some players expose temporary artwork URLs. Keep the fallback icon.
        }
    }

    _refreshPlayback() {
        if (this._tick)
            GLib.Source.remove(this._tick);
        this._tick = 0;
        this._positionRequest++;
        if (!this._root.visible || !this._mediaHeader.visible || !this._track) {
            this._stopLyrics();
            return;
        }

        this._syncPosition();
        this._renderPosition();
        this._loadLyrics();
        if (this._track.playing) {
            this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 125, () => {
                if (timeNow() >= this._nextSync)
                    this._syncPosition();
                this._renderPosition();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _setPosition(position) {
        this._position = position;
        this._positionAt = timeNow();
    }

    _currentPosition() {
        const elapsed = this._track?.playing ? (timeNow() - this._positionAt) * this._track.rate : 0;
        return Math.max(0, Math.min(this._track?.duration || Infinity, this._position + elapsed));
    }

    async _syncPosition() {
        const request = ++this._positionRequest;
        this._nextSync = timeNow() + 4;
        try {
            const position = await this._media.position(this._track);
            if (request === this._positionRequest && Number.isFinite(position)) {
                this._setPosition(position);
                this._renderPosition();
            }
        } catch {
            // Some players omit Position. Continue from the latest known position.
        }
    }

    _renderPosition() {
        if (!this._track || !this._root.visible || !this._mediaHeader.visible)
            return;
        const position = this._currentPosition();
        const elapsed = formatTime(position, 2);
        if (this._elapsed.text !== elapsed)
            this._elapsed.text = elapsed;
        const barWidth = Math.max(0, this._body.width - 28);
        this._progressFill.width = this._track.duration ? Math.round(barWidth * position / this._track.duration) : 0;
        if (!this._config.lyrics)
            return;
        const lines = this._lyricResult?.lines;
        const index = lines?.length ? lyricAt(lines, position) : -1;
        const current = lines?.length ? lines[index]?.text ?? '' : this._lyricResult?.message ?? 'Memuat lirik…';
        const next = lines?.[index + 1]?.text ?? '';
        if (this._lyric.text !== current)
            this._lyric.text = current;
        if (this._nextLyric.text !== next)
            this._nextLyric.text = next;
    }

    _stopLyrics() {
        if (this._lyricsTimer)
            GLib.Source.remove(this._lyricsTimer);
        this._lyricsTimer = 0;
        this._lyricsCancel?.cancel();
        this._lyricsCancel = null;
    }

    _loadLyrics() {
        if (!this._config.lyrics || this._lyricResult || this._lyricsTimer || this._lyricsCancel)
            return;
        const track = this._track;
        this._lyricsTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
            this._lyricsTimer = 0;
            this._fetchLyrics(track);
            return GLib.SOURCE_REMOVE;
        });
    }

    async _fetchLyrics(track) {
        const cancel = new Gio.Cancellable();
        this._lyricsCancel = cancel;
        let result;
        try {
            result = await this._assets.lyrics(track, cancel);
        } catch {
            result = {message: 'LRCLIB tidak dapat dijangkau.', retry: true};
        }
        if (!cancel.is_cancelled()) {
            this._lyricsCancel = null;
            this._lyricResult = result;
            this._renderPosition();
            if (result.retry)
                this._lyricResult = null;
        }
    }

    disable() {
        this._clearHover();
        this._stopLyrics();
        this._stopSignalAnimation();
        this._hud?.clear();
        this._hud = null;
        this._focus?.destroy();
        this._noise?.stop();
        this._system?.destroy();
        this._focus = this._noise = this._system = null;
        this._agendaSource?.disconnectObject(this._root);
        this._agendaSource = this._batteryLabel = this._deviceList = null;
        if (this._flashTimer)
            GLib.Source.remove(this._flashTimer);
        this._flashTimer = 0;
        this._flash = null;
        this._artCancel?.cancel();
        this._artCancel = null;
        if (this._tick)
            GLib.Source.remove(this._tick);
        this._tick = 0;
        this._positionRequest++;
        this._timeline?.stop();
        this._timeline = null;
        this._frame = this._completed = 0;
        this._media?.destroy();
        this._assets?.destroy();
        this._media = this._assets = this._track = this._lyricResult = null;
        this._clock = null;
        this._root?.destroy();
        this._root = null;
        this._restoreTopPanel();
    }
}
