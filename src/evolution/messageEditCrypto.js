'use strict';

const crypto = require('crypto');

const GCM_TAG_LENGTH = 16;
const MESSAGE_EDIT_USE_CASE = 'Message Edit';
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });

function toBuffer(value, name = 'bytes') {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError(`${name} must be a Buffer or Uint8Array`);
}

function normalizeJid(jid) {
  if (typeof jid !== 'string' || !jid.includes('@')) return null;
  const at = jid.indexOf('@');
  let user = jid.slice(0, at);
  const server = jid.slice(at + 1).toLowerCase();
  if (!user || !server) return null;
  const deviceSep = user.indexOf(':');
  if (deviceSep > 0) user = user.slice(0, deviceSep);
  return user ? `${user}@${server}` : null;
}

function unique(values) {
  const out = [];
  for (const value of values || []) {
    const normalized = normalizeJid(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function messageAuthorJids(key, ownJids = {}) {
  if (!key || typeof key !== 'object') return [];
  if (key.fromMe) {
    return unique([ownJids.lid, ownJids.id]);
  }
  return unique([
    key.participant,
    key.remoteJid,
    key.participantAlt,
    key.remoteJidAlt,
  ]);
}

function messageEditSenderCandidates({
  editKey,
  targetKey,
  ownJids = {},
  storedSenders = [],
}) {
  const editSenders = messageAuthorJids(editKey, ownJids);
  const originalSenders = unique([
    ...(targetKey && targetKey.fromMe ? editSenders : [
      targetKey?.participant,
      targetKey?.remoteJid,
      targetKey?.participantAlt,
      targetKey?.remoteJidAlt,
    ]),
    ...storedSenders,
  ]);

  const candidates = [];
  for (const origMsgSender of originalSenders) {
    for (const editSender of editSenders) {
      candidates.push({ origMsgSender, editSender });
    }
  }
  return candidates;
}

function messageEditKey({
  origMsgId,
  origMsgSender,
  editSender,
  messageSecret,
}) {
  if (typeof origMsgId !== 'string' || !origMsgId) {
    throw new TypeError('origMsgId must be a non-empty string');
  }
  const secret = toBuffer(messageSecret, 'messageSecret');
  if (secret.length !== 32) {
    throw new RangeError('messageSecret must be 32 bytes');
  }
  const a = normalizeJid(origMsgSender);
  const b = normalizeJid(editSender);
  if (!a || !b) throw new TypeError('sender JIDs must be valid');
  const info = Buffer.concat([
    Buffer.from(origMsgId, 'utf8'),
    Buffer.from(a, 'utf8'),
    Buffer.from(b, 'utf8'),
    Buffer.from(MESSAGE_EDIT_USE_CASE, 'utf8'),
  ]);
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    secret,
    Buffer.alloc(0),
    info,
    32,
  ));
}

function decryptMessageEdit({
  encPayload,
  encIv,
  origMsgId,
  messageSecret,
  senderCandidates,
}) {
  const payload = toBuffer(encPayload, 'encPayload');
  const iv = toBuffer(encIv, 'encIv');
  if (payload.length <= GCM_TAG_LENGTH || iv.length === 0) return null;

  const ciphertext = payload.subarray(0, payload.length - GCM_TAG_LENGTH);
  const tag = payload.subarray(payload.length - GCM_TAG_LENGTH);

  for (const senders of senderCandidates || []) {
    try {
      const key = messageEditKey({
        ...senders,
        origMsgId,
        messageSecret,
      });
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.alloc(0));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return { plaintext, senders };
    } catch {
      // Wrong sender/JID form or corrupt payload: continue to next candidate.
    }
  }
  return null;
}

function readVarint(buffer, offset, end) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  for (let i = 0; i < 10; i += 1) {
    if (cursor >= end) throw new Error('truncated protobuf varint');
    const byte = buffer[cursor];
    cursor += 1;
    if (shift === 63 && byte > 1) throw new Error('protobuf varint overflow');
    value += (byte & 0x7f) * (2 ** shift);
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7;
  }
  throw new Error('protobuf varint too long');
}

