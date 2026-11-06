# RageNotch untuk Linux

RageNotch adalah ekstensi GNOME Shell 46 untuk Zorin OS 18.1. Overlay memakai aktor GNOME Shell sehingga tidak memerlukan proses UI terpisah. Jika panel desktop ada di atas layar, notch muncul tepat di bawahnya.

## Pasang dan aktifkan

Pasang dari direktori proyek dalam sesi GNOME.

```bash
./install-linux.sh
```

Jika RageNotch sudah terpasang, gunakan `./install-linux.sh --force` untuk memperbarui. Setelah memasang atau memperbarui di Wayland, keluar dari sesi desktop, masuk kembali, lalu aktifkan ekstensi.

```bash
gnome-extensions enable ragenotch@local
```

### Perbarui tanpa keluar dari sesi

Jika RageNotch sudah aktif di GNOME Shell 46, jalankan `./install-linux.sh --live`. Tekan **Alt+F2**, ketik `lg`, lalu tekan Enter untuk membuka Looking Glass. Tempel baris JavaScript yang dicetak installer ke tab **Evaluator**, tekan Enter, lalu tutup dengan Esc setelah muncul pesan bahwa versi baru aktif. Pembaruan ini memuat ulang RageNotch, termasuk mereset timer Fokus yang sedang berjalan.

Arahkan kursor ke notch untuk membukanya, atau klik judulnya agar tetap terbuka. Klik judul sekali lagi untuk menutup. Putar lagu atau video di aplikasi yang mengekspos MPRIS untuk melihat judul, sampul, posisi, dan kontrol media. Pendaran mengikuti warna sampul ketika sampul tersedia.

Saat panel media dibuka, RageNotch mengirim judul, artis, dan, jika tersedia, album serta durasi ke LRCLIB untuk mencari lirik sinkron. Setel `synced_lyrics` ke `false` untuk mematikan permintaan lirik.

## Tab Fokus, Agenda, dan Sistem

- **Fokus** menyediakan timer Pomodoro 25 menit dan istirahat 5 menit. Gunakan tombol untuk mulai, jeda, ulangi, atau pindah fase. Waktu yang tersisa juga tampil di notch ringkas. White noise memakai `gst-launch-1.0` dengan plugin audio GStreamer.
- **Agenda** menampilkan jadwal hari ini dari kalender yang sudah terhubung ke GNOME. Buka kalender GNOME lewat tombol di tab ini bila jadwal hari ini belum termuat.
- **Sistem** menampilkan daya laptop dan perangkat Bluetooth yang tersambung. Persentase perangkat tampil jika perangkat melaporkannya ke BlueZ.

Untuk menyisakan RageNotch di tengah atas layar, buka **Sistem → Sembunyikan panel atas**. Panel GNOME tetap bisa diakses dari tampilan **Activities** lewat tombol **Super** atau lewat tombol kalender di tab **Agenda**. Pilih **Tampilkan panel atas** untuk mengembalikannya. Pengaturan ini disimpan sebagai `behavior.hide_top_panel` dan berlaku untuk panel atas bawaan GNOME yang terpisah.

Untuk menampilkan HUD volume dan kecerahan di notch saat tersedia, aktifkan `modules.system_hud`. Ketika notch tersembunyi, GNOME menampilkan HUD bawaannya.

## Konfigurasi

Aplikasi berjalan dengan pengaturan bawaan. Untuk menyesuaikannya, salin contoh ke direktori konfigurasi pengguna:

```bash
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/ragenotch"
mkdir -p "$config_dir"
cp -n config.example.json "$config_dir/config.json"
```

Pilihan `style` adalah `attached_notch`, `floating_island`, dan `minimalist_pill`. Pilihan `position` adalah `top_left`, `top_center`, dan `top_right` pada monitor utama. Preset animasinya `apple_fluid`, `bouncy`, `snappy`, dan `instant`. Nilai numerik opsional `stiffness` dan `damping` dapat ditambahkan di dalam `physics`. Setel `chameleon_glow` ke `off` untuk mematikan pendaran.

Ubah durasi lewat `pomodoro.focus_minutes` dan `pomodoro.break_minutes`. Setel `pomodoro.auto_white_noise` ke `true` agar white noise ikut berjalan selama fase fokus. Setel `pomodoro`, `calendar`, `battery`, atau `bluetooth` ke `false` di dalam `modules` untuk menyembunyikan fitur tersebut.

Setelah menyimpan perubahan, nonaktifkan dan aktifkan kembali ekstensi:

```bash
gnome-extensions disable ragenotch@local
gnome-extensions enable ragenotch@local
```
# rageisland
