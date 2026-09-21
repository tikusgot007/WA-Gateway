# M1 Ticket 01 — Baseline Test: hasil pengukuran

Tanggal: 2026-09-21 · Mesin: Aan-PC · Gateway: `5b28eb6` (branch `feature/stage-1-reliability`), Node v20.20.2, Baileys 6.7.24
Nomor Gateway: `6281913500707` · Nomor tes (HP pengirim/penerima): `628563324637`
Database: bukan produksi (AuliaPos lokal berisi data tes). Backup sebelum/sesudah ada di `C:\projects\_backup-m1-ticket01\`.

Ticket 01 murni pengukuran: tidak ada kode yang diubah. Perbaikan mulai dari ticket 02.

## Ringkasan

| Baseline | Hasil | Status |
|---|---|---|
| 1. Enqueue normal | Otomatis (mock CI4): 50/50 `completed` dalam 1 siklus. Versi asli (pesan WhatsApp nyata vs AuliaPos): lihat bagian "Belum selesai" | Sebagian |
| 2. Restart saat burst | Pesan hilang: 3/14 (percobaan 2) dan 3/15 (percobaan 3). Penyebab teridentifikasi dari kode + log, bukan dekripsi | Selesai (percobaan 1 tidak bisa dinilai) |
| 3. Duplicate-on-timeout | Retry `/send` setelah client putus: duplikat 2 dari 3 percobaan | Selesai |
| 4. Retry/backoff | Pulih tanpa kehilangan (mock CI4). Tidak ada batas percobaan / dead-letter (dari kode) | Selesai, dengan catatan |

## Baseline 2 — Restart Gateway saat burst pesan masuk

Metode: `kill-at.js` mematikan proses Gateway (`taskkill /F`, setara SIGKILL) tepat saat baris ke-K masuk `incoming_queue`; PM2 menyalakan ulang otomatis. Burst dikirim manual dari HP tes.

| Percobaan | K | Terkirim | Tercatat di antrean & AuliaPos | Hilang | Reconnect setelah kill |
|---|---|---|---|---|---|
| 1 | 2 | tidak dihitung | 3 stiker | tidak bisa dinilai | 3,6 s |
| 2 | 6 | 14 | 11 | 3 (B, Ha, D — berurutan tepat setelah titik kill) | 2,5 s |
| 3 | 10 | 15 | 12 | 3 (posisi 11–13 — berurutan tepat setelah titik kill) | 2,5 s |

Pencocokan dilakukan dengan tangkapan layar obrolan HP tes vs tabel `messages` AuliaPos. Semua pesan yang hilang tampil dua centang di HP pengirim.

Pesan yang sudah masuk `incoming_queue` sebelum kill selalu terkirim ke AuliaPos setelah restart (`attempts=0`, tanpa duplikat). Pesan yang tiba real-time sesudah `connected` juga aman. Yang hilang adalah pesan yang tiba **saat Gateway mati**.

### Penyebab (verifikasi kode + log debug pada percobaan 3)

1. Saat reconnect, WhatsApp mengirim ulang pesan tertunda dan menandainya offline. Baileys 6.7.24 `lib/Socket/messages-recv.js:699`: `upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')`.
2. Gateway `src/whatsapp/connectionManager.js:385` (`_onMessagesUpsert`): `if (type !== 'notify') return;` — semua event `append` dibuang tanpa log.
3. Baileys sudah mengirim tanda terima (`sending receipt for messages`, type `inactive`) untuk pesan itu, sehingga WhatsApp menganggapnya terkirim dan tidak mengirim ulang.
4. Bukti log percobaan 3: 3 ID pesan (`A572E52D…`, `A5490942…`, `A54AE9EE…`) di-ack pada 06:33:49,5–49,7 UTC, tetapi tidak ada baris `pesan masuk diterima`, tidak ada di `incoming_queue`, tidak ada di AuliaPos. Pesan berikutnya (`A59AC2DD…`) masuk normal.
5. Tidak ada `Bad MAC`, `MessageCounterError`, atau `Failed to decrypt` di log level debug pada jendela kill.

