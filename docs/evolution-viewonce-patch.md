# Patch Evolution API — meneruskan pesan view-once

Status: **terpasang di aulia3 (2026-10-01)**. Wajib diterapkan ulang setiap kali
Evolution API di-upgrade (file ini hilang karena berada di luar repo adapter).

## Masalah

Pesan **lihat-sekali (view-once)** dari pelanggan tidak pernah sampai ke Inbox.
Klien WhatsApp mengirimkannya ke perangkat tertaut sebagai stanza
`<unavailable type="view_once">`: **tidak ada `message` sama sekali**, hanya
penanda `key.isViewOnce = true`.

Evolution API 2.3.7 membuang pesan tanpa `message` **sebelum** webhook dikirim:

```
src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts:1166
if ((type !== 'notify' && type !== 'append') || editedMessage || !received?.message) {
  continue;                       // view-once dibuang di sini
}
```

Akibatnya `sendDataWebhook(MESSAGES_UPSERT, ...)` (baris ~1483) tidak pernah
tercapai, dan adapter tidak menerima apa pun — pesan hilang senyap.

Perilaku ini sudah pernah ditangani di WA-Gateway lama (Baileys langsung):
commit `66bff03`, `src/whatsapp/connectionManager.js:923-950`
(`!msg.message && msg.key?.isViewOnce === true` -> placeholder teks).

## Patch (1 blok, sebelum baris 1166)

```diff
+          // PATCH-ADAPTER (2026-10-01): view-once dari HP tiba sebagai stanza
+          // <unavailable type="view_once"> -- TANPA `message`, hanya
+          // key.isViewOnce. Tanpa rekonstruksi ini Evolution membuang pesannya
+          // dan webhook MESSAGES_UPSERT tidak pernah dikirim, sehingga pesan
+          // hilang senyap (perilaku WA-Gateway lama: connectionManager.js:923).
+          // Isi kosong diisi placeholder agar prepareMessage() aman; adapter
+          // mengenali key.isViewOnce dan membuat baris penandanya sendiri.
+          if (!received?.message && received?.key?.isViewOnce) {
+            received.message = { conversation: '' } as any;
+          }
+
           if ((type !== 'notify' && type !== 'append') || editedMessage || !received?.message) {
             continue;
           }
```

`received.message` diisi objek valid minimal supaya `prepareMessage()`
(baris ~4653: `message?.message[contentType]`) tidak error. `key` diteruskan
apa adanya sehingga `key.isViewOnce` tetap ikut ke payload webhook.

Sisi adapter (`src/evolution/normalize.js`, `isViewOnceMessage()`): bila
`key.isViewOnce === true` (atau ada pembungkus `viewOnceMessage*`), pesan
dijadikan baris penanda
`[Pelanggan mengirim pesan lihat-sekali — isinya tidak dapat ditampilkan di Inbox]`
dan **media TIDAK diunduh** (paritas CON-002 gateway lama). View-once keluar
(`fromMe=true`) diabaikan.

## Cara menerapkan (setelah upgrade Evolution)

1. Backup:
   `copy whatsapp.baileys.service.ts whatsapp.baileys.service.ts.orig-<tanggal>`
2. Tambahkan blok di atas tepat sebelum `if ((type !== 'notify' ...`.
3. Restart Evolution (task `AuliaEvolution`).
4. Pastikan `GET /instance/connectionState/:instance` -> `{"state":"open"}`.

## Cara memverifikasi

Kirim 1 foto "lihat-sekali" dari HP lain ke nomor gateway, lalu:

- `D:\kilo\logs\adapter.log` harus memuat `[EVOLUTION-HOOK] event diterima`.
- Inbox harus memuat 1 baris `unsupported` bertulis
  `[Pelanggan mengirim pesan lihat-sekali — ...]` dengan media kosong.
- Antrean tidak bertambah `dead`.

Referensi: `docs/uji-inbox-tipe-pesan-nyata.md` (kasus 6) di repo AuliaPos.
