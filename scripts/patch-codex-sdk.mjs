import fs from 'node:fs';
import path from 'node:path';

const sdkPath = path.resolve('node_modules', '@openai', 'codex-sdk', 'dist', 'index.js');

if (!fs.existsSync(sdkPath)) {
  console.warn(`[patch-codex-sdk] skipped, not found: ${sdkPath}`);
  process.exit(0);
}

const source = fs.readFileSync(sdkPath, 'utf8');
if (source.includes('windowsHide: true')) {
  console.log('[patch-codex-sdk] already patched');
  process.exit(0);
}

const target = `const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal
    });`;
const replacement = `const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
      windowsHide: true
    });`;

if (!source.includes(target)) {
  console.warn('[patch-codex-sdk] target snippet not found; SDK may have changed');
  process.exit(0);
}

fs.writeFileSync(sdkPath, source.replace(target, replacement), 'utf8');
console.log('[patch-codex-sdk] patched Codex SDK spawn options');
