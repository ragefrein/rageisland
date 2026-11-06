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

Installer menyertakan Montserrat SemiBold dan Bold untuk huruf Latin. Font dipasang di direktori font pengguna. Jika GNOME masih memakai font cadangan setelah pemasangan pertama, keluar dan masuk sekali agar sesi memuat Montserrat. Lisensi font tersedia di [OFL-Montserrat.txt](fonts/OFL-Montserrat.txt).

Arahkan kursor ke notch untuk membukanya, atau klik bagian atas agar tetap terbuka. Klik lagi untuk menutup. Jam lokal tampil saat notch ringkas maupun terbuka. Jika tersedia, lirik tampil di sisi kanan dan membungkus saat ruangnya terbatas. Keempat kontrol media diletakkan di bawah progress bar.

Saat panel media dibuka, RageNotch mengirim judul, artis, dan, jika tersedia, album serta durasi ke LRCLIB untuk mencari lirik sinkron. Setel `synced_lyrics` ke `false` untuk mematikan permintaan lirik.

## Tab Fokus, Agenda, dan Sistem

Titik di bawah panel menunjukkan tab aktif. Arahkan kursor ke titik untuk menampilkan ikon tab, atau gunakan fokus keyboard. [Tabler Icons](https://tabler.io/icons) · [Lisensi](linux/LICENSE-Tabler.txt)

- **Fokus** menyediakan timer Pomodoro 25 menit dan istirahat 5 menit. Gunakan tombol untuk mulai, jeda, ulangi, atau pindah fase. Waktu yang tersisa juga tampil di notch ringkas. White noise memakai `gst-launch-1.0` dengan plugin audio GStreamer.
- **Agenda** memakai sumber acara kalender bawaan GNOME. Klik tanggal atau gunakan panah untuk berpindah hari, bulan, dan tahun. Daftar acara mengikuti tanggal pilihan.
- **Baterai dan Bluetooth** memakai indikator lengkung hijau dan biru. Persentase Bluetooth tampil jika perangkat melaporkannya.
- **Shelf** menyimpan pintasan ke delapan file atau folder. Tambahkan dari pemilih file Zenity atau sematkan file dari riwayat Clipboard. Riwayat menyimpan delapan salinan sesi ini di memori, dengan batas 1 MiB per salinan.
- **Developer** punya tiga tampilan. **Port** memakai `ss` untuk memantau port TCP, jaringan, RAM, dan SSH. **GitHub** membaca branch dan perubahan dari repositori Git lokal yang dipilih, serta menyediakan pintasan ke remote GitHub. **Waktu IDE** menghitung waktu jendela editor yang dikenali saat aktif dalam sesi ini, dengan jeda setelah 60 detik tanpa aktivitas.

Klik **roda gigi di ujung kanan bawah** untuk memilih **Floating**, **Rapat ke atas**, dan **Lebar otomatis untuk lirik**. Dari jendela yang sama, pilih **Sembunyikan panel atas** agar notch bisa menempel langsung ke layar. Tombol **Super** menampilkan panel GNOME sementara di **Activities**. Opsi ini berlaku untuk panel atas bawaan GNOME yang terpisah.

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
