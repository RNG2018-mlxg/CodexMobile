import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const serviceDir = path.join(root, 'asr-service');
const cacheDir = path.join(root, '.codexmobile', 'model-cache');
const containerName = process.env.CODEXMOBILE_ASR_CONTAINER || 'codexmobile-sensevoice-asr';
const legacyContainerName = process.env.CODEXMOBILE_ASR_LEGACY_CONTAINER || 'codexmobile-asr';
const image = process.env.CODEXMOBILE_ASR_IMAGE || 'codexmobile-sensevoice-asr:latest';
const port = process.env.CODEXMOBILE_ASR_PORT || '8000';
const model = process.env.CODEXMOBILE_TRANSCRIBE_MODEL || 'iic/SenseVoiceSmall';
const device = process.env.CODEXMOBILE_ASR_DEVICE || 'cpu';
const healthTimeoutMs = Number(process.env.CODEXMOBILE_ASR_HEALTH_TIMEOUT_MS || 60000);
const buildTimeoutMs = Number(process.env.CODEXMOBILE_ASR_BUILD_TIMEOUT_MS || 20 * 60 * 1000);
const rebuild = ['1', 'true', 'yes', 'on'].includes(String(process.env.CODEXMOBILE_ASR_REBUILD || '').toLowerCase());
const recreate = ['1', 'true', 'yes', 'on'].includes(String(process.env.CODEXMOBILE_ASR_RECREATE || '').toLowerCase());

fs.mkdirSync(cacheDir, { recursive: true });

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });
}

function printFailure(result) {
  if (result?.error?.code === 'ETIMEDOUT') {
    console.error(`Command timed out after ${result.error.timeout || 'the configured'} ms.`);
  }
  const output = `${result?.stdout || ''}${result?.stderr || ''}`.trim();
  if (output) {
    console.error(output);
  }
}

function docker(args, options = {}) {
  return run('docker', args, options);
}

function requireDocker() {
  const info = docker(['info']);
  if (info.status !== 0) {
    console.error('Docker is not running. Start Docker Desktop, then run npm run asr:start again.');
    printFailure(info);
    process.exit(1);
  }
}

function imageExists() {
  const result = docker(['image', 'inspect', image]);
  return result.status === 0;
}

function containerExists(name) {
  const result = docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']);
  return result.status === 0 && result.stdout.trim() === name;
}

function containerRunning(name) {
  const result = docker(['ps', '--filter', `name=^/${name}$`, '--filter', 'status=running', '--format', '{{.Names}}']);
  return result.status === 0 && result.stdout.trim() === name;
}

function stopContainer(name) {
  if (!containerRunning(name)) {
    return;
  }
  const result = docker(['stop', name]);
  if (result.status !== 0) {
    printFailure(result);
    process.exit(result.status || 1);
  }
}

function removeContainer(name) {
  if (!containerExists(name)) {
    return;
  }
  stopContainer(name);
  const result = docker(['rm', name]);
  if (result.status !== 0) {
    printFailure(result);
    process.exit(result.status || 1);
  }
}

function buildImageIfNeeded() {
  if (imageExists() && !rebuild) {
    return;
  }
  console.log(`Building SenseVoice ASR image: ${image}`);
  const result = docker(['build', '--tag', image, serviceDir], {
    stdio: 'inherit',
    timeout: buildTimeoutMs
  });
  if (result.status !== 0) {
    console.error('Failed to build SenseVoice ASR image.');
    printFailure(result);
    process.exit(result.status || 1);
  }
}

function startContainer() {
  if (legacyContainerName !== containerName && containerRunning(legacyContainerName)) {
    console.log(`Stopping legacy ASR container: ${legacyContainerName}`);
    stopContainer(legacyContainerName);
  }

  if (recreate) {
    removeContainer(containerName);
  }

  if (containerExists(containerName)) {
    const started = docker(['start', containerName]);
    if (started.status !== 0) {
      printFailure(started);
      process.exit(started.status || 1);
    }
    return;
  }

  const dockerArgs = [
    'run',
    '--detach',
    '--name',
    containerName,
    '--restart',
    'unless-stopped',
    '--publish',
    `${port}:8000`,
    '--volume',
    `${cacheDir.replace(/\\/g, '/')}:/models`,
    '--env',
    `SENSEVOICE_MODEL=${model}`,
    '--env',
    `SENSEVOICE_DEVICE=${device}`,
    '--env',
    'SENSEVOICE_PRELOAD=1',
    '--env',
    'SENSEVOICE_MAX_AUDIO_MB=10',
    image
  ];

  const created = docker(dockerArgs);
  if (created.status !== 0) {
    printFailure(created);
    process.exit(created.status || 1);
  }
}

async function readHealth() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { ok: response.ok, ready: false, raw: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHealth() {
  const startedAt = Date.now();
  let lastHealth = null;
  while (Date.now() - startedAt < healthTimeoutMs) {
    try {
      const health = await readHealth();
      lastHealth = health;
      if (health?.ready) {
        return { ready: true, health };
      }
    } catch {
      // The container may still be booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return { ready: false, health: lastHealth };
}

requireDocker();
buildImageIfNeeded();
startContainer();

console.log(`SenseVoice ASR container started: ${containerName}`);
console.log(`Endpoint: http://127.0.0.1:${port}/v1/audio/transcriptions`);
console.log(`Model: ${model}`);
console.log(`Cache: ${cacheDir}`);

const health = await waitForHealth();
if (health.ready) {
  console.log('SenseVoice ASR is ready.');
} else {
  console.log('SenseVoice ASR is starting or downloading the model. This can take several minutes the first time.');
  console.log(`Check later: curl http://127.0.0.1:${port}/health`);
  console.log(`Logs: docker logs -f ${containerName}`);
}
