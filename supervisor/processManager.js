'use strict';

const { spawn } = require('child_process');
const process_ = require('process');
const config = require('./config');
const logger = require('./logger');

// State machine tetap (lihat task spec):
const STATES = Object.freeze({
  STOPPED: 'STOPPED',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  CRASHED: 'CRASHED',
  UNKNOWN: 'UNKNOWN',
});

let state = STATES.STOPPED;
let child = null;
let pid = null;
let startedAt = null; // ISO string, kapan proses Gateway (yang sekarang hidup) mulai
let intentionalStop = false; // membedakan STOPPED (disengaja) vs CRASHED

// Antrian sederhana supaya start/stop/restart yang datang hampir bersamaan
// diproses satu-satu, bukan konkuren -- ini yang mencegah dua Gateway
// process ke-spawn dari race condition dua request start hampir bersamaan.
let opQueue = Promise.resolve();
function enqueue(fn) {
  const result = opQueue.then(fn, fn);
  // Jangan biarkan satu operasi gagal menghentikan operasi berikutnya di antrian.
  opQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

function uptimeMs() {
  if (!startedAt || state !== STATES.RUNNING) return 0;
  return Date.now() - new Date(startedAt).getTime();
}

function getSnapshot() {
  return {
    state,
    running: state === STATES.RUNNING,
    pid: pid || null,
    startedAt: startedAt || null,
    uptimeMs: uptimeMs(),
  };
}

function spawnGateway() {
  return new Promise((resolve, reject) => {
    logger.info('Menjalankan Gateway...');
    state = STATES.STARTING;
    intentionalStop = false;

    const c = spawn(process_.execPath, [config.gateway.entry], {
      cwd: config.gateway.cwd,
      env: process_.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    let settled = false;

    c.once('spawn', () => {
      child = c;
      pid = c.pid;
      startedAt = new Date().toISOString();
      state = STATES.RUNNING;
      logger.info(`Gateway started (pid ${pid})`);
      settled = true;
      resolve();
    });

    c.once('error', (err) => {
      logger.error(`Gagal menjalankan Gateway: ${err.message}`);
      child = null;
      pid = null;
      startedAt = null;
      state = STATES.CRASHED;
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    c.once('exit', (code, signal) => {
      const wasIntentional = intentionalStop;
      logger.info(`Gateway exited (code=${code}, signal=${signal})`);
      child = null;
      pid = null;
      startedAt = null;

      if (wasIntentional) {
        state = STATES.STOPPED;
      } else {
        logger.error(`Gateway crashed (code=${code}, signal=${signal})`);
        state = STATES.CRASHED;
      }
    });
  });
}

async function start() {
  return enqueue(async () => {
    if (state === STATES.RUNNING || state === STATES.STARTING) {
      logger.info('Start diabaikan: Gateway sudah berjalan/sedang starting.');
      return { ok: true, alreadyRunning: true, snapshot: getSnapshot() };
    }
    try {
      await spawnGateway();
      return { ok: true, alreadyRunning: false, snapshot: getSnapshot() };
    } catch (err) {
      return { ok: false, error: err.message, snapshot: getSnapshot() };
    }
  });
}

function waitForExit(target, timeoutMs) {
  return new Promise((resolve) => {
    if (!target || target.exitCode !== null || target.signalCode !== null) {
      return resolve(true);
    }
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeoutMs);
    target.once('exit', () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

async function stop() {
  return enqueue(async () => {
    if (state === STATES.STOPPED && !child) {
      logger.info('Stop diabaikan: Gateway memang sudah berhenti.');
      return { ok: true, alreadyStopped: true, snapshot: getSnapshot() };
    }
    if (!child) {
      // state CRASHED/UNKNOWN tapi tidak ada child -- anggap sudah berhenti.
      state = STATES.STOPPED;
      return { ok: true, alreadyStopped: true, snapshot: getSnapshot() };
    }

    logger.info('Menghentikan Gateway (graceful)...');
    state = STATES.STOPPING;
    intentionalStop = true;

    const target = child;

    // 1) Coba graceful shutdown lewat IPC (Gateway sudah menangani SIGINT/SIGTERM
    //    dengan graceful shutdown-nya sendiri -- lihat src/app/index.js; kirim
    //    juga pesan IPC 'shutdown' sebagai jalur yang konsisten di Windows,
    //    di mana SIGTERM tidak benar-benar graceful).
    try {
      if (target.connected) target.send('shutdown');
    } catch (_err) {
      // abaikan, lanjut ke fallback signal
    }
    try {
      target.kill('SIGTERM');
    } catch (_err) {
      // abaikan
    }

    let exited = await waitForExit(target, config.gracefulStopTimeoutMs);

    // 2) Fallback: force kill kalau graceful gagal dalam batas waktu.
    if (!exited) {
      logger.warn('Gateway tidak berhenti dalam batas waktu graceful, force kill.');
      try {
        target.kill('SIGKILL');
      } catch (_err) {
        // abaikan
      }
      exited = await waitForExit(target, 5000);
    }

    if (!exited) {
      logger.error('Gateway gagal dihentikan (proses masih hidup setelah force kill).');
      return { ok: false, error: 'Gateway tidak merespons stop.', snapshot: getSnapshot() };
    }

    return { ok: true, snapshot: getSnapshot() };
  });
}

async function restart() {
  logger.info('Restart diminta.');
  const stopResult = await stop();
  if (!stopResult.ok) {
    return stopResult;
  }
  return start();
}

module.exports = {
  STATES,
  start,
  stop,
  restart,
  getSnapshot,
};