Batasan yang harus tetap dicatat:
- Tipe `append` pada tiga ID itu **belum diamati langsung di runtime**. Yang terverifikasi: kode di kedua sisi dan urutan kejadian di log.
- Log Baileys mencatat `handled 2 offline messages/notifications` (percobaan 2 dan 3), sedangkan yang hilang 3 pesan; selisih satu belum terjelaskan.
- Penyebabnya bukan `SIGKILL` itu sendiri: pesan apa pun yang tiba saat Gateway offline (restart biasa, crash, listrik mati) akan bernasib sama.

### Status hipotesis kasus `AC0B72AD…` (Tahap 0)

Hipotesis lama: kegagalan dekripsi terjadi tepat setelah restart Gateway.
**Dibantah untuk mekanismenya** (tidak ada bukti dekripsi gagal di log debug), **dikonfirmasi untuk polanya** (pesan hilang terkait restart). Pengganti yang lebih mungkin: pesan offline dibuang oleh filter `type !== 'notify'`. Belum diuji ulang terhadap kasus `AC0B72AD…` itu sendiri.

## Baseline 3 — Duplicate-on-timeout pada `POST /send`

Metode: `POST /send` (`chat_id`=nomor tes, token dari `.env`), lalu kirim ulang teks identik sebagai simulasi retry CI4.

| Percobaan | Gangguan | Kiriman #1 | Kiriman #2 | Muncul di HP tes |
|---|---|---|---|---|
| T1 | client diputus 30 ms setelah kirim | server tetap menyelesaikan kirim (`3EB023CF…`) | sukses (`3EB0991A…`) | **2×** |
| T2 | Gateway dimatikan paksa 30 ms setelah kirim | tidak sempat keluar (`ECONNRESET`, log hanya `[SEND] mengirim`) | sukses (`3EB064612A…`) | **1×** (kiriman #1 hilang, tidak duplikat) |
| T3 | client diputus 5 ms setelah kirim | server tetap menyelesaikan kirim (`3EB0545B…`) | sukses (`3EB056345F…`) | **2×** |

- Server tidak membatalkan proses kirim saat client memutus koneksi, dan `/send` tidak menerima idempotency key (dikonfirmasi dari `src/api/ci4Routes.js`).
- T2 bergantung pada timing kill. Kill yang jatuh setelah pesan keluar dan sebelum response akan menghasilkan duplikat; dengan 3 percobaan dan satu titik timing, frekuensinya tidak bisa disimpulkan.
- Tidak diuji: sisi UI AuliaPos (status menggantung/error saat Gateway mati) — Gateway dipanggil langsung.
- Catatan pengukuran: pencarian teks pesan keluar dari `/send` di `incoming_queue` selalu 0 baris, jadi hitungan otomatis lewat antrean tidak valid untuk pesan keluar dan tidak dipakai. Penyebabnya belum diselidiki.

## Baseline 4 — Retry/backoff

- Otomatis (`test/simulate-reliability-baseline.js --scenario=retry`, mock CI4): saat CI4 membalas 503, 3 pesan tetap pending dan dijadwalkan ulang 3000 ms; setelah CI4 pulih semuanya `completed`, tidak ada yang hilang.
- Dari kode (`incomingBuffer.js` `markFailedAttempt`, `config/index.js`): delay `min(3000 × 2^attempts, 120000)` ms. **Tidak ada `maxAttempts` maupun dead-letter** — pesan yang gagal dicoba tiap 120 s tanpa batas. Belum diamati berjalan lama di runtime.
- Skrip tidak memverifikasi rumus backoff lewat `next_attempt_at`; hanya penjadwalan pertama (3000 ms) yang terlihat di log.

## Belum selesai

- Baseline 1 versi asli: 30–50 pesan nyata (incoming dan fromMe) dibandingkan dengan `incoming_queue` dan `messages` AuliaPos.
- Skenario 2 percobaan 1 diulang dengan pesan berhuruf unik dan hitungan kirim yang dicatat.
- Perilaku UI Inbox AuliaPos saat Gateway mati di tengah kirim.

## Masukan untuk ticket berikutnya (tanpa diperbaiki di sini)

- **Ticket 02 (audit enqueue)**: temuan `type !== 'notify'` adalah kandidat perbaikan langsung untuk risiko P0 #1 (pesan masuk hilang).
- **Ticket 06–07 (attempt counter, dead-letter)**: konfirmasi dari kode bahwa retry tak terbatas.
- **Ticket 09–10 (operation ID, idempotency)**: konfirmasi runtime bahwa retry `/send` menduplikasi pesan.
