#!/usr/bin/env bash
set -euo pipefail

live=false
if [[ ${1:-} == --live ]]; then
    live=true
    shift
    set -- --force "$@"
fi

project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bundle_dir=$(mktemp -d)
trap 'rm -r -- "$bundle_dir"' EXIT

gnome-extensions pack \
    --extra-source=assets.js \
    --extra-source=config.js \
    --extra-source=media.js \
    --extra-source=utilities.js \
    --extra-source=live-update.js \
    --out-dir="$bundle_dir" "$project_dir/linux"

gnome-extensions install "$@" "$bundle_dir/ragenotch@local.shell-extension.zip"
if "$live"; then
    cat <<'INSTRUCTIONS'
RageNotch terpasang. Di desktop GNOME, tekan Alt+F2, ketik lg, lalu Enter.
Tempel baris berikut di Evaluator Looking Glass dan tekan Enter. Setelah versi baru aktif, tekan Esc.

await (await import(Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'ragenotch@local', 'live-update.js'])).get_uri())).update()
INSTRUCTIONS
else
    printf '%s\n' 'RageNotch terpasang. Keluar dan masuk lagi ke sesi desktop, lalu jalankan: gnome-extensions enable ragenotch@local'
fi
