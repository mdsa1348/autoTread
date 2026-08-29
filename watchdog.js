/**
 * Keeps server.js running. Ctrl+C / SIGTERM stops it for real.
 */
const { spawn } = require('child_process');
const path = require('path');

let child = null;
let stopping = false;
let crashDelay = 2000;

function start() {
  if (stopping) return;
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env
  });
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) {
      process.exit(code || 0);
      return;
    }
    console.error(`[WATCHDOG] server exited (code=${code} signal=${signal || 'none'}). Restarting in ${Math.round(crashDelay / 1000)}s...`);
    setTimeout(start, crashDelay);
    crashDelay = Math.min(30000, Math.round(crashDelay * 1.5));
  });
  child.on('spawn', () => { crashDelay = 2000; });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  if (child) {
    try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
    setTimeout(() => {
      if (child) {
        try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
      }
      process.exit(0);
    }, 4000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start();
