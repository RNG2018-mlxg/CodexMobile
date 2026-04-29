import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_DIR = process.env.CODEXMOBILE_HOME || path.join(process.cwd(), '.codexmobile', 'state');
const STATE_FILE = path.join(DATA_DIR, 'auth-state.json');
const FIXED_PAIRING_CODE_FILE = path.join(DATA_DIR, 'pairing-code.txt');
const PAIRING_CODE_PATTERN = /^\d{6}$/;

let authState = null;
let fixedPairingCode = false;
let pairingCode = createPairingCode();

function createPairingCode() {
  return String(crypto.randomInt(100000, 999999));
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function readState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      devices: Array.isArray(parsed.devices) ? parsed.devices : []
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[auth] Failed to read auth state, starting fresh:', error.message);
    }
    return { devices: [] };
  }
}

async function writeState() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(authState, null, 2), 'utf8');
}

async function readFixedPairingCode() {
  const envCode = String(process.env.CODEXMOBILE_PAIRING_CODE || '').trim();
  if (envCode) {
    if (PAIRING_CODE_PATTERN.test(envCode)) {
      return envCode;
    }
    console.warn('[auth] Ignoring CODEXMOBILE_PAIRING_CODE because it is not a 6 digit code.');
  }

  try {
    const fileCode = (await fs.readFile(FIXED_PAIRING_CODE_FILE, 'utf8')).trim();
    if (PAIRING_CODE_PATTERN.test(fileCode)) {
      return fileCode;
    }
    console.warn(`[auth] Ignoring ${FIXED_PAIRING_CODE_FILE} because it is not a 6 digit code.`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[auth] Failed to read fixed pairing code:', error.message);
    }
  }

  return null;
}

export async function initializeAuth() {
  authState = await readState();
  const configuredPairingCode = await readFixedPairingCode();
  if (configuredPairingCode) {
    pairingCode = configuredPairingCode;
    fixedPairingCode = true;
  }
  await writeState();
  return { pairingCode, fixedPairingCode, trustedDevices: authState.devices.length };
}

export function getPairingCode() {
  return pairingCode;
}

export function getTrustedDeviceCount() {
  return authState?.devices?.length || 0;
}

export function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  if (header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }

  const fallback = req.headers['x-codexmobile-token'];
  return typeof fallback === 'string' ? fallback.trim() : '';
}

export async function verifyToken(token, metadata = {}) {
  if (!token || !authState) {
    return false;
  }

  const tokenHash = hashToken(token);
  const device = authState.devices.find((entry) => entry.tokenHash === tokenHash);
  if (!device) {
    return false;
  }

  device.lastSeenAt = new Date().toISOString();
  device.lastRemoteAddress = metadata.remoteAddress || device.lastRemoteAddress || null;
  await writeState();
  return true;
}

export async function pairDevice({ code, deviceName, userAgent, remoteAddress }) {
  if (!code || String(code).trim() !== pairingCode) {
    return null;
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  const device = {
    id: crypto.randomUUID(),
    name: deviceName || 'iPhone',
    tokenHash: hashToken(token),
    createdAt: now,
    lastSeenAt: now,
    userAgent: userAgent || null,
    lastRemoteAddress: remoteAddress || null
  };

  authState.devices.push(device);
  if (!fixedPairingCode) {
    pairingCode = createPairingCode();
  }
  await writeState();

  return {
    token,
    device: {
      id: device.id,
      name: device.name,
      createdAt: device.createdAt
    }
  };
}