function readFields(buffer, depth = 0) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('protobuf input must be Buffer');
  if (depth > 8) throw new Error('protobuf nesting too deep');

  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset, buffer.length);
    offset = tag.offset;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (fieldNumber < 1) throw new Error('invalid protobuf field number');

    if (wireType === 0) {
      const value = readVarint(buffer, offset, buffer.length);
      offset = value.offset;
      fields.push({ fieldNumber, wireType, value: value.value });
      continue;
    }

    if (wireType === 1) {
      if (offset + 8 > buffer.length) throw new Error('truncated fixed64');
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }

    if (wireType === 2) {
      const length = readVarint(buffer, offset, buffer.length);
      offset = length.offset;
      if (!Number.isSafeInteger(length.value) || length.value < 0) {
        throw new Error('invalid protobuf length');
      }
      const next = offset + length.value;
      if (next > buffer.length) throw new Error('truncated length-delimited field');
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, next) });
      offset = next;
      continue;
    }

    if (wireType === 5) {
      if (offset + 4 > buffer.length) throw new Error('truncated fixed32');
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }

    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
  return fields;
}

function decodeUtf8(buffer) {
  return TEXT_DECODER.decode(buffer);
}

function decodeEditedTextPayload(plaintext) {
  const bytes = toBuffer(plaintext, 'plaintext');

  // Current WAProto.Message wire layout relevant to text:
  //   field 1 = conversation (string)
  //   field 6 = extendedTextMessage (message; nested field 1 = text)
  //   field 12 = protocolMessage (message; nested field 4 = editedMessage)
  //   field 58 = editedMessage (FutureProofMessage; nested field 1 = message)
  //
  // We validate the complete protobuf wire stream first. For the wrapper forms,
  // only the exact text-bearing fields above are accepted.
  try {
    const fields = readFields(bytes);
    let lastText = null;
    let shape = null;

    for (const field of fields) {
      if (field.wireType !== 2) continue;

      if (field.fieldNumber === 1) {
        lastText = decodeUtf8(field.value);
        shape = 'conversation';
        continue;
      }

      if (field.fieldNumber === 6) {
        const nested = readFields(field.value);
        for (const child of nested) {
          if (child.fieldNumber === 1 && child.wireType === 2) {
            lastText = decodeUtf8(child.value);
            shape = 'extendedTextMessage';
          }
        }
        continue;
      }

      if (field.fieldNumber === 12) {
        const protocol = readFields(field.value);
        for (const child of protocol) {
          // ProtocolMessage.editedMessage is field 4.
          if (child.fieldNumber === 4 && child.wireType === 2) {
            const edited = readFields(child.value);
            for (const editedField of edited) {
              if (editedField.fieldNumber === 1 && editedField.wireType === 2) {
                lastText = decodeUtf8(editedField.value);
                shape = 'protocolMessage.editedMessage.conversation';
              }
              if (editedField.fieldNumber === 6 && editedField.wireType === 2) {
                const extended = readFields(editedField.value);
                for (const textField of extended) {
                  if (textField.fieldNumber === 1 && textField.wireType === 2) {
                    lastText = decodeUtf8(textField.value);
                    shape = 'protocolMessage.editedMessage.extendedTextMessage';
                  }
                }
              }
            }
          }
        }
        continue;
      }

      if (field.fieldNumber === 58) {
        const futureProof = readFields(field.value);
        for (const child of futureProof) {
          // FutureProofMessage.message = 1.
          if (child.fieldNumber !== 1 || child.wireType !== 2) continue;
          const inner = decodeEditedTextPayload(child.value);
          if (inner) {
            lastText = inner.text;
            shape = `editedMessage.${inner.shape}`;
          }
        }
      }
    }

    return lastText === null ? null : { text: lastText, shape };
  } catch {
    return null;
  }
}

function decryptAndDecodeEditedText(args) {
  const result = decryptMessageEdit(args);
  if (!result) return null;
  const decoded = decodeEditedTextPayload(result.plaintext);
  if (!decoded) return null;
  return { ...result, ...decoded };
}

module.exports = {
  GCM_TAG_LENGTH,
  normalizeJid,
  messageAuthorJids,
  messageEditSenderCandidates,
  messageEditKey,
  decryptMessageEdit,
  decodeEditedTextPayload,
  decryptAndDecodeEditedText,
};
