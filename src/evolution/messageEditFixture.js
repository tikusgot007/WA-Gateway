'use strict';

const fs = require('fs');
const path = require('path');

/**
 * One-shot capture aid for TODO-F8.
 *
 * IMPORTANT:
 * - Disabled by default.
 * - Captures only when EVOLUTION_CAPTURE_EDIT_FIXTURE=1/true.
 * - Optional EVOLUTION_CAPTURE_EDIT_FIXTURE_TARGET restricts capture to one
 *   original wa_message_id.
 * - Stores the fixture outside Git (default ./data/message-edit-fixture.json).
 * - Never logs secrets, ciphertext, or plaintext.
 * - Refuses to overwrite an existing fixture unless
 *   EVOLUTION_CAPTURE_EDIT_FIXTURE_OVERWRITE=1/true.
 *
 * The fixture contains enough protocol material to reproduce the decrypt step
 * offline: original message key + messageSecret, and the edit key + encrypted
 * payload/IV. It intentionally does NOT store original/edited plaintext.
 */

function enabled(value) {
  return value === '1' || value === 'true' || value === 'TRUE';
}

function isEnabled(env = process.env) {
  return enabled(String(env.EVOLUTION_CAPTURE_EDIT_FIXTURE || ''));
}

function allowOverwrite(env = process.env) {
  return enabled(String(env.EVOLUTION_CAPTURE_EDIT_FIXTURE_OVERWRITE || ''));
}

function fixturePath(env = process.env) {
  return path.resolve(
    process.cwd(),
    env.EVOLUTION_CAPTURE_EDIT_FIXTURE_PATH || './data/message-edit-fixture.json',
  );
}

function targetFilter(env = process.env) {
  const value = String(env.EVOLUTION_CAPTURE_EDIT_FIXTURE_TARGET || '').trim();
  return value || null;
}

function bytesFrom(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) && value.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return Buffer.from(value);
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const ordered = keys.sort((a, b) => Number(a) - Number(b)).map((k) => value[k]);
      if (ordered.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        return Buffer.from(ordered);
      }
    }
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const buf = Buffer.from(value, 'base64');
      return buf.length > 0 ? buf : null;
    } catch {
      return null;
    }
  }
  return null;
}

function extractMessageSecret(storedMessage) {
  if (!storedMessage || typeof storedMessage !== 'object') return null;
  const direct = storedMessage.messageContextInfo?.messageSecret;
  const secret = bytesFrom(direct);
  if (secret && secret.length > 0) return secret;
  const historySecret = bytesFrom(storedMessage.messageSecret);
  return historySecret && historySecret.length > 0 ? historySecret : null;
}

function editEnvelope(messageObj) {
  if (!messageObj || typeof messageObj !== 'object') return null;
  const sem = messageObj.secretEncryptedMessage;
  if (!sem || typeof sem !== 'object') return null;
  const type = sem.secretEncType;
  const isMessageEdit = Number(type) === 2 || type === 'MESSAGE_EDIT';
  if (!isMessageEdit) return null;
  const target = sem.targetMessageKey;
  const targetId = target && typeof target.id === 'string' ? target.id.trim() : '';
  const encPayload = bytesFrom(sem.encPayload);
  const encIv = bytesFrom(sem.encIv);
  if (!targetId || !encPayload || !encIv) return null;
  if (encPayload.length <= 16 || encIv.length === 0) return null;
  return { targetMessageKey: target, encPayload, encIv, secretEncType: type, targetId };
}

function atomicWrite(filePath, textContent) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, textContent, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(tempPath, 0o600); } catch { /* Windows may ignore POSIX bits. */ }
    fs.renameSync(tempPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* best effort on Windows. */ }
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch { /* best effort cleanup */ }
    throw err;
  }
}

/**
 * Capture one real MESSAGE_EDIT using the original message already persisted
 * in quotedStore. Returns a small status object and never logs sensitive data.
 */
function captureMessageEditFixture({ record, messageObj, quotedStore, instance = null, env = process.env }) {
  if (!isEnabled(env)) return { captured: false, reason: 'disabled' };
  if (!record || !quotedStore || typeof quotedStore.get !== 'function') {
    return { captured: false, reason: 'capture_input_missing' };
  }

  const edit = editEnvelope(messageObj);
  if (!edit) return { captured: false, reason: 'not_message_edit' };

  const target = targetFilter(env);
  if (target && target !== edit.targetId) return { captured: false, reason: 'target_mismatch' };

  const outputPath = fixturePath(env);
  if (fs.existsSync(outputPath) && !allowOverwrite(env)) {
    return { captured: false, reason: 'fixture_exists' };
  }

  const original = quotedStore.get(edit.targetId);
  if (!original || !original.key || !original.message) {
    return { captured: false, reason: 'original_not_in_quoted_store' };
  }

  const messageSecret = extractMessageSecret(original.message);
  if (!messageSecret) return { captured: false, reason: 'original_message_secret_missing' };

  const fixture = {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    instance: instance || null,
    original: {
      key: original.key,
      message_secret_base64: messageSecret.toString('base64'),
    },
    edit: {
      key: record.key || null,
      secret_enc_type: edit.secretEncType,
      target_message_key: edit.targetMessageKey,
      enc_iv_base64: edit.encIv.toString('base64'),
      enc_payload_base64: edit.encPayload.toString('base64'),
    },
  };

  atomicWrite(outputPath, JSON.stringify(fixture, null, 2) + '\n');
  return { captured: true, path: outputPath, targetId: edit.targetId };
}

module.exports = {
  isEnabled,
  fixturePath,
  targetFilter,
  extractMessageSecret,
  editEnvelope,
  captureMessageEditFixture,
};
