'use strict';

// Install/uninstall Supervisor sebagai Windows Service, memakai "node-windows".
//
// DEPENDENCY BARU (belum terinstall secara default):
//   npm install node-windows --save
//
// Kenapa node-windows: library kecil, banyak dipakai untuk kasus persis ini
// (menjalankan skrip Node sebagai Windows Service), tidak menyentuh apapun
// di Gateway -- ia hanya mendaftarkan supervisor/server.js sebagai service
// yang start otomatis saat Windows boot.
//
// PENTING -- TIDAK dijalankan otomatis oleh siapapun/apapun. Jalankan
// manual, eksplisit, dari Command Prompt/PowerShell dengan hak Administrator:
//
//   npm run supervisor:install-service     (mendaftarkan service)
//   npm run supervisor:uninstall-service   (menghapus service)
//
// Service yang didaftarkan HANYA menjalankan Supervisor (supervisor/server.js).
// Supervisor sendiri yang nanti men-spawn Gateway (src/app/index.js) sesuai
// perintah Start/Restart dari Control Panel -- Gateway TIDAK didaftarkan
// sebagai service terpisah.

const path = require('path');

const action = process.argv[2];

if (action !== 'install' && action !== 'uninstall') {
  // eslint-disable-next-line no-console
  console.error('Gunakan: npm run supervisor:install-service  ATAU  npm run supervisor:uninstall-service');
  process.exit(1);
}

let nodeWindows;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  nodeWindows = require('node-windows');
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    'Package "node-windows" belum terinstall. Jalankan dulu:\n' +
      '  npm install node-windows --save\n' +
      'lalu ulangi perintah ini.'
  );
  process.exit(1);
}

const { Service } = nodeWindows;

const svc = new Service({
  name: 'AuliaPos Gateway Supervisor',
  description: 'Supervisor/Control Panel untuk WA-Gateway (AuliaPos). Tidak menjalankan business logic chat.',
  script: path.join(__dirname, 'server.js'),
  // Warisi environment saat ini (termasuk .env repo root, dibaca lewat dotenv
  // di dalam supervisor/config.js & src/config saat service start).
  workingDirectory: path.resolve(__dirname, '..'),
});

svc.on('install', () => {
  // eslint-disable-next-line no-console
  console.log('Service terinstall. Menjalankan service...');
  svc.start();
});
svc.on('alreadyinstalled', () => {
  // eslint-disable-next-line no-console
  console.log('Service sudah terinstall sebelumnya.');
});
svc.on('start', () => {
  // eslint-disable-next-line no-console
  console.log('Service berjalan.');
});
svc.on('uninstall', () => {
  // eslint-disable-next-line no-console
  console.log('Service berhasil dihapus.');
});
svc.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Error node-windows:', err);
});

if (action === 'install') {
  svc.install();
} else {
  svc.uninstall();
}
