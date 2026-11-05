// Development: API server (with SMS codes printed to the console) + Vite with hot reload.
import { spawn } from 'node:child_process';

const env = { ...process.env, DEV_ORIGINS: 'http://localhost:5173', SMS_PROVIDER: process.env.SMS_PROVIDER || 'console' };
const procs = [
  spawn(process.execPath, ['--watch-path=server', 'server/index.js'], { stdio: 'inherit', env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env }),
];
const stop = () => procs.forEach((p) => p.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', (code) => { if (code) stop(); }));
console.log('\n  Open http://localhost:5173 — verification codes appear in this terminal.\n');
