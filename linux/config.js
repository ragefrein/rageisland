import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const presets = {
    apple_fluid: {stiffness: 280, damping: 22},
    bouncy: {stiffness: 240, damping: 15},
    snappy: {stiffness: 420, damping: 34},
    instant: {stiffness: 0, damping: 0},
};

function choice(value, values, fallback) {
    return values.includes(value) ? value : fallback;
}

function number(value, min, max, fallback) {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function configFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_config_dir(), 'ragenotch', 'config.json']));
}

export function saveTopPanelHidden(hidden) {
    saveSetting('behavior', 'hide_top_panel', hidden);
}

export function saveAppearanceStyle(style) {
    saveSetting('appearance', 'style', style);
}

export function saveLyricAutoWidth(enabled) {
    saveSetting('appearance', 'lyrics_auto_width', enabled);
}

export function saveShelfPaths(paths) {
    saveSetting('shelf', 'paths', paths);
}

export function saveDeveloperRepo(path) {
    saveSetting('developer', 'repo_path', path);
}

function saveSetting(section, key, value) {
    const file = configFile();
    let config = {};
    let etag = null;
    try {
        const [, bytes, savedEtag] = file.load_contents(null);
        config = JSON.parse(new TextDecoder().decode(bytes));
        etag = savedEtag;
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            throw error;
    }
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        (config[section] != null && (typeof config[section] !== 'object' || Array.isArray(config[section]))))
        throw new Error('Format config.json tidak valid.');

    try {
        file.get_parent().make_directory_with_parents(null);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw error;
    }
    config[section] ??= {};
    config[section][key] = value;
    file.replace_contents(`${JSON.stringify(config, null, 2)}\n`, etag, false, Gio.FileCreateFlags.PRIVATE, null);
}

export function loadConfig() {
    const file = configFile();
    let raw = {};
    try {
        const [, bytes] = file.load_contents(null);
        raw = JSON.parse(new TextDecoder().decode(bytes)) ?? {};
    } catch (error) {
        if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn(`RageNotch: cannot read ${file.get_path()}: ${error.message}`);
    }

    const appearance = raw.appearance ?? {};
    const physics = appearance.physics ?? {};
    const behavior = raw.behavior ?? {};
    const modules = raw.modules ?? {};
    const focus = raw.pomodoro ?? {};
    const preset = choice(physics.preset, Object.keys(presets), 'apple_fluid');
    const compactWidth = number(appearance.compact_width, 148, 350, 186);

    return {
        style: choice(appearance.style, ['attached_notch', 'floating_island', 'minimalist_pill'], 'floating_island'),
        position: choice(appearance.position, ['top_left', 'top_center', 'top_right'], 'top_center'),
        margin: number(appearance.margin_top, 0, 72, 6),
        radius: number(appearance.corner_radius, 6, 32, 24),
        compactWidth,
        expandedWidth: number(appearance.expanded_width, Math.max(320, compactWidth), 540, 388),
        lyricAutoWidth: appearance.lyrics_auto_width !== false,
        glow: appearance.chameleon_glow !== 'off',
        instant: preset === 'instant',
        stiffness: number(physics.stiffness, 40, 650, presets[preset].stiffness),
        damping: number(physics.damping, 5, 65, presets[preset].damping),
        hoverDelay: number(behavior.hover_delay_ms, 0, 2000, 150),
        expandOnHover: behavior.expand_on_hover !== false,
        hideFullscreen: behavior.hide_fullscreen !== false,
        hideTopPanel: behavior.hide_top_panel === true,
        media: modules.media_player !== false,
        lyrics: modules.synced_lyrics !== false,
        pomodoro: modules.pomodoro !== false,
        calendar: modules.calendar !== false,
        battery: modules.battery !== false,
        bluetooth: modules.bluetooth !== false,
        shelf: modules.clipboard_shelf !== false,
        developer: modules.dev_port_watcher !== false,
        shelfPaths: Array.isArray(raw.shelf?.paths) ?
            [...new Set(raw.shelf.paths.filter(path => typeof path === 'string' && GLib.path_is_absolute(path)))].slice(0, 8) : [],
        developerRepo: typeof raw.developer?.repo_path === 'string' && GLib.path_is_absolute(raw.developer.repo_path) ?
            raw.developer.repo_path : '',
        systemHud: modules.system_hud === true,
        focusMinutes: Math.round(number(focus.focus_minutes, 1, 180, 25)),
        breakMinutes: Math.round(number(focus.break_minutes, 1, 60, 5)),
        autoWhiteNoise: focus.auto_white_noise === true,
    };
}
