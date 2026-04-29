import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const logDir = path.join(root, '.codexmobile');
fs.mkdirSync(logDir, { recursive: true });

const out = fs.openSync(path.join(logDir, 'server.out.log'), 'a');
const err = fs.openSync(path.join(logDir, 'server.err.log'), 'a');

const child = spawn(process.execPath, ['server/index.js'], {
  cwd: root,
  detached: true,
  stdio: ['ignore', out, err],
  windowsHide: true
});

child.unref();
console.log(`CodexMobile server started in background, pid=${child.pid}`);
console.log(`Logs: ${path.join(logDir, 'server.out.log')}`);
