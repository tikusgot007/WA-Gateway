# Patch Evolution API — preservasi LID untuk TODO-F8

Status: **patch deployment adapter**, terpisah dari Rekonstruksi View-Once.

## Tujuan

Evolution mempertahankan perilaku kompatibilitas yang mengubah:

```
remoteJid = <customer>@lid
remoteJidAlt = <customer>@s.whatsapp.net
```

menjadi:

```
remoteJid = <customer>@s.whatsapp.net
remoteJidAlt = <customer>@s.whatsapp.net
```

sebelum webhook `MESSAGES_UPSERT` dikirim.

Untuk TODO-F8, LID asli dibutuhkan sebagai salah satu kandidat identitas sender dalam KDF MESSAGE_EDIT. Karena itu patch ini **tidak** mengubah arti `remoteJidAlt`.

Target setelah patch:

```
remoteJid    = <customer>@s.whatsapp.net
remoteJidAlt  = <customer>@s.whatsapp.net
remoteJidLid  = <customer>@lid
```

Field `remoteJidLid` adalah metadata internal milik adapter; tidak dikirim sebagai field domain baru ke AuliaPos.

## Perubahan

Sebelum overwrite PN:

```ts
if (messageRaw.key.remoteJid?.includes('@lid') && messageRaw.key.remoteJidAlt) {
  messageRaw.key.remoteJidLid = messageRaw.key.remoteJid;
  messageRaw.key.remoteJid = messageRaw.key.remoteJidAlt;
}
```

Gateway F8 kemudian memasukkan `remoteJidLid` ke kandidat `origMsgSender` / `editSender`.

Dengan demikian:

- PN tetap dipakai sebagai `chatId` / identitas Inbox.
- `remoteJidAlt` tidak disalahgunakan sebagai LID.
- LID tersedia untuk derivasi kunci MESSAGE_EDIT.
- TODO-F7 tetap menggunakan target message ID dan lifecycle marker seperti sebelumnya.

## Logging

Patch ini juga menghapus dua raw-payload log di jalur tersebut:

- `this.logger.verbose(messageRaw)`
- `console.log(messageRaw)`

Tujuannya mencegah struktur pesan lengkap masuk ke log, termasuk metadata sensitif dari MESSAGE_EDIT.

## Installer

Scrpt:

```
installer/apply-lid-preservation-patch.ps1
```

bersifat idempotent dan membuat backup pertama kali. Installer utama menjalankan patch ini setelah patch Rekonstruksi View-Once.

Setelah upgrade Evolution, jika anchor source berubah, installer sengaja **gagal dengan jelas** daripada menerapkan patch pada lokasi yang tidak dikenal.

## Verifikasi

Regression test:

```
installer/tests/check-lid-preservation-patch.ps1
```

Setelah deployment, verifikasi wajib dengan satu edit WhatsApp nyata:

1. pesan original masuk dan tersimpan oleh gateway;
2. customer mengedit pesan;
3. webhook edit masih membawa metadata `remoteJidLid`;
4. Gateway F8 berhasil menurunkan kunci dan decode payload;
5. AuliaPos menerima `edited_text`;
6. TODO-F7 marker tetap `edited`.

Patch ini **tidak menggantikan** Rekonstruksi View-Once. Keduanya menyelesaikan masalah yang berbeda.