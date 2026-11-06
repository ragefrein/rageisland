import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';
import {ExtensionState, ExtensionType} from 'resource:///org/gnome/shell/misc/extensionUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'ragenotch@local';
const MODULES = ['extension.js', 'assets.js', 'config.js', 'media.js', 'utilities.js'];
let updating = false;

export async function update() {
    if (PACKAGE_VERSION.split('.')[0] !== '46')
        throw new Error('Pembaruan langsung RageNotch hanya tersedia di GNOME Shell 46.');
    if (updating)
        throw new Error('RageNotch sedang diperbarui.');

    const manager = Main.extensionManager;
    const extension = manager.lookup(UUID);
    if (extension?.type !== ExtensionType.PER_USER || extension.state !== ExtensionState.ACTIVE)
        throw new Error('Aktifkan RageNotch sebelum memperbarui sesi ini.');

    updating = true;
    const stage = Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_runtime_dir(), `ragenotch-live-${GLib.uuid_string_random()}`,
    ]));
    const previous = {stateObj: extension.stateObj, metadata: extension.metadata, error: extension.error};
    let keepStage = false;
    try {
        const [, bytes] = extension.dir.get_child('metadata.json').load_contents(null);
        const metadata = JSON.parse(new TextDecoder().decode(bytes));
        if (metadata.uuid !== UUID || !metadata['shell-version']?.includes('46'))
            throw new Error('Paket RageNotch tidak cocok dengan sesi ini.');

        // GJS caches modules by URI. Import the full module graph from a new path
        // while keeping the registered extension and its install path intact.
        stage.make_directory(null);
        for (const file of MODULES)
            extension.dir.get_child(file).copy(stage.get_child(file), Gio.FileCopyFlags.NONE, null, null);
        const {default: Implementation} = await import(stage.get_child('extension.js').get_uri());
        const next = new Implementation({...metadata, dir: extension.dir, path: extension.path});
        if (extension.state !== ExtensionState.ACTIVE || manager.lookup(UUID) !== extension)
            throw new Error('Status RageNotch berubah selama pembaruan.');

        await manager._callExtensionDisable(UUID);
        if (extension.state !== ExtensionState.INACTIVE)
            throw new Error('Versi sebelumnya gagal dinonaktifkan.');

        extension.metadata = metadata;
        extension.stateObj = next;
        extension.error = '';
        await manager._callExtensionEnable(UUID);
        if (extension.state !== ExtensionState.ACTIVE) {
            const message = extension.error;
            try {
                next.disable();
            } catch (error) {
                logError(error, 'RageNotch: live update cleanup');
            }
            Object.assign(extension, previous);
            manager._changeExtensionState(extension, ExtensionState.INACTIVE);
            await manager._callExtensionEnable(UUID);
            throw new Error(`Versi baru gagal dimuat: ${message || 'status GNOME berubah'}`);
        }

        const oldStage = extension.ragenotchLiveStage;
        extension.ragenotchLiveStage = stage;
        keepStage = true;
        if (oldStage)
            clearStage(oldStage);
        return `RageNotch v${metadata.version} aktif di sesi ini.`;
    } finally {
        if (!keepStage)
            clearStage(stage);
        updating = false;
    }
}

function clearStage(stage) {
    for (const file of MODULES)
        remove(stage.get_child(file));
    remove(stage);
}

function remove(file) {
    try {
        file.delete(null);
    } catch (error) {
        if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            logError(error, 'RageNotch: live update files');
    }
}
