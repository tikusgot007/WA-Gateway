'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  captureMessageEditFixture,
  editEnvelope,
  extractMessageSecret,
} = require('../src/evolution/messageEditFixture');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-gateway-f8-'));
const fixture = path.join(tmp, 'message-edit-fixture.json');

try {
  const secret = Buffer.alloc(32, 7);
  const original = {
    key: { id: 'ORIGINAL-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: { messageContextInfo: { messageSecret: {
      0: 7, 1: 7, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 7,
      8: 7, 9: 7, 10: 7, 11: 7, 12: 7, 13: 7, 14: 7, 15: 7,
      16: 7, 17: 7, 18: 7, 19: 7, 20: 7, 21: 7, 22: 7, 23: 7,
      24: 7, 25: 7, 26: 7, 27: 7, 28: 7, 29: 7, 30: 7, 31: 7,
    } } },
  };

  assert.strictEqual(extractMessageSecret(original.message).equals(secret), true);
  assert.deepStrictEqual(extractMessageSecret({ messageSecret: secret }), secret);

  const editMessage = {
    secretEncryptedMessage: {
      secretEncType: 2,
      targetMessageKey: original.key,
      encIv: { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11, 11: 12 },
      encPayload: { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 10: 11, 11: 12, 12: 13, 13: 14, 14: 15, 15: 16, 16: 17 },
    },
  };
  const parsed = editEnvelope(editMessage);
  assert.ok(parsed);
  assert.strictEqual(parsed.targetId, 'ORIGINAL-1');
  assert.strictEqual(parsed.encIv.length, 12);
  assert.strictEqual(parsed.encPayload.length, 17);

  const store = { get(id) { return id === 'ORIGINAL-1' ? original : null; } };
  const env = {
    EVOLUTION_CAPTURE_EDIT_FIXTURE: '1',
    EVOLUTION_CAPTURE_EDIT_FIXTURE_PATH: fixture,
  };
  let result = captureMessageEditFixture({
    record: { key: { id: 'EDIT-1', remoteJid: '628111@s.whatsapp.net', fromMe: false } },
    messageObj: editMessage,
    quotedStore: store,
    instance: 'aulia-test',
    env,
  });
  assert.strictEqual(result.captured, true);

  const parsedFixture = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  assert.strictEqual(parsedFixture.original.key.id, 'ORIGINAL-1');
  assert.strictEqual(parsedFixture.original.message_secret_base64, secret.toString('base64'));
  assert.strictEqual(parsedFixture.edit.key.id, 'EDIT-1');
  assert.strictEqual(parsedFixture.edit.enc_iv_base64, Buffer.from([1,2,3,4,5,6,7,8,9,10,11,12]).toString('base64'));
  assert.ok(parsedFixture.edit.enc_payload_base64);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(parsedFixture.original, 'plaintext'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(parsedFixture.edit, 'plaintext'), false);

  const mode = fs.statSync(fixture).mode & 0o777;
  if (process.platform !== 'win32') assert.strictEqual(mode, 0o600);

  result = captureMessageEditFixture({
    record: { key: { id: 'EDIT-2' } },
    messageObj: editMessage,
    quotedStore: store,
    env,
  });
  assert.strictEqual(result.captured, false);
  assert.strictEqual(result.reason, 'fixture_exists');

  result = captureMessageEditFixture({
    record: { key: { id: 'EDIT-3' } },
    messageObj: editMessage,
    quotedStore: store,
    env: { ...env, EVOLUTION_CAPTURE_EDIT_FIXTURE_TARGET: 'OTHER' },
  });
  assert.strictEqual(result.reason, 'target_mismatch');

  const wrongStore = { get() { return null; } };
  result = captureMessageEditFixture({
    record: { key: { id: 'EDIT-4' } },
    messageObj: editMessage,
    quotedStore: wrongStore,
    env: { ...env, EVOLUTION_CAPTURE_EDIT_FIXTURE_PATH: path.join(tmp, 'missing.json'), EVOLUTION_CAPTURE_EDIT_FIXTURE_OVERWRITE: '1' },
  });
  assert.strictEqual(result.reason, 'original_not_in_quoted_store');

  console.log('OK: TODO-F8 fixture capture tests passed.');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
