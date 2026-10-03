'use strict';
/**
 * backup-sqlite.js -- backup ONLINE satu berkas SQLite memakai SQLite Backup
 * API (`better-sqlite3` -> `db.backup()`), aman dijalankan saat adapter hidup
 * (tidak copy mentah yang bisa setengah-tertulis / melewatkan WAL).
 *
 * Dipakai oleh scripts/backup-stack.ps1 (TODO-O1).
 *
 * Jalankan: node scripts/backup-sqlite.js <src.sqlite> <dest.sqlite>
 */
const Database = require('better-sqlite3');

async function main() {
  const src = process.argv[2];
  const dest = process.argv[3];

  if (!src || !dest) {
    console.error('usage: node scripts/backup-sqlite.js <src.sqlite> <dest.sqlite>');
    process.exit(2);
  }

  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await db.backup(dest);
  } finally {
    db.close();
  }

  console.log('sqlite backup ok -> ' + dest);
}

main().catch((err) => {
  console.error('sqlite backup gagal: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
