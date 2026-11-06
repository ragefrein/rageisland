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
    --extra-source=LICENSE-Tabler.txt \
    --out-dir="$bundle_dir" "$project_dir/linux"

gnome-extensions install "$@" "$bundle_dir/ragenotch@local.shell-extension.zip"

font_dir="${XDG_DATA_HOME:-$HOME/.local/share}/fonts/ragenotch"
fonts_changed=false
mkdir -p -- "$font_dir"
for font in Montserrat-SemiBold.ttf Montserrat-Bold.ttf; do
    if ! cmp -s -- "$project_dir/fonts/$font" "$font_dir/$font"; then
        install -m 644 -- "$project_dir/fonts/$font" "$font_dir/$font"
        fonts_changed=true
    fi
done
install -m 644 -- "$project_dir/fonts/OFL-Montserrat.txt" "$font_dir/OFL-Montserrat.txt"
if "$fonts_changed"; then
    fc-cache -f -- "$font_dir"
    printf '%s\n' 'Montserrat terpasang. Jika font belum berubah setelah pembaruan langsung, keluar dan masuk sekali agar GNOME membaca font baru.'
fi

if "$live"; then
    cat <<'INSTRUCTIONS'
RageNotch terpasang. Di desktop GNOME, tekan Alt+F2, ketik lg, lalu Enter.
Tempel baris berikut di Evaluator Looking Glass dan tekan Enter. Setelah versi baru aktif, tekan Esc.

await (await import(Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', 'ragenotch@local', 'live-update.js'])).get_uri())).update()
INSTRUCTIONS
else
    printf '%s\n' 'RageNotch terpasang. Keluar dan masuk lagi ke sesi desktop, lalu jalankan: gnome-extensions enable ragenotch@local'
fi
