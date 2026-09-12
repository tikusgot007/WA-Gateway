'use strict';

// Entry point yang dijalankan oleh "AuliaPos Gateway.exe" (lihat
// scripts/build-exe.ps1) -- exe kecil itu hanya men-spawn:
//   node.exe supervisor/launcher.js
// dari folder distribusi (yang berisi node.exe portable + seluruh project
// termasuk node_modules). File ini sendiri cuma alias tipis ke
// supervisor/server.js supaya ada satu nama file tetap yang bisa dirujuk
// baik oleh launcher exe maupun dokumentasi, tanpa mengubah perilaku
// server.js itu sendiri.
require('./server.js');
