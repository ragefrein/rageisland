import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeDesktop from 'gi://GnomeDesktop';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {artworkColor, lyricAt, MediaAssets, roundedPixels, TablerIcons} from './assets.js';
import {loadConfig, saveAppearanceStyle, saveDeveloperRepo, saveLyricAutoWidth, saveShelfPaths, saveTopPanelHidden} from './config.js';
import {MediaPlayers} from './media.js';
import {chooseLocalPath, ClipboardShelf, developerSockets, editorName, FocusTimer, gitProject,
    stopLocalServer, systemSample, SystemStatus, WhiteNoise} from './utilities.js';

const DEFAULT_COLOR = [122, 150, 133];
const timeNow = () => GLib.get_monotonic_time() / 1e6;
const SIGNAL_LEVELS = [0.42, 0.73, 1, 0.55, 0.85, 0.34];
const SIGNAL_REST = [0.44, 1, 0.69];

function label(text, style_class) {
    const actor = new St.Label({text, style_class, y_align: Clutter.ActorAlign.CENTER});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function lyricLabel(styleClass) {
    const actor = label('', styleClass);
    actor.clutter_text.single_line_mode = false;
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    actor.clutter_text.line_wrap = true;
    actor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return actor;
}

function lyricWidth(actor) {
    if (!actor.text)
        return 0;
    const layout = actor.clutter_text.get_layout().copy();
    layout.set_width(-1);
    return layout.get_pixel_size()[0];
}

function button(icon, accessible_name, callback, style_class = 'rage-control', icon_size = 16) {
    const actor = new St.Button({
        style_class, accessible_name, can_focus: true,
        child: new St.Icon({gicon: icon, icon_size}),
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
        this._calendarMonthKey = null;
        this._agendaDate = new Date();
        this._shelfMode = 'files';

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
            (_menu, isOpen) => {
                this._updateVisibility();
                if (!isOpen && this._expanded && this._activePage === 'agenda')
                    this._refreshAgenda();
            }, this._root);
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
        this._indicator = new St.Icon({gicon: TablerIcons.media, icon_size: 14,
            style_class: 'rage-indicator', y_align: Clutter.ActorAlign.CENTER});
        this._compactBatteryDial = this._makeDial(TablerIcons.bolt, 22, [0.24, 0.88, 0.50]);
        this._compactBattery = this._compactBatteryDial.actor;
        this._compactBattery.hide();
        this._compactSignal = signalBars();
        this._compactTitle = label('RageNotch', 'rage-compact-title');
        this._compactTitle.x_expand = true;
        this._clockLabel = label('', 'rage-clock');
        this._headerStatus = label('', 'rage-header-status');
        this._compactSource = new St.Icon({gicon: TablerIcons.media, icon_size: 12, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'rage-source rage-source-compact'});
        this._compactLyric = lyricLabel('rage-compact-lyric');
        this._compactLyric.x_expand = true;
        this._compactLyric.hide();
        header.add_child(this._indicator);
        header.add_child(this._compactBattery);
        header.add_child(this._compactSignal);
        header.add_child(this._compactTitle);
        header.add_child(this._headerStatus);
        header.add_child(this._clockLabel);
        header.add_child(this._compactSource);
        header.add_child(this._compactLyric);
        this._header.set_child(header);
        this._root.add_child(this._header);

        this._body = new St.BoxLayout({vertical: true, style_class: 'rage-body', visible: false});
        this._root.add_child(this._body);
        this._pages = new Map();
        this._tabs = new St.BoxLayout({style_class: 'rage-tabs', reactive: true, track_hover: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._tabs.connect('notify::hover', () => this._updatePageIndicators());
        const footer = new St.BoxLayout({style_class: 'rage-footer'});
        footer.add_child(new St.Widget({width: 28}));
        footer.add_child(new St.Bin({child: this._tabs, x_expand: true}));
        const settings = button(TablerIcons.system, 'Pengaturan RageNotch', () => this._openPreferences(), 'rage-settings');
        settings.y_align = Clutter.ActorAlign.CENTER;
        footer.add_child(settings);
        this._mediaPage = new St.BoxLayout({vertical: true});
        if (this._config.media)
            this._addPage('media', 'Media', this._mediaPage);
        else {
            this._mediaPage.hide();
            this._body.add_child(this._mediaPage);
        }
        this._mediaView = new St.BoxLayout({style_class: 'rage-media-split', visible: false});
        this._mediaPage.add_child(this._mediaView);
        const media = new St.BoxLayout({vertical: true, style_class: 'rage-media', x_expand: true});
        this._mediaView.add_child(media);
        this._buildMediaHeader();
        media.add_child(this._mediaHeader);
        this._progress = new St.Widget({style_class: 'rage-progress', x_expand: true,
            layout_manager: new Clutter.FixedLayout()});
        this._progressFill = new St.Widget({style_class: 'rage-progress-fill', height: 3, width: 0});
        this._progress.add_child(this._progressFill);
        media.add_child(this._progress);

        const controls = new St.BoxLayout({style_class: 'rage-controls'});
        this._elapsed = label('00:00', 'rage-time');
        this._duration = label('', 'rage-time');
        this._duration.x_align = Clutter.ActorAlign.END;
        const transport = new St.BoxLayout({style_class: 'rage-transport', x_align: Clutter.ActorAlign.CENTER,
            x_expand: true});
        this._previous = button(TablerIcons.previous, 'Lagu sebelumnya', () => this._media.control('Previous'));
        this._play = button(TablerIcons.play, 'Putar', () => this._media.control('PlayPause'), 'rage-control rage-play');
        this._stop = button(TablerIcons.stop, 'Hentikan pemutaran', () => this._media.control('Stop'));
        this._next = button(TablerIcons.next, 'Lagu berikutnya', () => this._media.control('Next'));
        for (const control of [this._previous, this._play, this._stop, this._next])
            transport.add_child(control);
        controls.add_child(new St.Bin({width: 32, child: this._elapsed}));
        controls.add_child(transport);
        controls.add_child(new St.Bin({width: 32, child: this._duration}));
        media.add_child(controls);

        this._lyricsCard = new St.BoxLayout({vertical: true, style_class: 'rage-lyrics', clip_to_allocation: true});
        this._lyric = lyricLabel('rage-lyric');
        this._nextLyric = lyricLabel('rage-subtitle');
        this._lyricsCard.add_child(this._lyric);
        this._lyricsCard.add_child(this._nextLyric);
        this._mediaView.add_child(this._lyricsCard);

        this._idle = new St.BoxLayout({vertical: true, style_class: 'rage-idle'});
        this._idle.add_child(new St.Icon({gicon: TablerIcons.media, icon_size: 24, opacity: 145,
            x_align: Clutter.ActorAlign.CENTER}));
        this._idle.add_child(label('Belum ada media', 'rage-subtitle rage-idle-title'));
        this._mediaPage.add_child(this._idle);
        if (this._config.pomodoro)
            this._buildFocus();
        if (this._config.calendar)
            this._buildAgenda();
        this._buildSystem();
        if (this._config.shelf)
            this._buildShelf();
        if (this._config.developer)
            this._buildDeveloper();
        this._body.add_child(footer);
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
        this._cover = new St.Icon({gicon: TablerIcons.cover, icon_size: 48,
            style_class: 'rage-cover', y_align: Clutter.ActorAlign.CENTER});
        const trackText = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._trackTitle = label('', 'rage-track-title');
        this._artist = label('', 'rage-subtitle');
        trackText.add_child(this._trackTitle);
        trackText.add_child(this._artist);
        details.add_child(this._cover);
        details.add_child(trackText);
        this._mediaHeader.add_child(this._mediaHeaderToggle);
    }

    _addPage(id, title, view) {
        const tab = button(id === 'system' ? TablerIcons.battery : TablerIcons[id],
            title, () => this._selectPage(id), 'rage-tab', 17);
        tab.track_hover = true;
        const icon = tab.child;
        tab.set_child(null);
        icon.x_align = icon.y_align = Clutter.ActorAlign.CENTER;
        const dot = new St.Widget({style_class: 'rage-tab-dot', x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER});
        const layers = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        layers.add_child(dot);
        layers.add_child(icon);
        tab.set_child(layers);
        tab.connect('notify::hover', () => this._updatePageIndicators());
        tab.connect('key-focus-in', () => this._updatePageIndicators());
        tab.connect('key-focus-out', () => this._updatePageIndicators());
        view.hide();
        this._tabs.add_child(tab);
        this._body.add_child(view);
        this._pages.set(id, {tab, view, icon, dot});
    }

    _selectPage(id) {
        if (!id || this._activePage === id)
            return;
        this._activePage = id;
        for (const [key, {tab, view}] of this._pages) {
            const selected = key === id;
            view.remove_all_transitions();
            view.visible = selected;
            view.opacity = 255;
            view.translation_y = 0;
            tab.checked = selected;
        }
        this._updatePageIndicators();
        this._updateCompact(false);
        if (this._expanded) {
            this._refreshAgenda();
            this._refreshDeveloper();
            this._layout(true);
            this._refreshPlayback();
            if (St.Settings.get().enable_animations && !this._config.instant) {
                const {view} = this._pages.get(id);
                view.opacity = 125;
                view.translation_y = 5;
                view.ease({opacity: 255, translation_y: 0, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
            }
        }
    }

    _updatePageIndicators() {
        const pages = [...this._pages.values()];
        const reveal = this._tabs.hover || pages.some(({tab}) => tab.hover || tab.has_key_focus());
        const duration = this._config.instant ? 0 : 145;
        for (const {tab, icon, dot} of pages) {
            const scale = tab.hover || tab.has_key_focus() ? 1.18 : 1;
            icon.ease({opacity: reveal ? (tab.checked || scale > 1 ? 255 : 157) : 0,
                scale_x: scale, scale_y: scale, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            dot.ease({opacity: reveal ? 0 : tab.checked ? 255 : 103, duration, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
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
        this._focusToggle = button(TablerIcons.play, 'Mulai', () => this._focus.toggle(),
            'rage-focus-action rage-focus-toggle', 19);
        const reset = button(TablerIcons.reset, 'Ulangi', () => this._focus.reset(),
            'rage-focus-action rage-focus-reset', 19);
        this._focusSwitch = button(TablerIcons.break, 'Ke istirahat', () => {
            this._focus.reset(this._focus.phase === 'focus' ? 'break' : 'focus');
        }, 'rage-focus-action rage-focus-break', 19);
        this._noiseToggle = button(TablerIcons.noise, 'Putar white noise', () => {
            if (this._noise.playing)
                this._noise.stop();
            else
                this._noise.start();
        }, 'rage-focus-action rage-focus-noise', 19);
        for (const control of [this._focusToggle, reset, this._focusSwitch, this._noiseToggle])
            actions.add_child(control);
        view.add_child(actions);
        this._addPage('focus', 'Fokus', view);
    }

    _buildAgenda() {
        this._agenda = new St.BoxLayout({style_class: 'rage-agenda-split'});
        const events = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'rage-utility-card'});
        this._agendaDay = label('', 'rage-caption');
        this._agendaItems = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list', y_expand: true});
        events.add_child(this._agendaDay);
        events.add_child(this._agendaItems);
        const today = new St.Button({label: 'Hari ini', style_class: 'rage-calendar-arrow', can_focus: true});
        today.connect('clicked', () => this._setAgendaDate(new Date()));
        events.add_child(this._calendarNavigation(today, 'hari', delta => this._moveAgendaDate(delta, 0)));

        const calendar = new St.BoxLayout({vertical: true, style_class: 'rage-mini-calendar'});
        this._calendarMonth = label('', 'rage-calendar-title');
        this._calendarYear = label('', 'rage-calendar-year');
        this._calendar = new St.BoxLayout({vertical: true, style_class: 'rage-calendar-grid'});
        calendar.add_child(this._calendarNavigation(this._calendarMonth, 'bulan', delta => this._moveAgendaDate(0, delta)));
        calendar.add_child(this._calendarNavigation(this._calendarYear, 'tahun', delta => this._moveAgendaDate(0, delta * 12)));
        calendar.add_child(this._calendar);
        this._agenda.add_child(events);
        this._agenda.add_child(calendar);
        this._addPage('agenda', 'Agenda', this._agenda);
    }

    _calendarNavigation(center, unit, move) {
        const row = new St.BoxLayout({style_class: 'rage-calendar-navigation'});
        center.x_expand = true;
        row.add_child(button(TablerIcons.back, `${unit} sebelumnya`, () => move(-1), 'rage-calendar-arrow', 11));
        row.add_child(center);
        row.add_child(button(TablerIcons.forward, `${unit} berikutnya`, () => move(1), 'rage-calendar-arrow', 11));
        return row;
    }

    _setAgendaDate(date) {
        this._agendaDate = date;
        this._ensureAgendaRange();
        this._renderAgenda(false);
        this._layout(true);
    }

    _moveAgendaDate(days, months) {
        const current = this._agendaDate;
        if (months) {
            const month = new Date(current.getFullYear(), current.getMonth() + months, 1);
            const last = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
            month.setDate(Math.min(current.getDate(), last));
            this._setAgendaDate(month);
        } else {
            this._setAgendaDate(new Date(current.getFullYear(), current.getMonth(), current.getDate() + days));
        }
    }

    _renderCalendar(selected) {
        const year = selected.getFullYear();
        const month = selected.getMonth();
        const monthKey = `${year}-${month}`;
        const today = new Date();
        if (this._calendarMonthKey !== monthKey) {
            this._calendarMonthKey = monthKey;
            this._calendar.destroy_all_children();
            this._calendarCells = new Map();
            this._calendarMonth.text = selected.toLocaleDateString('id-ID', {month: 'short'});
            this._calendarYear.text = String(year);
            const weekdays = new St.BoxLayout({style_class: 'rage-calendar-row'});
            for (const day of ['Sn', 'Sl', 'Rb', 'Km', 'Jm', 'Sb', 'Mg'])
                weekdays.add_child(label(day, 'rage-calendar-weekday'));
            this._calendar.add_child(weekdays);
            const offset = (new Date(year, month, 1).getDay() + 6) % 7;
            const last = new Date(year, month + 1, 0).getDate();
            for (let start = 1 - offset; start <= last; start += 7) {
                const row = new St.BoxLayout({style_class: 'rage-calendar-row'});
                for (let day = start; day < start + 7; day++) {
                    if (day < 1 || day > last) {
                        row.add_child(new St.Widget({style_class: 'rage-calendar-cell'}));
                        continue;
                    }
                    const date = new Date(year, month, day);
                    const cell = new St.Button({label: String(day), style_class: 'rage-calendar-cell', can_focus: true,
                        accessible_name: date.toLocaleDateString('id-ID', {dateStyle: 'long'})});
                    cell.connect('clicked', () => this._setAgendaDate(date));
                    this._calendarCells.set(day, cell);
                    row.add_child(cell);
                }
                this._calendar.add_child(row);
            }
        }
        const todayInMonth = today.getFullYear() === year && today.getMonth() === month;
        for (const [day, cell] of this._calendarCells) {
            cell.checked = day === selected.getDate();
            if (todayInMonth && day === today.getDate())
                cell.add_style_class_name('rage-calendar-today');
            else
                cell.remove_style_class_name('rage-calendar-today');
        }
    }

    _refreshAgenda() {
        const source = this._expanded && this._activePage === 'agenda' ?
            Main.panel.statusArea.dateMenu?._eventSource : null;
        if (source !== this._agendaSource) {
            this._agendaSource?.disconnectObject(this._root);
            this._agendaSource = source;
            source?.connectObject('changed', () => this._renderAgenda(true),
                'notify::has-calendars', () => {
                    this._ensureAgendaRange();
                    this._renderAgenda(true);
                }, this._root);
        }
        if (this._expanded && this._activePage === 'agenda') {
            this._ensureAgendaRange();
            this._renderAgenda(false);
        }
    }

    _ensureAgendaRange() {
        const menu = Main.panel.statusArea.dateMenu;
        const source = this._agendaSource;
        if (!source?.hasCalendars || menu?.menu.isOpen)
            return;
        const start = new Date(this._agendaDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        // Let the GNOME calendar request the range it displays. Direct requests
        // to its shared event source can make the stock calendar request it back.
        if (!source._lastRequestBegin || start < source._lastRequestBegin || end > source._lastRequestEnd)
            menu?._calendar.setDate(start);
    }

    _renderAgenda(relayout) {
        const source = this._agendaSource;
        const start = new Date(this._agendaDate);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        const hasDate = () => source?._lastRequestBegin && start >= source._lastRequestBegin && end <= source._lastRequestEnd;
        this._agendaDay.text = start.toLocaleDateString('id-ID', {
            weekday: 'long', day: 'numeric', month: 'long',
        }).toLocaleUpperCase('id-ID');
        this._renderCalendar(start);
        let rows;
        if (!source?.hasCalendars) {
            rows = ['Kalender belum terhubung.'];
        } else if (!hasDate()) {
            rows = ['Memuat acara…'];
        } else {
            const events = source.getEvents(start, end);
            rows = events.slice(0, 4).map(event => {
                const time = event.date <= start && event.end >= end ? 'Seharian' :
                    new Intl.DateTimeFormat('id-ID', {hour: '2-digit', minute: '2-digit'}).format(event.date);
                return `${time}  ·  ${event.summary}`;
            });
            if (!rows.length)
                rows.push('Tidak ada acara.');
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
        const view = new St.BoxLayout({vertical: true, style_class: 'rage-system'});
        const devices = new St.BoxLayout({style_class: 'rage-system-devices', x_align: Clutter.ActorAlign.CENTER});
        if (this._config.battery) {
            const battery = new St.BoxLayout({vertical: true, style_class: 'rage-system-item'});
            this._batteryDial = this._makeDial(TablerIcons.bolt, 64, [0.24, 0.88, 0.50]);
            this._batteryLabel = label('–', 'rage-meter-value');
            battery.add_child(this._batteryDial.actor);
            battery.add_child(this._batteryLabel);
            devices.add_child(battery);
        }
        if (this._config.bluetooth) {
            const bluetooth = new St.BoxLayout({vertical: true, style_class: 'rage-system-item'});
            const icon = new Gio.ThemedIcon({name: 'bluetooth-symbolic'});
            this._bluetoothDial = this._makeDial(icon, 64, [0.25, 0.61, 1]);
            this._bluetoothIcon = this._bluetoothDial.icon;
            this._deviceLabel = label('Belum terhubung', 'rage-meter-value');
            bluetooth.add_child(this._bluetoothDial.actor);
            bluetooth.add_child(this._deviceLabel);
            devices.add_child(bluetooth);
        }
        if (!devices.get_n_children())
            devices.add_child(label('Indikator sistem dinonaktifkan.', 'rage-subtitle'));
        view.add_child(devices);
        this._addPage('system', 'Baterai dan Bluetooth', view);
    }

    _makeDial(gicon, size, color) {
        const actor = new St.Widget({layout_manager: new Clutter.BinLayout(), width: size, height: size,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const ring = new St.DrawingArea({x_expand: true, y_expand: true});
        const icon = new St.Icon({gicon, icon_size: size < 30 ? 11 : 23,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const dial = {actor, ring, icon, value: 0};
        actor.add_child(ring);
        actor.add_child(icon);
        ring.connect('repaint', () => {
            const [width, height] = ring.get_surface_size();
            const cr = ring.get_context();
            const stroke = Math.max(2, Math.min(width, height) * 0.08);
            const radius = Math.max(0, Math.min(width, height) / 2 - stroke);
            const start = Math.PI * 0.72;
            const sweep = Math.PI * 1.56;
            cr.setLineWidth(stroke);
            cr.setLineCap(Cairo.LineCap.ROUND);
            const arc = (fraction, rgb) => {
                cr.setSourceRGB(...rgb);
                cr.arc(width / 2, height / 2, radius, start, start + sweep * fraction);
                cr.stroke();
            };
            arc(1, [0.22, 0.24, 0.23]);
            if (dial.value > 0)
                arc(Math.min(100, dial.value) / 100, color);
            cr.$dispose();
        });
        return dial;
    }

    _setDial(dial, value) {
        if (dial && dial.value !== value) {
            dial.value = value;
            dial.ring.queue_repaint();
        }
    }

    _openPreferences() {
        if (this._preferences)
            return;
        const dialog = new ModalDialog.ModalDialog({styleClass: 'rage-preferences'});
        this._preferences = dialog;
        dialog.connect('destroy', () => {
            this._preferences = null;
            this._topPanelToggle = null;
        });
        dialog.contentLayout.add_child(label('Tampilan RageNotch', 'rage-track-title'));
        dialog.contentLayout.add_child(label('Pilih posisi notch di tepi atas layar.', 'rage-subtitle'));
        const options = new St.BoxLayout({style_class: 'rage-utility-row'});
        const choices = new Map();
        const sync = () => {
            for (const [value, control] of choices)
                control.checked = value === this._config.style;
        };
        for (const [style, text] of [['floating_island', 'Floating'], ['attached_notch', 'Rapat ke atas']]) {
            const control = new St.Button({label: text, can_focus: true, style_class: 'rage-action'});
            control.connect('clicked', () => {
                try {
                    saveAppearanceStyle(style);
                    this._config.style = style;
                    sync();
                    this._layout(true);
                } catch (error) {
                    Main.notifyError('RageNotch tidak dapat menyimpan tampilan', error.message);
                }
            });
            options.add_child(control);
            choices.set(style, control);
        }
        sync();
        dialog.contentLayout.add_child(options);
        const lyricWidth = new St.Button({style_class: 'rage-action', can_focus: true,
            x_align: Clutter.ActorAlign.START});
        const updateLyricWidth = () => {
            lyricWidth.checked = this._config.lyricAutoWidth;
            lyricWidth.label = `Lebar otomatis untuk lirik · ${this._config.lyricAutoWidth ? 'Aktif' : 'Nonaktif'}`;
        };
        updateLyricWidth();
        lyricWidth.connect('clicked', () => {
            try {
                const enabled = !this._config.lyricAutoWidth;
                saveLyricAutoWidth(enabled);
                this._config.lyricAutoWidth = enabled;
                updateLyricWidth();
                this._layout(true);
            } catch (error) {
                Main.notifyError('RageNotch tidak dapat menyimpan lebar lirik', error.message);
            }
        });
        dialog.contentLayout.add_child(lyricWidth);
        this._topPanelToggle = new St.Button({style_class: 'rage-action', can_focus: true,
            x_align: Clutter.ActorAlign.START});
        this._topPanelToggle.connect('clicked', () => {
            const hidden = !this._config.hideTopPanel;
            try {
                saveTopPanelHidden(hidden);
                this._config.hideTopPanel = hidden;
                this._updateVisibility();
            } catch (error) {
                Main.notifyError('RageNotch tidak dapat menyimpan pengaturan panel', error.message);
            }
        });
        dialog.contentLayout.add_child(this._topPanelToggle);
        dialog.addButton({label: 'Tutup', key: Clutter.KEY_Escape, action: () => dialog.close(), default: true});
        this._syncTopPanel();
        if (!dialog.open())
            dialog.destroy();
    }

    _subTabs(entries, selected, onSelect) {
        const row = new St.BoxLayout({style_class: 'rage-subtabs'});
        const controls = new Map();
        for (const [id, title] of entries) {
            const control = new St.Button({label: title, style_class: 'rage-action', can_focus: true});
            control.checked = id === selected;
            control.connect('clicked', () => {
                for (const [key, tab] of controls)
                    tab.checked = key === id;
                onSelect(id);
            });
            controls.set(id, control);
            row.add_child(control);
        }
        return row;
    }

    _buildShelf() {
        const view = new St.BoxLayout({vertical: true, style_class: 'rage-utility-card'});
        const heading = this._subTabs([['files', 'File & Folder'], ['clipboard', 'Clipboard']], this._shelfMode, id => {
            this._shelfMode = id;
            this._renderShelf();
        });
        this._shelfFileActions = new St.BoxLayout({style_class: 'rage-utility-row'});
        for (const [directory, title, icon] of [[false, 'Tambah file', TablerIcons.add], [true, 'Tambah folder', TablerIcons.file]]) {
            this._shelfFileActions.add_child(button(icon, title, () => this._choosePath(directory, path => this._pinPaths([path]))));
        }
        this._shelfClear = button(TablerIcons.trash, 'Kosongkan riwayat', () => this._shelf.clear());
        this._shelfClear.x_align = Clutter.ActorAlign.START;
        view.add_child(heading);
        view.add_child(this._shelfFileActions);
        view.add_child(this._shelfClear);
        this._shelfItems = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list'});
        view.add_child(this._shelfItems);
        this._addPage('shelf', 'Shelf', view);
    }

    async _choosePath(directory, callback) {
        if (this._filePicker)
            return;
        const cancel = new Gio.Cancellable();
        this._filePicker = cancel;
        try {
            const path = await chooseLocalPath(directory, cancel);
            if (path && !cancel.is_cancelled())
                callback(path);
        } catch (error) {
            if (!cancel.is_cancelled())
                Main.notifyError('RageNotch tidak dapat membuka pemilih file', error.message);
        } finally {
            if (this._filePicker === cancel)
                this._filePicker = null;
        }
    }

    _pinPaths(paths) {
        const valid = paths.filter(path => typeof path === 'string' && GLib.path_is_absolute(path));
        if (valid.length)
            this._saveShelf([...new Set([...valid, ...this._config.shelfPaths])].slice(0, 8));
    }

    _saveShelf(paths) {
        try {
            saveShelfPaths(paths);
            this._config.shelfPaths = paths;
            this._renderShelf();
        } catch (error) {
            Main.notifyError('Shelf tidak dapat disimpan', error.message);
        }
    }

    _launchUri(uri) {
        try {
            Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
        } catch (error) {
            Main.notifyError('RageNotch tidak dapat membuka item', error.message);
        }
    }

    _renderShelf() {
        const list = this._shelfItems;
        const clipboard = this._shelfMode === 'clipboard';
        this._shelfFileActions.visible = !clipboard;
        this._shelfClear.visible = clipboard;
        list.destroy_all_children();
        if (clipboard) {
            this._renderClipboardRows(list);
        } else {
            if (!this._config.shelfPaths.length)
                list.add_child(label('Tambahkan file atau folder untuk disimpan di Shelf.', 'rage-subtitle'));
            for (const path of this._config.shelfPaths) {
                const file = Gio.File.new_for_path(path);
                const row = new St.BoxLayout({style_class: 'rage-utility-row'});
                const title = label(file.get_basename(), 'rage-utility-detail');
                title.x_expand = true;
                row.add_child(title);
                row.add_child(button(TablerIcons.open, `Buka ${path}`, () => this._launchUri(file.get_uri())));
                row.add_child(button(TablerIcons.copy, `Salin lokasi ${path}`, () =>
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, path)));
                row.add_child(button(TablerIcons.trash, `Lepas dari Shelf: ${path}`, () =>
                    this._saveShelf(this._config.shelfPaths.filter(item => item !== path))));
                list.add_child(row);
            }
        }
        if (this._expanded && this._activePage === 'shelf')
            this._layout(true);
    }

    _renderClipboardRows(list) {
        if (!this._shelf.entries.length)
            list.add_child(label('Riwayat clipboard kosong.', 'rage-subtitle'));
        for (const entry of this._shelf.entries) {
            const line = new St.BoxLayout({style_class: 'rage-utility-row'});
            const row = new St.BoxLayout({style_class: 'rage-utility-row', x_expand: true});
            const control = new St.Button({style_class: 'rage-shelf-row', child: row, can_focus: true, x_expand: true});
            let title = entry.image ? 'Gambar' : entry.text.replace(/\s+/g, ' ').slice(0, 160);
            const files = entry.files ? entry.text.split(/\r?\n/).filter(item => item.startsWith('file://'))
                .map(item => Gio.File.new_for_uri(item)) : [];
            if (files.length)
                title = files[0].get_basename() + (files.length > 1 ? ` +${files.length - 1}` : '');
            if (entry.image || entry.files)
                row.add_child(new St.Icon({gicon: entry.image ? TablerIcons.photo : TablerIcons.file, icon_size: 14}));
            if (/^#(?:[a-f\d]{3}|[a-f\d]{6})$/i.test(entry.text))
                row.add_child(new St.Widget({style_class: 'rage-swatch', y_align: Clutter.ActorAlign.CENTER,
                    style: `background-color: ${entry.text};`}));
            row.add_child(label(title, 'rage-subtitle'));
            control.accessible_name = `Salin kembali: ${title}`;
            control.connect('clicked', () => St.Clipboard.get_default().set_content(
                St.ClipboardType.CLIPBOARD, entry.mime, entry.bytes));
            line.add_child(control);
            if (files.length)
                line.add_child(button(TablerIcons.pin, 'Simpan file ke Shelf', () => this._pinPaths(files.map(file => file.get_path()))));
            list.add_child(line);
        }
    }

    _buildDeveloper() {
        const view = new St.BoxLayout({vertical: true, style_class: 'rage-utility-card'});
        this._devMode = 'ports';
        view.add_child(this._subTabs([['ports', 'Port'], ['git', 'GitHub'], ['editors', 'Waktu IDE']], this._devMode, id => {
            if (this._devMode === id)
                return;
            this._devMode = id;
            this._syncDeveloperMode();
            this._layout(true);
        }));
        const ports = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list'});
        this._devStats = label('', 'rage-subtitle');
        this._devPorts = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list'});
        ports.add_child(this._devStats);
        ports.add_child(this._devPorts);

        const git = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list'});
        const gitHeader = new St.BoxLayout({style_class: 'rage-utility-row'});
        this._gitTitle = label('Pilih folder proyek Git.', 'rage-utility-detail');
        this._gitTitle.x_expand = true;
        gitHeader.add_child(this._gitTitle);
        gitHeader.add_child(button(TablerIcons.file, 'Pilih folder repositori', () => this._choosePath(true, path => {
            try {
                saveDeveloperRepo(path);
                this._config.developerRepo = path;
                this._syncDeveloperMode();
            } catch (error) {
                Main.notifyError('Lokasi repositori tidak bisa disimpan', error.message);
            }
        })));
        this._gitOpen = button(TablerIcons.github, 'Buka repositori GitHub', () => this._launchUri(this._gitUrl));
        this._gitOpen.hide();
        gitHeader.add_child(this._gitOpen);
        git.add_child(gitHeader);
        this._gitStatus = label('', 'rage-subtitle');
        git.add_child(this._gitStatus);

        const editors = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list'});
        editors.add_child(label('WAKTU FOKUS SESI INI', 'rage-caption'));
        this._editorRows = new St.BoxLayout({vertical: true, style_class: 'rage-utility-list'});
        editors.add_child(this._editorRows);
        this._devViews = {ports, git, editors};
        for (const panel of Object.values(this._devViews))
            view.add_child(panel);
        this._syncDeveloperMode();
        this._addPage('developer', 'Developer', view);
    }

    _syncDeveloperMode() {
        for (const [id, view] of Object.entries(this._devViews))
            view.visible = id === this._devMode;
        this._stopDeveloper();
        this._refreshDeveloper();
    }

    _refreshDeveloper() {
        const active = this._expanded && this._activePage === 'developer' && this._root.visible;
        if (!active) {
            this._stopDeveloper();
            return;
        }
        if (this._devTimer)
            return;
        this._devCancel = new Gio.Cancellable();
        this._devSample = null;
        this._devStateKey = null;
        const update = {
            ports: () => this._updateDeveloper(this._devCancel),
            git: () => this._updateGit(this._devCancel),
            editors: () => this._renderEditorTime(),
        }[this._devMode];
        update();
        this._devTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            {ports: 2, git: 5, editors: 1}[this._devMode], () => {
                update();
                return GLib.SOURCE_CONTINUE;
            });
    }

    async _updateGit(cancel) {
        const path = this._config.developerRepo;
        if (!path || this._gitPending === cancel)
            return;
        this._gitPending = cancel;
        try {
            const project = await gitProject(path, cancel);
            if (cancel.is_cancelled())
                return;
            this._gitTitle.text = project.name;
            this._gitStatus.text = `${project.branch}  ·  ${project.changes ? `${project.changes} perubahan` : 'Bersih'}`;
            this._gitUrl = project.url;
            this._gitOpen.visible = !!this._gitUrl;
        } catch {
            if (!cancel.is_cancelled()) {
                this._gitTitle.text = GLib.path_get_basename(path);
                this._gitStatus.text = 'Folder ini tidak bisa dibaca sebagai repositori Git.';
                this._gitOpen.hide();
            }
        } finally {
            if (this._gitPending === cancel)
                this._gitPending = null;
        }
    }

    _startEditorTracking() {
        this._editorTimes = new Map();
        this._editorId = null;
        this._editorSince = timeNow();
        this._editorIdle = global.backend.get_core_idle_monitor();
        global.display.connectObject('notify::focus-window', () => this._trackEditor(), this._root);
        Main.sessionMode.connectObject('updated', () => this._trackEditor(), this._root);
        this._editorIdleWatch = this._editorIdle.add_idle_watch(60000, () => this._trackEditor());
        this._trackEditor();
    }

    _trackEditor() {
        if (!this._editorTimes)
            return;
        const focused = global.display.focus_window;
        const idle = this._editorIdle.get_idletime() >= 60000;
        if (idle && !this._editorWake) {
            this._editorWake = this._editorIdle.add_user_active_watch(() => {
                this._editorWake = 0;
                this._trackEditor();
            });
        }
        const app = focused ? Shell.WindowTracker.get_default().get_window_app(focused) : null;
        const editor = idle || Main.overview.visible || Main.sessionMode.isLocked ? null :
            editorName(app?.get_id(), focused?.get_wm_class());
        if (editor === this._editorId)
            return;
        const now = timeNow();
        if (this._editorId)
            this._editorTimes.set(this._editorId, (this._editorTimes.get(this._editorId) ?? 0) + now - this._editorSince);
        this._editorId = editor;
        this._editorSince = now;
    }

    _renderEditorTime() {
        const totals = new Map(this._editorTimes);
        if (this._editorId)
            totals.set(this._editorId, (totals.get(this._editorId) ?? 0) + timeNow() - this._editorSince);
        const rows = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 6)
            .map(([editor, seconds]) => `${editor}  ·  ${formatTime(seconds)}`);
        this._setRows(this._editorRows, rows.length ? rows : ['Belum ada IDE yang aktif pada sesi ini.'], true);
    }

    async _updateDeveloper(cancel) {
        if (this._devPending === cancel)
            return;
        this._devPending = cancel;
        const sample = systemSample();
        const previous = this._devSample;
        this._devSample = sample;
        const rate = key => previous ?
            `${Math.max(0, (sample[key] - previous[key]) / (sample.time - previous.time) / 1024).toFixed(0)} KiB/s` : '–';
        const memory = sample.memory === null ? '–' : `${sample.memory.toFixed(1)} GiB`;
        try {
            const result = await developerSockets(cancel);
            if (cancel.is_cancelled())
                return;
            this._devStats.text = `↓ ${rate('rx')}   ↑ ${rate('tx')}   RAM ${memory}   SSH ${result.ssh ?? '–'}`;
            this._renderPorts(result);
        } catch {
            if (!cancel.is_cancelled())
                this._devStats.text = `↓ ${rate('rx')}   ↑ ${rate('tx')}   RAM ${memory}   SSH –`;
        } finally {
            if (this._devPending === cancel)
                this._devPending = null;
        }
    }

    _renderPorts(result) {
        const ports = result.ports.slice(0, 5);
        const key = JSON.stringify([result.available, result.ports.length, ports]);
        if (key === this._devStateKey)
            return;
        this._devStateKey = key;
        this._devPorts.destroy_all_children();
        if (!ports.length)
            this._devPorts.add_child(label(result.available ? 'Tidak ada port TCP yang mendengarkan.' :
                'Port watcher memerlukan perintah ss.', 'rage-subtitle'));
        for (const entry of ports) {
            const row = new St.BoxLayout({style_class: 'rage-utility-row'});
            const title = label(`:${entry.port}${entry.name ? `  ·  ${entry.name}` : ''}`, 'rage-utility-detail');
            title.x_expand = true;
            row.add_child(title);
            row.add_child(button(TablerIcons.open, `Buka ${entry.url}`, () => this._launchUri(entry.url)));
            if (entry.started)
                row.add_child(button(TablerIcons.stop, `Hentikan proses pada port ${entry.port}`, () => this._confirmStop(entry)));
            this._devPorts.add_child(row);
        }
        if (result.ports.length > ports.length)
            this._devPorts.add_child(label(`+${result.ports.length - ports.length} port lainnya`, 'rage-subtitle'));
        this._layout(true);
    }

    _confirmStop(entry) {
        if (this._devConfirm)
            return;
        const dialog = new ModalDialog.ModalDialog({styleClass: 'rage-preferences'});
        this._devConfirm = dialog;
        dialog.connect('destroy', () => { this._devConfirm = null; });
        dialog.contentLayout.add_child(label(`Hentikan ${entry.name || 'proses'} di port ${entry.port}?`, 'rage-track-title'));
        dialog.addButton({label: 'Batal', key: Clutter.KEY_Escape, action: () => dialog.close(), default: true});
        dialog.addButton({label: 'Hentikan', action: () => {
            dialog.close();
            stopLocalServer(entry, null).catch(error => Main.notifyError('Proses tidak dihentikan', error.message));
        }});
        if (!dialog.open())
            dialog.destroy();
    }

    _stopDeveloper() {
        if (this._devTimer)
            GLib.Source.remove(this._devTimer);
        this._devTimer = 0;
        this._devCancel?.cancel();
        this._devCancel = null;
    }

    _startUtilities() {
        if (this._config.developer)
            this._startEditorTracking();
        if (this._config.shelf) {
            this._shelf = new ClipboardShelf(global.display.get_selection(), Meta.SelectionType.SELECTION_CLIPBOARD,
                () => { if (this._shelfMode === 'clipboard') this._renderShelf(); });
            this._renderShelf();
        }
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
        this._noiseToggle.child.gicon = playing ? TablerIcons.stop : TablerIcons.noise;
        this._noiseToggle.accessible_name = error ?? (!available ? 'White noise memerlukan GStreamer' :
            playing ? 'Matikan white noise' : 'Putar white noise');
        if (error)
            Main.notify('RageNotch', error);
    }

    _renderFocus(timer) {
        const focusing = timer.phase === 'focus';
        this._focusPhase.text = focusing ? 'WAKTU FOKUS' : 'ISTIRAHAT';
        this._focusTime.text = formatTime(Math.ceil(timer.remaining));
        this._focusToggle.child.gicon = timer.running ? TablerIcons.pause : TablerIcons.play;
        this._focusToggle.accessible_name = timer.running ? 'Jeda' : 'Mulai';
        if (timer.running)
            this._focusToggle.add_style_pseudo_class('checked');
        else
            this._focusToggle.remove_style_pseudo_class('checked');
        this._focusSwitch.child.gicon = focusing ? TablerIcons.break : TablerIcons.focusReturn;
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
        this._setDial(this._compactBatteryDial, battery?.percentage ?? 0);
        this._setDial(this._batteryDial, battery?.percentage ?? 0);
        if (this._batteryLabel) {
            const status = {1: 'Mengisi daya', 2: 'Menggunakan baterai', 3: 'Kosong', 4: 'Penuh',
                5: 'Menunggu pengisian', 6: 'Menunggu pengosongan'};
            this._batteryLabel.text = battery ? `${battery.percentage}%` : '–';
            this._batteryDial.actor.accessible_name = battery ?
                `Baterai ${battery.percentage} persen, ${status[battery.state] ?? 'status tidak diketahui'}` :
                'Baterai tidak tersedia';
        }
        if (this._bluetoothIcon) {
            const device = devices[0];
            const kind = [device?.icon, device?.type].filter(Boolean).join(' ');
            const icon = /audio|headset|headphone/.test(kind) ? TablerIcons.media :
                /phone|mobile/.test(kind) ? TablerIcons.phone :
                    /computer/.test(kind) ? TablerIcons.computer : null;
            if (icon)
                this._bluetoothIcon.gicon = icon;
            else
                this._bluetoothIcon.icon_name = 'bluetooth-symbolic';
            this._setDial(this._bluetoothDial, device ? (device.percentage ?? 100) : 0);
            this._deviceLabel.text = device ?
                `${device.name}${Number.isFinite(device.percentage) ? ` · ${device.percentage}%` : ''}${devices.length > 1 ? ` +${devices.length - 1}` : ''}` :
                'Belum terhubung';
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
        this._flash = {title, value, gicon: new Gio.ThemedIcon({name: icon})};
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
        this._clockLabel.text = time;
        if (this._expanded && this._activePage === 'agenda')
            this._renderAgenda(true);
    }

    _updateCompact(reflow = true) {
        const track = this._track;
        const battery = this._system?.battery;
        const focus = this._focus?.running ? this._focus : null;
        const showTrack = !!track && ((this._expanded && this._activePage === 'media') || (!focus && !this._flash));
        const previousLyric = this._compactLyric.visible;
        this._compactLyric.visible = showTrack && !this._expanded && !!this._lyricResult?.lines?.length;
        const showBattery = !!battery && !showTrack && !focus && !this._flash;
        this._compactSignal.visible = this._compactSource.visible = showTrack;
        this._compactBattery.visible = showBattery;
        this._indicator.visible = !showTrack && !showBattery;
        this._compactTitle.visible = !showTrack;
        this._clockLabel.x_expand = showTrack && !this._compactLyric.visible;
        this._indicator.gicon = this._flash?.gicon ?? (focus ? TablerIcons.focus : TablerIcons.media);
        this._compactTitle.text = this._flash?.title ?? (focus ? (focus.phase === 'focus' ? 'Fokus' : 'Istirahat') :
            battery ? `${battery.percentage}%` : 'RageNotch');
        this._headerStatus.text = this._flash?.value ?? (focus ? formatTime(Math.ceil(focus.remaining)) : '');
        this._headerStatus.visible = !!this._headerStatus.text;
        if (track)
            this._artist.text = this._flash ? [this._flash.title, this._flash.value].filter(Boolean).join(' · ') :
                track.artist || 'Artis tidak diketahui';
        this._syncSignalAnimation();
        if (reflow && previousLyric !== this._compactLyric.visible)
            this._layout(true);
    }

    _syncSignalAnimation() {
        const animate = this._root.visible && this._track?.playing && !this._config.instant &&
            St.Settings.get().enable_animations;
        const target = animate && this._compactSignal.visible ? this._compactSignal : null;
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
        const showMediaHeader = this._expanded && this._activePage === 'media' && !!this._track;
        const showExpandedLyrics = showMediaHeader && this._config.lyrics;
        const auto = this._config.lyricAutoWidth;
        const baseExpanded = this._config.expandedWidth;
        const baseLyrics = Math.max(82, Math.min(175, Math.floor((baseExpanded - 38) * 0.38)));
        const desiredLyrics = showExpandedLyrics && auto ? Math.max(baseLyrics,
            Math.min(410, Math.max(lyricWidth(this._lyric), lyricWidth(this._nextLyric)) + 22)) : baseLyrics;
        const desiredExpanded = showExpandedLyrics && auto ?
            Math.max(baseExpanded, 238 + desiredLyrics) : baseExpanded;
        const desiredCompact = this._compactLyric.visible ? Math.max(compactWidth, 316,
            auto ? lyricWidth(this._compactLyric) + 132 : 0) : compactWidth;
        const width = Math.min(maxWidth, this._expanded ? desiredExpanded : desiredCompact);
        this._mediaHeader.visible = showMediaHeader;
        this._syncSignalAnimation();
        const compactHeight = this._config.style === 'minimalist_pill' && !this._expanded ? 30 : 38;
        const compactTextWidth = Math.max(30, width - 132);
        const headerHeight = this._compactLyric.visible ? Math.max(compactHeight,
            Math.ceil(this._compactLyric.get_preferred_height(compactTextWidth)[1]) + 12) : compactHeight;
        this._compactLyric.width = compactTextWidth;
        this._header.height = headerHeight - 2;
        this._body.set_position(0, headerHeight - 2);
        this._body.width = Math.max(1, width - 2);
        this._body.visible = this._expanded;
        this._lyricsCard.width = Math.max(60, Math.min(desiredLyrics, width - 238));
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
        this._trackEditor();
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
        if (this._topPanelToggle) {
            this._topPanelToggle.visible = supported;
            this._topPanelToggle.label = this._config.hideTopPanel ? 'Tampilkan panel atas' : 'Sembunyikan panel atas';
        }
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
        this._updateCompact(false);
        this._header.accessible_name = expanded ? 'RageNotch terbuka' : 'Buka RageNotch';
        this._refreshAgenda();
        this._refreshDeveloper();
        this._layout(animate);
        this._refreshPlayback();
    }

    _onTrack(track) {
        const old = this._track;
        const changed = old?.proxy !== track?.proxy || old?.id !== track?.id || old?.title !== track?.title ||
            old?.lookupArtist !== track?.lookupArtist || old?.album !== track?.album || old?.duration !== track?.duration;
        this._setPosition(changed ? 0 : this._currentPosition());
        this._track = track;
        if (changed) {
            this._stopLyrics();
            this._lyricResult = null;
            this._compactLyric.text = '';
        }
        if (old?.name !== track?.name) {
            const spotify = /^org\.mpris\.MediaPlayer2\.spotify(?:d|[.-]|$)/i.test(track?.name ?? '');
            this._compactSource.gicon = spotify ? TablerIcons.spotify : TablerIcons.media;
            this._compactSource.icon_size = spotify ? 22 : 12;
            if (spotify)
                this._compactSource.add_style_class_name('rage-source-spotify');
            else
                this._compactSource.remove_style_class_name('rage-source-spotify');
        }
        this._compactSignal.opacity = track?.playing ? 255 : 92;
        this._updateCompact();
        this._mediaView.visible = !!track;
        this._idle.visible = !track;
        this._lyricsCard.visible = this._config.lyrics;
        if (track) {
            this._trackTitle.text = track.title;
            this._duration.text = track.duration > 0 ? formatTime(track.duration, 2) : '–:––';
            this._play.child.gicon = track.playing ? TablerIcons.pause : TablerIcons.play;
            this._play.accessible_name = track.playing ? 'Jeda' : 'Putar';
            for (const [control, enabled] of [[this._play, track.playPause], [this._previous, track.previous],
                [this._stop, track.stop], [this._next, track.next]]) {
                control.reactive = control.can_focus = enabled;
                control.opacity = enabled ? 255 : 92;
            }
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
        this._cover.gicon = TablerIcons.cover;
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
            image.set_data(roundedPixels(pixbuf), Cogl.PixelFormat.RGBA_8888,
                pixbuf.width, pixbuf.height, pixbuf.width * 4);
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
        const detailed = this._mediaHeader.visible;
        if (!this._root.visible || !this._track || (!detailed && !this._config.lyrics)) {
            this._stopLyrics();
            return;
        }

        this._syncPosition();
        this._renderPosition();
        this._loadLyrics();
        if (this._track.playing) {
            this._tick = GLib.timeout_add(GLib.PRIORITY_DEFAULT, detailed ? 125 : 250, () => {
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
        this._nextSync = timeNow() + (this._mediaHeader.visible ? 4 : 8);
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
        if (!this._track || !this._root.visible)
            return;
        const position = this._currentPosition();
        if (this._mediaHeader.visible) {
            const elapsed = formatTime(position, 2);
            if (this._elapsed.text !== elapsed)
                this._elapsed.text = elapsed;
            this._progressFill.width = this._track.duration ?
                Math.round(this._progress.width * position / this._track.duration) : 0;
        }
        if (!this._config.lyrics)
            return;
        const lines = this._lyricResult?.lines;
        const index = lines?.length ? lyricAt(lines, position) : -1;
        const current = lines?.length ? lines[index]?.text ?? '' : this._lyricResult?.message ?? 'Memuat lirik…';
        const next = lines?.[index + 1]?.text ?? '';
        const compact = lines?.length ? current || next : '';
        const compactChanged = this._compactLyric.text !== compact;
        const expandedChanged = this._lyric.text !== current || this._nextLyric.text !== next;
        if (compactChanged)
            this._compactLyric.text = compact;
        if (this._lyric.text !== current)
            this._lyric.text = current;
        if (this._nextLyric.text !== next)
            this._nextLyric.text = next;
        if ((this._compactLyric.visible && compactChanged) || (this._mediaHeader.visible && expandedChanged))
            this._layout(true);
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
            this._updateCompact();
            if (result.retry)
                this._lyricResult = null;
        }
    }

    disable() {
        this._clearHover();
        this._stopLyrics();
        this._stopSignalAnimation();
        this._stopDeveloper();
        this._filePicker?.cancel();
        this._filePicker = null;
        if (this._editorIdleWatch)
            this._editorIdle.remove_watch(this._editorIdleWatch);
        if (this._editorWake)
            this._editorIdle.remove_watch(this._editorWake);
        this._editorIdleWatch = this._editorWake = 0;
        this._editorTimes = this._editorIdle = null;
        this._shelf?.destroy();
        this._shelf = null;
        this._preferences?.destroy();
        this._devConfirm?.destroy();
        this._hud?.clear();
        this._hud = null;
        this._focus?.destroy();
        this._noise?.stop();
        this._system?.destroy();
        this._focus = this._noise = this._system = null;
        this._agendaSource?.disconnectObject(this._root);
        this._agendaSource = this._batteryLabel = this._batteryDial = this._bluetoothDial = this._bluetoothIcon = null;
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
