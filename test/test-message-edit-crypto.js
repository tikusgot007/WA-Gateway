'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  messageEditKey,
  decryptMessageEdit,
  decodeEditedTextPayload,
  decryptAndDecodeEditedText,
  messageEditSenderCandidates,
} = require('../src/evolution/messageEditCrypto');
const { resolveMessageEditText } = require('../src/evolution/messageEditResolver');
const { unwrapMessage } = require('../src/evolution/normalize');

const ORIG_ID = '3EB0F8TESTMESSAGE';
const SENDERS = {
  origMsgSender: '628123456789@s.whatsapp.net',
  editSender: '628123456789@s.whatsapp.net',
};

function varint(value) {
  const out = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n % 128) + 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

function field(number, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([varint(number * 8 + 2), varint(body.length), body]);
}

function conversation(text) {
  return field(1, text);
}

function extendedText(text) {
  return field(6, field(1, text));
}

function protocolEdited(text) {
  return field(12, field(14, conversation(text)));
}

function futureProofEdited(text) {
  return field(58, field(1, extendedText(text)));
}

function seal(plaintext, messageSecret, senders = SENDERS) {
  const iv = crypto.randomBytes(12);
  const key = messageEditKey({
    ...senders,
    origMsgId: ORIG_ID,
    messageSecret,
  });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.alloc(0));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    encIv: iv,
    encPayload: Buffer.concat([ciphertext, cipher.getAuthTag()]),
  };
}

