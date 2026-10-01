'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logging');

/**
 * Penyimpanan media MASUK lokal (§6.2 opsi A) + sumber untuk
 * `POST /media/download`.
 *
 * CI4 menyimpan `media.direct_path` + `media.media_key_base64` lalu mengunduh
 * media ON-DEMAND saat kasir membuka pesan. Evolution API TIDAK memberi
 * referensi Baileys (directPath + mediaKey) dan retensi media Evolusi belum
 * terverifikasi -- karena itu adapter menyimpan blob di disk lokal dan
 * menyerahkan `direct_path` berupa ref opaque `evolution-media:<id>`
 * (`media_key_base64` = placeholder). `/media/download` mengabaikan key dan
 * menyajikan blob dari disk.
 *
 * Ref sengaja TIDAK berupa URL http sehingga CI4 memperlakukannya sebagai
 * referensi opaque (bukan URL) dan tetap mengirimkannya kembali apa adanya.
 *
 * Retensi (config.mediaRetentionDays) membatasi pertumbuhan disk. Media yang
 * sudah lewat retensi dan belum pernah diunduh akan hilang -- batasan ini
 * WAJIB dicatat di README; untuk operasional jangka panjang nilainya dinaikkan.
 */

const REF_PREFIX = 'evolution-media:';

function isMediaRef(ref) {
  return typeof ref === 'string' && ref.startsWith(REF_PREFIX);
}

function makeId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

class MediaStore {
  constructor(baseDir = config.mediaStoreDir) {
    this.baseDir = baseDir;
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  _paths(id) {
    return { data: path.join(this.baseDir, id), meta: path.join(this.baseDir, `${id}.json`) };
  }

  /**
   * @param {Buffer} buffer
   * @param {{mimetype?: string|null, fileName?: string|null, mediaType?: string|null}} meta
   * @returns {string} ref opaque
   */
  save(buffer, meta = {}) {
    const id = makeId();
    const { data, meta: metaPath } = this._paths(id);
    fs.writeFileSync(data, buffer);
    fs.writeFileSync(metaPath, JSON.stringify({
      mimetype: meta.mimetype || null,
      fileName: meta.fileName || null,
      mediaType: meta.mediaType || null,
      size: buffer.length,
      createdAt: new Date().toISOString(),
    }));
    return `${REF_PREFIX}${id}`;
  }

  /** @returns {{buffer: Buffer, mimetype: string|null, fileName: string|null, mediaType: string|null}|null} */
  read(ref) {
    if (!isMediaRef(ref)) return null;
    const id = ref.slice(REF_PREFIX.length);
    if (!/^[a-z0-9-]+$/i.test(id)) return null;
    const { data, meta: metaPath } = this._paths(id);
    if (!fs.existsSync(data)) return null;
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch (err) {
      // meta hilang/korup -- tetap sajikan blob dengan mimetype default.
    }
    return {
      buffer: fs.readFileSync(data),
      mimetype: meta.mimetype || null,
      fileName: meta.fileName || null,
      mediaType: meta.mediaType || null,
    };
  }

  /** Hapus media yang lebih tua dari retensi. @returns {number} jumlah dihapus. */
  prune(olderThanMs = config.mediaRetentionDays * 24 * 3600 * 1000) {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(this.baseDir);
    } catch (err) {
      return 0;
    }
    for (const name of entries) {
      const full = path.join(this.baseDir, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed += 1;
        }
      } catch (err) {
        // abaikan; prune best-effort
      }
    }
    if (removed > 0) logger.info('[MEDIA-STORE] media lama dipangkas', { removed });
    return removed;
  }
}

module.exports = new MediaStore();
module.exports.MediaStore = MediaStore;
module.exports.isMediaRef = isMediaRef;
module.exports.REF_PREFIX = REF_PREFIX;
