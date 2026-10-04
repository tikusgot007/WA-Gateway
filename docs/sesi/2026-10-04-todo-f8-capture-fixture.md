# TODO-F8: Capture one real MESSAGE_EDIT fixture

Status: diagnostic tooling only. The production branch is unchanged.

## Tujuan

Capture exactly one real WhatsApp message edit so the encrypted edit can be reproduced offline. The fixture is intentionally stored outside Git and never includes the original or edited plaintext.

## Aktifkan sementara

Set these environment variables on the WA-Gateway process:

```text
EVOLUTION_CAPTURE_EDIT_FIXTURE=1
EVOLUTION_CAPTURE_EDIT_FIXTURE_PATH=./data/message-edit-fixture.json
```

Optional: restrict capture to one known original message ID:

```text
EVOLUTION_CAPTURE_EDIT_FIXTURE_TARGET=<wa_message_id>
```

Do not enable the overwrite flag unless replacing an existing fixture intentionally.

## Urutan uji

1. Start/restart WA-Gateway with capture enabled.
2. From the WhatsApp customer account, send a new plain text message to the connected store account. Use a fresh message so the original arrives while capture tooling is enabled and is retained by quotedStore.
3. Edit that exact message once on WhatsApp.
4. Check `data/message-edit-fixture.json` on the gateway host.
5. Disable `EVOLUTION_CAPTURE_EDIT_FIXTURE` and restart the gateway.

The capture hook runs only on a detected `secretEncryptedMessage` edit. It looks up the original message by `targetMessageKey.id` in the existing quotedStore, extracts its `messageContextInfo.messageSecret`, and writes the encrypted edit material atomically.

## Isi fixture

The file contains:

- original message key
- original messageSecret as base64
- edit message key
- secretEncType
- targetMessageKey
- encIv as base64
- encPayload as base64

It does not contain message plaintext. It must be treated as sensitive key material and deleted after the regression fixture has been transferred to the controlled test location.

## Security

`data/` is already listed in `.gitignore`. The writer also requests file mode `0600` and writes through a temporary file followed by rename. Windows may not enforce POSIX permission bits; the fixture should still be handled as sensitive local data.

Capture failures are diagnostic-only. They never block the existing TODO-F7 lifecycle path.

## Setelah fixture tersedia

Use the fixture offline to validate, in this order:

1. sender candidate construction
2. HKDF-SHA256 derivation
3. AES-256-GCM authentication/decryption
4. protobuf decoding of the plaintext
5. extraction of edited text

Only after those checks pass should TODO-F8 production integration be added.

## Status implementasi decryptor

Branch ini sekarang juga memuat decryptor TODO-F8 yang terpisah dari normalizer:

- src/evolution/messageEditCrypto.js: HKDF-SHA256 -> AES-256-GCM -> minimal strict protobuf wire/text validation.
- src/evolution/messageEditResolver.js: mengambil messageSecret dari pesan original, menyusun sender candidates, lalu hanya mengembalikan teks bila GCM dan protobuf valid.
- EVOLUTION_DECRYPT_MESSAGE_EDIT=1 mengaktifkan integrasi hasil dekripsi ke lifecycle event.
- Bila dekripsi gagal, TODO-F7 tetap mengirim marker edited tanpa mengganti teks lama.
- AuliaPos menerima edited_text hanya pada event edited; teks tersebut menggantikan teks pesan ASLI, sementara edited_at tetap first-seen/idempoten.

Integrasi produksi tetap OFF by default sampai satu real fixture WhatsApp berhasil didecrypt dan decode. Synthetic test hanya memvalidasi framing AES-GCM, candidate fallback, serta parser protobuf; synthetic round-trip bukan bukti interoperabilitas WhatsApp.