try {
  const secret = crypto.randomBytes(32);

  assert.strictEqual(messageEditKey({
    ...SENDERS,
    origMsgId: ORIG_ID,
    messageSecret: secret,
  }).length, 32);

  const a = messageEditKey({
    ...SENDERS,
    origMsgId: ORIG_ID,
    messageSecret: secret,
  });
  const b = messageEditKey({
    ...SENDERS,
    origMsgId: 'OTHER',
    messageSecret: secret,
  });
  assert.notDeepStrictEqual(a, b, 'message id must bind the derived key');

  const reversed = messageEditKey({
    origMsgSender: SENDERS.editSender,
    editSender: SENDERS.origMsgSender,
    origMsgId: ORIG_ID,
    messageSecret: secret,
  });
  assert.notDeepStrictEqual(a, reversed, 'sender order must bind the derived key');

  const plaintext = extendedText('teks hasil edit');
  const sealed = seal(plaintext, secret);

  const wrongPair = {
    origMsgSender: '553499990001@s.whatsapp.net',
    editSender: '553499990001@s.whatsapp.net',
  };
  const decrypted = decryptMessageEdit({
    ...sealed,
    origMsgId: ORIG_ID,
    messageSecret: secret,
    senderCandidates: [wrongPair, SENDERS],
  });
  assert.ok(decrypted);
  assert.deepStrictEqual(decrypted.senders, SENDERS);
  assert.strictEqual(
    decodeEditedTextPayload(decrypted.plaintext).text,
    'teks hasil edit',
  );

  const endToEnd = decryptAndDecodeEditedText({
    ...sealed,
    origMsgId: ORIG_ID,
    messageSecret: secret,
    senderCandidates: [wrongPair, SENDERS],
  });
  assert.ok(endToEnd);
  assert.strictEqual(endToEnd.text, 'teks hasil edit');

  const resolverResult = resolveMessageEditText({
    record: {
      key: {
        id: 'EDIT-1',
        fromMe: false,
        remoteJid: SENDERS.editSender,
      },
    },
    messageObj: {
      secretEncryptedMessage: {
        secretEncType: 2,
        targetMessageKey: {
          id: ORIG_ID,
          fromMe: false,
          remoteJid: SENDERS.origMsgSender,
        },
        encIv: sealed.encIv,
        encPayload: sealed.encPayload,
      },
    },
    quotedStore: {
      get(id) {
        return id === ORIG_ID
          ? {
              key: { id: ORIG_ID, fromMe: false, remoteJid: SENDERS.origMsgSender },
              message: { messageContextInfo: { messageSecret: secret } },
            }
          : null;
      },
    },
  });
  assert.ok(resolverResult);
  assert.strictEqual(resolverResult.text, 'teks hasil edit');

  const wrapped = unwrapMessage({
    ephemeralMessage: {
      message: {
        conversation: 'isi',
      },
    },
    messageContextInfo: {
      messageSecret: secret,
    },
  });
  assert.strictEqual(wrapped.conversation, 'isi');
  assert.deepStrictEqual(wrapped.messageContextInfo.messageSecret, secret);

  assert.strictEqual(
    decodeEditedTextPayload(conversation('versi percakapan')).text,
    'versi percakapan',
  );

  assert.strictEqual(
    decodeEditedTextPayload(protocolEdited('versi protocol')).text,
    'versi protocol',
  );

  assert.strictEqual(
    decodeEditedTextPayload(futureProofEdited('versi future-proof')).text,
    'versi future-proof',
  );

  assert.strictEqual(
    decodeEditedTextPayload(Buffer.from([0x0a, 0x05, 0xff, 0xff, 0xff, 0xff, 0xff])),
    null,
  );

  assert.strictEqual(
    decodeEditedTextPayload(Buffer.from([0x0a, 0x05, 0x41, 0x42])),
    null,
  );

  assert.strictEqual(
    decryptMessageEdit({
      encPayload: Buffer.alloc(16),
      encIv: crypto.randomBytes(12),
      origMsgId: ORIG_ID,
      messageSecret: secret,
      senderCandidates: [SENDERS],
    }),
    null,
  );

  const editKey = {
    id: 'EDIT-1',
    fromMe: false,
    remoteJid: '628123456789@s.whatsapp.net',
    remoteJidAlt: '123456789@lid',
  };
  const targetKey = {
    id: ORIG_ID,
    fromMe: false,
    remoteJid: '628123456789@s.whatsapp.net',
    remoteJidAlt: '123456789@lid',
  };
  const candidates = messageEditSenderCandidates({ editKey, targetKey });
  assert.ok(candidates.some((pair) =>
    pair.origMsgSender === '628123456789@s.whatsapp.net'
    && pair.editSender === '628123456789@s.whatsapp.net',
  ));
  assert.ok(candidates.some((pair) =>
    pair.origMsgSender === '628123456789@s.whatsapp.net'
    && pair.editSender === '123456789@lid',
  ));

  // Optional real-fixture validation. The fixture itself is sensitive and must
  // stay untracked; this test only reports pass/fail, never payload/text/key.
  const fixturePath = path.resolve(process.cwd(), 'data/message-edit-fixture.json');
  if (fs.existsSync(fixturePath)) {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const messageSecret = Buffer.from(fixture.original.message_secret_base64, 'base64');
    const senderCandidates = messageEditSenderCandidates({
      editKey: fixture.edit.key || {},
      targetKey: fixture.edit.target_message_key || fixture.original.key || {},
      storedSenders: [
        fixture.original.key?.participant,
        fixture.original.key?.remoteJid,
        fixture.original.key?.participantAlt,
        fixture.original.key?.remoteJidAlt,
      ],
    });

    const result = decryptAndDecodeEditedText({
      encPayload: Buffer.from(fixture.edit.enc_payload_base64, 'base64'),
      encIv: Buffer.from(fixture.edit.enc_iv_base64, 'base64'),
      origMsgId: fixture.edit.target_message_key.id,
      messageSecret,
      senderCandidates,
    });

    assert.ok(result, 'real TODO-F8 fixture must decrypt and decode');
    assert.strictEqual(typeof result.text, 'string');
    console.log('OK: TODO-F8 real fixture decrypts and decodes.');
  }

  console.log('OK: TODO-F8 message edit crypto tests passed.');
} finally {
  // no-op; optional fixture is intentionally not deleted here
}
