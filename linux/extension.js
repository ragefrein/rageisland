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

const DEFAULT_COLOR = [149, 164, 243];
const timeNow = () => GLib.get_monotonic_time() / 1e6;

function label(text, style_class) {
    const actor = new St.Label({text, style_class, y_align: Clutter.ActorAlign.CENTER});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function button(icon, accessible_name, callback, style_class = 'rage-control') {
    const actor = new St.Button({
        style_class, accessible_name, can_focus: true,
        child: new St.Icon({icon_name: icon, icon_size: 16}),
    });
    actor.connect('clicked', callback);
    return actor;
}

function formatTime(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
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
        const header = new St.BoxLayout({style_class: 'rage-header-row'});
        this._indicator = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 14,
            style_class: 'rage-indicator', y_align: Clutter.ActorAlign.CENTER});
        this._compactTitle = label('RageNotch', 'rage-compact-title');
        this._compactTitle.x_expand = true;
        this._clockLabel = label('', 'rage-clock');
        header.add_child(this._indicator);
        header.add_child(this._compactTitle);
        header.add_child(this._clockLabel);
        this._header.set_child(header);
        this._root.add_child(this._header);

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
        const trackRow = new St.BoxLayout({style_class: 'rage-track-row'});
        this._cover = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 42,
            style_class: 'rage-cover', y_align: Clutter.ActorAlign.CENTER});
        trackRow.add_child(this._cover);
        const trackText = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._trackTitle = label('', 'rage-track-title');
        this._artist = label('', 'rage-subtitle');
        trackText.add_child(this._trackTitle);
        trackText.add_child(this._artist);
        trackRow.add_child(trackText);
        this._mediaView.add_child(trackRow);

        this._progress = new St.Widget({style_class: 'rage-progress', x_expand: true,
            layout_manager: new Clutter.FixedLayout()});
        this._progressFill = new St.Widget({style_class: 'rage-progress-fill', height: 3, width: 0});
        this._progress.add_child(this._progressFill);
        this._mediaView.add_child(this._progress);

        const controls = new St.BoxLayout({style_class: 'rage-controls'});
        this._elapsed = label('0:00', 'rage-time');
        this._duration = label('–:––', 'rage-time');
        this._elapsed.x_expand = this._duration.x_expand = true;
        this._duration.x_align = Clutter.ActorAlign.END;
        this._previous = button('media-skip-backward-symbolic', 'Lagu sebelumnya', () => this._media.control('Previous'));
        this._play = button('media-playback-start-symbolic', 'Putar', () => this._media.control('PlayPause'), 'rage-control rage-play');
        this._next = button('media-skip-forward-symbolic', 'Lagu berikutnya', () => this._media.control('Next'));
        for (const actor of [this._elapsed, this._previous, this._play, this._next, this._duration])
            controls.add_child(actor);
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

        const actions = new St.BoxLayout({style_class: 'rage-utility-row'});
        const action = (text, callback) => {
            const control = new St.Button({label: text, style_class: 'rage-action', can_focus: true});
            control.connect('clicked', callback);
            actions.add_child(control);
            return control;
        };
        this._focusToggle = action('Mulai', () => this._focus.toggle());
        action('Ulangi', () => this._focus.reset());
        this._focusSwitch = action('Ke istirahat', () => {
            this._focus.reset(this._focus.phase === 'focus' ? 'break' : 'focus');
        });
        view.add_child(actions);
        this._noiseToggle = new St.Button({label: 'Putar white noise', style_class: 'rage-action',
            can_focus: true, x_align: Clutter.ActorAlign.START});
        this._noiseToggle.connect('clicked', () => {
            if (this._noise.playing)
                this._noise.stop();
            else
                this._noise.start();
        });
        view.add_child(this._noiseToggle);
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
            view.add_child(label('BATERAI', 'rage-caption'));
            this._batteryLabel = label('Baterai tidak tersedia.', 'rage-utility-detail');
            view.add_child(this._batteryLabel);
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
        this._noiseToggle.label = error ?? (!available ? 'White noise memerlukan GStreamer' :
            playing ? 'Matikan white noise' : 'Putar white noise');
    }

    _renderFocus(timer) {
        const focusing = timer.phase === 'focus';
        this._focusPhase.text = focusing ? 'WAKTU FOKUS' : 'ISTIRAHAT';
        this._focusTime.text = formatTime(Math.ceil(timer.remaining));
        this._focusToggle.label = timer.running ? 'Jeda' : 'Mulai';
        this._focusSwitch.label = focusing ? 'Ke istirahat' : 'Ke fokus';
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
        this._flash = {icon, title, value};
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
        this._timeText = GLib.DateTime.new_now_local().format('%H:%M');
        this._updateCompact();
        if (this._expanded && this._activePage === 'agenda')
            this._renderAgenda(true);
    }

    _updateCompact() {
        const track = this._track;
        const battery = this._system?.battery;
        const focus = this._focus?.running ? this._focus : null;
        this._indicator.icon_name = this._flash?.icon ?? (focus ? 'alarm-symbolic' :
            track ? (track.playing ? 'media-playback-start-symbolic' : 'audio-x-generic-symbolic') :
                battery ? 'battery-symbolic' : 'audio-x-generic-symbolic');
        this._compactTitle.text = this._flash?.title ?? (focus ? (focus.phase === 'focus' ? 'Fokus' : 'Istirahat') :
            track?.title ?? (battery ? `Baterai ${battery.percentage}%` : 'RageNotch'));
        this._clockLabel.text = this._flash?.value ?? (focus ? formatTime(Math.ceil(focus.remaining)) : this._timeText ?? '');
    }

    _applyColor() {
        const rgb = this._color.join(', ');
        const radius = this._config.style === 'minimalist_pill' && !this._expanded ? 28 : this._config.radius;
        const corners = this._config.style === 'attached_notch' ? `0 0 ${radius}px ${radius}px` : `${radius}px`;
        const glow = this._config.glow ? `box-shadow: inset 0 0 16px rgba(${rgb}, 0.20);` : '';
        this._root.set_style(`border-radius: ${corners}; border-color: rgba(${rgb}, 0.38); ${glow}`);
        this._indicator.set_style(`color: rgb(${rgb});`);
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
        const headerHeight = this._config.style === 'minimalist_pill' && !this._expanded ? 30 : 38;
        this._header.height = headerHeight - 2;
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
        if (!visible) {
            this._pinned = false;
            this._ignoreHover = false;
            this._clearHover();
            this._setExpanded(false, false);
        }
        this._root.visible = visible;
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
        this._updateCompact();
        this._mediaView.visible = !!track;
        this._idle.visible = !track;
        this._lyricsCard.visible = this._config.lyrics;
        if (track) {
            this._trackTitle.text = track.title;
            this._artist.text = track.artist || 'Artis tidak diketahui';
            this._duration.text = track.duration > 0 ? formatTime(track.duration) : '–:––';
            this._play.child.icon_name = track.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
            this._play.accessible_name = track.playing ? 'Jeda' : 'Putar';
            for (const [control, enabled] of [[this._play, track.playPause], [this._previous, track.previous], [this._next, track.next]]) {
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
        if (!this._expanded || this._activePage !== 'media' || !this._track) {
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
        if (!this._track || !this._expanded || this._activePage !== 'media')
            return;
        const position = this._currentPosition();
        const elapsed = formatTime(position);
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
