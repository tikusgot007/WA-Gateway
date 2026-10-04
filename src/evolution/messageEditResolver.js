'use strict';

const {
  editEnvelope,
  extractMessageSecret,
} = require('./messageEditFixture');
const {
  decryptAndDecodeEditedText,
  messageEditSenderCandidates,
} = require('./messageEditCrypto');

function enabled(value) {
  return value === '1' || value === 'true' || value === 'TRUE';
}

function isDecryptEnabled(env = process.env) {
  return enabled(String(env.EVOLUTION_DECRYPT_MESSAGE_EDIT || ''));
}

function candidateStoredSenders(key) {
  if (!key || typeof key !== 'object') return [];
  return [
    key.participant,
    key.remoteJid,
    key.participantAlt,
    key.remoteJidAlt,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');
}

/**
 * Best-effort resolver for one MESSAGE_EDIT.
 *
 * This is deliberately side-effect free: it returns the validated replacement
 * text but never logs or persists secret/key/plaintext on its own. Callers can
 * decide whether to attach the text to an already-existing lifecycle event.
 */
function resolveMessageEditText({
  record,
  messageObj,
  quotedStore,
}) {
  const edit = editEnvelope(messageObj);
  if (!edit || !record || !quotedStore || typeof quotedStore.get !== 'function') {
    return null;
  }

  const original = quotedStore.get(edit.targetId);
  if (!original || !original.key || !original.message) return null;

  const messageSecret = extractMessageSecret(original.message);
  if (!messageSecret) return null;

  const senderCandidates = messageEditSenderCandidates({
    editKey: record.key || {},
    targetKey: edit.targetMessageKey || original.key,
    storedSenders: candidateStoredSenders(original.key),
  });

  if (senderCandidates.length === 0) return null;

  return decryptAndDecodeEditedText({
    encPayload: edit.encPayload,
    encIv: edit.encIv,
    origMsgId: edit.targetId,
    messageSecret,
    senderCandidates,
  });
}

module.exports = {
  isDecryptEnabled,
  resolveMessageEditText,
};
