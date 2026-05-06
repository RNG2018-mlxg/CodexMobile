import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import {
  extractBearerToken,
  getPairingCode,
  getTrustedDeviceCount,
  initializeAuth,
  pairDevice,
  verifyToken
} from './auth.js';
import {
  deleteSession,
  getCacheSnapshot,
  getHostName,
  getProject,
  getSession,
  hideSessionMessage,
  listProjectSessions,
  listProjects,
  readSessionMessages,
  refreshCodexCache,
  renameSession
} from './codex-data.js';
import { getCodexQuota } from './codex-quota.js';
import { abortCodexTurn, getActiveRuns, runCodexTurn } from './codex-runner.js';
import { GENERATED_ROOT, isImageRequest, runImageTurn } from './image-generator.js';
import { getLarkDocsStatus, logoutLarkCli, startLarkCliAuth } from './lark-cli.js';
import { registerMobileSession } from './mobile-session-index.js';
import { publicVoiceTranscriptionStatus, transcribeAudio } from './voice-transcriber.js';
import { publicVoiceSpeechStatus, synthesizeSpeech } from './voice-speaker.js';
import { publicVoiceRealtimeStatus, startVoiceRealtimeProxy } from './realtime-voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const CLIENT_DIST = path.join(ROOT_DIR, 'client', 'dist');
const UPLOAD_ROOT = path.join(ROOT_DIR, '.codexmobile', 'uploads');
const IMAGE_PROMPT_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'image-prompts.json');
const FEISHU_AUTH_STATE = path.join(ROOT_DIR, '.codexmobile', 'state', 'feishu-auth.json');
const PORT = Number(process.env.PORT || 3321);
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const HTTPS_PFX_PATH = process.env.HTTPS_PFX_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'server.pfx');
const HTTPS_ROOT_CA_PATH = process.env.HTTPS_ROOT_CA_PATH || path.join(ROOT_DIR, '.codexmobile', 'tls', 'codexmobile-root-ca.cer');
const HTTPS_PFX_PASSPHRASE = process.env.HTTPS_PFX_PASSPHRASE || 'codexmobile-local-https';
const PUBLIC_URL = process.env.CODEXMOBILE_PUBLIC_URL || '';
const FEISHU_APP_ID = String(process.env.CODEXMOBILE_FEISHU_APP_ID || '').trim();
const FEISHU_APP_SECRET = String(process.env.CODEXMOBILE_FEISHU_APP_SECRET || '').trim();
const FEISHU_REDIRECT_URI = String(process.env.CODEXMOBILE_FEISHU_REDIRECT_URI || '').trim();
const FEISHU_DOCS_HOME_URL = process.env.CODEXMOBILE_FEISHU_DOCS_URL || 'https://docs.feishu.cn/';
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_VOICE_BYTES = 10 * 1024 * 1024;
const DEFAULT_REASONING_EFFORT = 'xhigh';
const FEISHU_AUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.cer', 'application/x-x509-ca-cert'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon']
]);

const compressibleExtensions = new Set([
  '.html',
  '.js',
  '.css',
  '.json',
  '.webmanifest',
  '.svg'
]);

const sockets = new Set();
const recentTurns = new Map();
const conversationQueues = new Map();
const sessionQueueKeys = new Map();
const recentImagePromptsByProject = new Map();
const activeImageRuns = new Map();
let feishuAuthState = { token: null, pendingStates: {} };
const MAX_RECENT_TURNS = 80;

function rememberTurn(turnId, patch) {
  if (!turnId) {
    return null;
  }
  const existing = recentTurns.get(turnId) || { turnId, createdAt: new Date().toISOString() };
  const next = {
    ...existing,
    ...patch,
    turnId,
    updatedAt: new Date().toISOString()
  };
  recentTurns.set(turnId, next);

  if (recentTurns.size > MAX_RECENT_TURNS) {
    const oldest = [...recentTurns.entries()].sort(
      (a, b) => new Date(a[1].updatedAt || a[1].createdAt || 0) - new Date(b[1].updatedAt || b[1].createdAt || 0)
    )[0]?.[0];
    if (oldest) {
      recentTurns.delete(oldest);
    }
  }
  return next;
}

function rememberTurnEvent(payload) {
  if (!payload?.turnId) {
    return;
  }

  const patch = {
    projectId: payload.projectId,
    sessionId: payload.sessionId || undefined,
    previousSessionId: payload.previousSessionId || undefined
  };

  if (payload.type === 'chat-started') {
    patch.status = 'running';
    patch.startedAt = payload.startedAt || new Date().toISOString();
    patch.label = '正在思考';
  } else if (payload.type === 'thread-started') {
    patch.status = 'running';
    patch.label = '正在思考';
  } else if (payload.type === 'status-update') {
    patch.status = payload.status || 'running';
    patch.kind = payload.kind || undefined;
    patch.label = payload.label || undefined;
    patch.detail = payload.detail || undefined;
  } else if (payload.type === 'assistant-update') {
    patch.status = 'running';
    patch.hadAssistantText = true;
    patch.assistantPreview = payload.content || '';
    patch.messageId = payload.messageId || undefined;
    patch.label = '正在回复';
  } else if (payload.type === 'chat-complete') {
    patch.status = 'completed';
    patch.completedAt = payload.completedAt || new Date().toISOString();
    patch.hadAssistantText = Boolean(payload.hadAssistantText);
    patch.usage = payload.usage || null;
    patch.label = '任务已完成';
  } else if (payload.type === 'chat-error') {
    patch.status = 'failed';
    patch.error = payload.error || '任务失败';
    patch.label = '任务失败';
  } else if (payload.type === 'chat-aborted') {
    patch.status = 'aborted';
    patch.label = '已中止';
  } else {
    return;
  }

  rememberTurn(payload.turnId, patch);
}

function fallbackModels(config) {
  const model = config.model || 'gpt-5.5';
  return [{ value: model, label: model }];
}

function getActiveImageRuns() {
  return [...activeImageRuns.values()].map((run) => ({
    sessionId: run.sessionId,
    previousSessionId: run.previousSessionId,
    startedAt: run.startedAt,
    status: run.status,
    turnId: run.turnId,
    kind: 'image_generation_call',
    label: run.label
  }));
}

function payloadReferencesSession(payload, sessionId) {
  return [
    payload?.sessionId,
    payload?.previousSessionId,
    payload?.draftSessionId,
    payload?.selectedSessionId
  ].some((value) => value && value === sessionId);
}

function sessionHasActiveWork(sessionId) {
  if (!sessionId) {
    return false;
  }
  const activeRuns = [...getActiveRuns(), ...getActiveImageRuns()];
  if (activeRuns.some((run) => payloadReferencesSession(run, sessionId))) {
    return true;
  }

  for (const turn of recentTurns.values()) {
    if (
      (turn.status === 'accepted' || turn.status === 'queued' || turn.status === 'running') &&
      payloadReferencesSession(turn, sessionId)
    ) {
      return true;
    }
  }

  for (const state of conversationQueues.values()) {
    if (state.running && state.sessionId === sessionId) {
      return true;
    }
    if (state.jobs.some((job) => payloadReferencesSession(job, sessionId))) {
      return true;
    }
  }

  return false;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(html);
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadFeishuAuthState() {
  try {
    const raw = await fs.readFile(FEISHU_AUTH_STATE, 'utf8');
    const parsed = JSON.parse(raw);
    feishuAuthState = {
      token: parsed?.token && typeof parsed.token === 'object' ? parsed.token : null,
      pendingStates: parsed?.pendingStates && typeof parsed.pendingStates === 'object' ? parsed.pendingStates : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[feishu] Failed to read auth state:', error.message);
    }
    feishuAuthState = { token: null, pendingStates: {} };
  }
}

async function saveFeishuAuthState() {
  await fs.mkdir(path.dirname(FEISHU_AUTH_STATE), { recursive: true });
  await fs.writeFile(FEISHU_AUTH_STATE, JSON.stringify(feishuAuthState, null, 2), 'utf8');
}

function cleanupFeishuPendingStates() {
  const now = Date.now();
  const nextStates = {};
  for (const [state, payload] of Object.entries(feishuAuthState.pendingStates || {})) {
    const createdAt = Number(payload?.createdAt || 0);
    if (createdAt && now - createdAt <= FEISHU_AUTH_STATE_MAX_AGE_MS) {
      nextStates[state] = payload;
    }
  }
  feishuAuthState.pendingStates = nextStates;
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${String(host).split(',')[0].trim()}`;
}

function feishuRedirectUri(req) {
  if (FEISHU_REDIRECT_URI) {
    return FEISHU_REDIRECT_URI;
  }
  const base = PUBLIC_URL || requestOrigin(req);
  return new URL('/api/feishu/auth/callback', base.endsWith('/') ? base : `${base}/`).toString();
}

function feishuConfigured() {
  return Boolean(FEISHU_APP_ID && FEISHU_APP_SECRET);
}

function feishuTokenValid() {
  const expiresAt = Number(feishuAuthState.token?.expiresAt || 0);
  return Boolean(feishuAuthState.token?.accessToken && expiresAt && expiresAt > Date.now() + 60_000);
}

function feishuUserSummary() {
  const user = feishuAuthState.token?.user || {};
  const name = user.name || user.enName || user.email || user.enterpriseEmail || user.openId || '';
  return name ? {
    name,
    email: user.email || user.enterpriseEmail || '',
    openId: user.openId || ''
  } : null;
}

async function publicDocsStatus(authenticated) {
  try {
    return await getLarkDocsStatus({ authenticated });
  } catch (error) {
    return {
      provider: 'feishu',
      integration: 'lark-cli',
      label: '飞书文档',
      configured: feishuConfigured(),
      connected: authenticated ? feishuTokenValid() : false,
      user: authenticated ? feishuUserSummary() : null,
      homeUrl: FEISHU_DOCS_HOME_URL,
      cliInstalled: false,
      skillsInstalled: false,
      capabilities: [],
      codexEnabled: false,
      error: error.message || 'lark-cli status failed'
    };
  }
}

async function feishuJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 1000) };
  }
  if (!response.ok || Number(data.code || 0) !== 0) {
    const error = new Error(data.msg || data.message || `Feishu API request failed: ${response.status}`);
    error.statusCode = response.status;
    error.response = data;
    throw error;
  }
  return data;
}

async function getFeishuAppAccessToken() {
  if (!feishuConfigured()) {
    const error = new Error('Feishu app credentials are not configured');
    error.statusCode = 400;
    throw error;
  }
  const data = await feishuJson('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    body: JSON.stringify({
      app_id: FEISHU_APP_ID,
      app_secret: FEISHU_APP_SECRET
    })
  });
  return data.app_access_token;
}

async function exchangeFeishuCode(code) {
  const appAccessToken = await getFeishuAppAccessToken();
  const data = await feishuJson('https://open.feishu.cn/open-apis/authen/v1/access_token', {
    method: 'POST',
    headers: { authorization: `Bearer ${appAccessToken}` },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code
    })
  });
  const token = data.data || data;
  const now = Date.now();
  feishuAuthState.token = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || '',
    expiresAt: now + Math.max(0, Number(token.expires_in || 0)) * 1000,
    refreshExpiresAt: token.refresh_expires_in ? now + Number(token.refresh_expires_in) * 1000 : 0,
    user: {
      name: token.name || '',
      enName: token.en_name || '',
      email: token.email || '',
      enterpriseEmail: token.enterprise_email || '',
      openId: token.open_id || '',
      unionId: token.union_id || '',
      userId: token.user_id || '',
      tenantKey: token.tenant_key || ''
    },
    updatedAt: new Date().toISOString()
  };
  await saveFeishuAuthState();
  return feishuAuthState.token;
}

async function handleFeishuCallback(req, res, url) {
  const code = String(url.searchParams.get('code') || '').trim();
  const state = String(url.searchParams.get('state') || '').trim();
  const error = String(url.searchParams.get('error') || '').trim();
  cleanupFeishuPendingStates();
  const pending = state ? feishuAuthState.pendingStates[state] : null;
  if (!pending) {
    sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权已过期，请回到 CodexMobile 重新连接。</p>');
    return;
  }
  delete feishuAuthState.pendingStates[state];
  await saveFeishuAuthState();
  if (error) {
    sendHtml(res, 400, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(error)}</p>`);
    return;
  }
  if (!code) {
    sendHtml(res, 400, '<!doctype html><meta charset="utf-8"><p>飞书授权失败：没有收到授权码。</p>');
    return;
  }
  try {
    await exchangeFeishuCode(code);
    const backUrl = new URL('/', pending.redirectUri).toString();
    res.writeHead(302, { location: `${backUrl}?feishu=connected` });
    res.end();
  } catch (callbackError) {
    console.warn(`[feishu] OAuth callback failed remote=${remoteAddress(req)} message=${callbackError.message}`);
    sendHtml(res, 502, `<!doctype html><meta charset="utf-8"><p>飞书授权失败：${htmlEscape(callbackError.message)}</p>`);
  }
}

function acceptsGzip(req) {
  return String(req.headers['accept-encoding'] || '')
    .split(',')
    .some((value) => value.trim().toLowerCase().startsWith('gzip'));
}

function staticCacheControl(ext, filePath = '') {
  if (ext === '.html') {
    return 'no-store';
  }
  const normalized = filePath.split(path.sep).join('/');
  if (normalized.includes('/assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

function sendStaticContent(req, res, status, content, headers, ext) {
  let body = content;
  const nextHeaders = { ...headers };
  if (content.length >= 1024 && compressibleExtensions.has(ext) && acceptsGzip(req)) {
    body = gzipSync(content);
    nextHeaders['content-encoding'] = 'gzip';
    nextHeaders.vary = nextHeaders.vary ? `${nextHeaders.vary}, Accept-Encoding` : 'Accept-Encoding';
  }
  nextHeaders['content-length'] = body.length;
  res.writeHead(status, nextHeaders);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        req.resume();
        reject(new Error('Upload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function parseHeaderValue(value, key) {
  const match = String(value || '').match(new RegExp(`${key}="([^"]*)"`));
  return match ? match[1] : '';
}

function sanitizeFileName(fileName) {
  const baseName = path.basename(String(fileName || 'upload.bin')).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_');
  return baseName || 'upload.bin';
}

function classifyUpload(mimeType) {
  return String(mimeType || '').startsWith('image/') ? 'image' : 'file';
}

function parseMultipartFile(buffer, contentType, fieldName = 'file') {
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
  if (!boundary) {
    throw new Error('Missing multipart boundary');
  }
  const acceptedNames = Array.isArray(fieldName) ? fieldName : [fieldName];

  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(boundaryBuffer);

  while (cursor >= 0) {
    cursor += boundaryBuffer.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) {
      break;
    }
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) {
      cursor += 2;
    }

    const nextBoundary = buffer.indexOf(boundaryBuffer, cursor);
    if (nextBoundary < 0) {
      break;
    }

    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0 || headerEnd > nextBoundary) {
      cursor = nextBoundary;
      continue;
    }

    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const disposition = headers.match(/^content-disposition:\s*(.+)$/im)?.[1] || '';
    const name = parseHeaderValue(disposition, 'name');
    const fileName = parseHeaderValue(disposition, 'filename');
    const mimeType = headers.match(/^content-type:\s*(.+)$/im)?.[1]?.trim() || 'application/octet-stream';

    if (acceptedNames.includes(name) && fileName) {
      let contentEnd = nextBoundary;
      if (buffer[contentEnd - 2] === 13 && buffer[contentEnd - 1] === 10) {
        contentEnd -= 2;
      }
      return {
        fileName: sanitizeFileName(fileName),
        mimeType,
        data: buffer.slice(headerEnd + 4, contentEnd)
      };
    }

    cursor = nextBoundary;
  }

  throw new Error('No file field found');
}

async function readVoiceUpload(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    const error = new Error('multipart/form-data is required');
    error.statusCode = 400;
    throw error;
  }

  let body;
  try {
    body = await readBuffer(req, MAX_VOICE_BYTES);
  } catch (error) {
    const next = new Error(error.message === 'Upload too large' ? '音频超过 10MB' : '读取音频失败');
    next.statusCode = error.message === 'Upload too large' ? 413 : 400;
    throw next;
  }

  let part;
  try {
    part = parseMultipartFile(body, contentType, 'audio');
  } catch {
    const error = new Error('没有收到音频');
    error.statusCode = 400;
    throw error;
  }

  if (!part.data?.length) {
    const error = new Error('没有收到音频');
    error.statusCode = 400;
    throw error;
  }
  if (!String(part.mimeType || '').toLowerCase().startsWith('audio/')) {
    const error = new Error('音频格式不支持');
    error.statusCode = 400;
    throw error;
  }

  return part;
}

async function saveUpload(req) {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new Error('multipart/form-data is required');
  }

  const body = await readBuffer(req, MAX_UPLOAD_BYTES);
  const part = parseMultipartFile(body, contentType);
  const id = crypto.randomUUID();
  const dateFolder = new Date().toISOString().slice(0, 10);
  const filePath = path.join(UPLOAD_ROOT, dateFolder, `${id}-${part.fileName}`);

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, part.data);

  return {
    id,
    name: part.fileName,
    size: part.data.length,
    mimeType: part.mimeType,
    path: filePath,
    kind: classifyUpload(part.mimeType)
  };
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item.path === 'string' && item.path.trim())
    .map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || path.basename(item.path)),
      size: Number(item.size) || 0,
      mimeType: String(item.mimeType || ''),
      path: String(item.path),
      kind: item.kind === 'image' ? 'image' : 'file'
    }));
}

function withAttachmentReferences(message, attachments) {
  if (!attachments.length) {
    return message;
  }

  const lines = attachments.map((attachment) => {
    const type = attachment.kind === 'image' ? '图片' : '文件';
    return `- ${type}: ${attachment.name} (${attachment.path})`;
  });
  return `${message}\n\n附件路径:\n${lines.join('\n')}`;
}

async function loadRecentImagePrompts() {
  try {
    const raw = await fs.readFile(IMAGE_PROMPT_STATE, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [projectId, entry] of Object.entries(parsed.projects || {})) {
      if (entry?.prompt) {
        recentImagePromptsByProject.set(projectId, entry.prompt);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[image] Failed to load prompt state:', error.message);
    }
  }
}

function persistRecentImagePrompt(projectId, prompt) {
  if (!projectId || !prompt) {
    return;
  }
  fs.mkdir(path.dirname(IMAGE_PROMPT_STATE), { recursive: true })
    .then(async () => {
      let state = { version: 1, projects: {} };
      try {
        state = JSON.parse(await fs.readFile(IMAGE_PROMPT_STATE, 'utf8'));
      } catch {
        // Start a fresh state file.
      }
      state.version = 1;
      state.projects = {
        ...(state.projects || {}),
        [projectId]: {
          prompt,
          updatedAt: new Date().toISOString()
        }
      };
      await fs.writeFile(IMAGE_PROMPT_STATE, JSON.stringify(state, null, 2), 'utf8');
    })
    .catch((error) => console.warn('[image] Failed to persist prompt state:', error.message));
}

function isContinuationMessage(message) {
  return /^(继续|中断了|又中断了|断了|重新来|重新生成|重新发送|再来|再试一次|retry|continue)$/i.test(String(message || '').trim());
}

function rememberImagePrompt(projectId, prompt) {
  if (projectId && prompt && isImageRequest(prompt, [])) {
    recentImagePromptsByProject.set(projectId, prompt);
    persistRecentImagePrompt(projectId, prompt);
  }
}

function resolveContinuationImagePrompt(projectId, message) {
  if (!isContinuationMessage(message)) {
    return '';
  }
  const remembered = recentImagePromptsByProject.get(projectId);
  if (remembered) {
    return remembered;
  }
  const sessions = listProjectSessions(projectId);
  const recentImageSession = sessions.find((session) =>
    isImageRequest(session.summary || session.title || '', [])
  );
  return recentImageSession?.summary || recentImageSession?.title || '';
}

function remoteAddress(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '';
}

async function isAuthenticated(req) {
  return verifyToken(extractBearerToken(req), { remoteAddress: remoteAddress(req) });
}

async function requireAuth(req, res, pathname = '') {
  if (await isAuthenticated(req)) {
    return true;
  }
  if ((req.method || 'GET') !== 'GET') {
    console.warn(`[auth] rejected ${req.method || 'GET'} ${pathname || req.url || ''} remote=${remoteAddress(req)}`);
  }
  sendJson(res, 401, { error: 'Pairing required' });
  return false;
}

function broadcast(payload) {
  const serialized = JSON.stringify(payload);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(serialized);
    }
  }
}

async function publicStatus(authenticated) {
  const snapshot = getCacheSnapshot();
  const config = snapshot.config || {};
  return {
    connected: true,
    hostName: getHostName(),
    port: PORT,
    provider: config.provider || 'codex',
    model: config.model || 'gpt-5.5',
    modelShort: config.modelShort || '5.5 中',
    models: config.models?.length ? config.models : fallbackModels(config),
    reasoningEffort: DEFAULT_REASONING_EFFORT,
    voiceTranscription: publicVoiceTranscriptionStatus(config),
    voiceSpeech: publicVoiceSpeechStatus(config),
    voiceRealtime: publicVoiceRealtimeStatus(config),
    docs: await publicDocsStatus(authenticated),
    syncedAt: snapshot.syncedAt,
    activeRuns: [...getActiveRuns(), ...getActiveImageRuns()],
    auth: {
      required: true,
      authenticated,
      trustedDevices: getTrustedDeviceCount()
    }
  };
}

function rememberConversationAlias(queueKey, sessionId) {
  if (queueKey && sessionId) {
    sessionQueueKeys.set(sessionId, queueKey);
  }
}

function resolveConversationKey(...ids) {
  for (const id of ids) {
    if (id && sessionQueueKeys.has(id)) {
      return sessionQueueKeys.get(id);
    }
  }
  const queueKey = ids.find(Boolean) || crypto.randomUUID();
  for (const id of ids) {
    rememberConversationAlias(queueKey, id);
  }
  return queueKey;
}

function getConversationQueue(queueKey) {
  if (!conversationQueues.has(queueKey)) {
    conversationQueues.set(queueKey, {
      sessionId: null,
      running: false,
      jobs: []
    });
  }
  return conversationQueues.get(queueKey);
}

function emitJobEvent(job, payload) {
  const enriched = { projectId: job.project.id, ...payload };
  rememberTurnEvent(enriched);
  broadcast(enriched);
}

function enqueueChatJob(job) {
  const state = getConversationQueue(job.queueKey);
  rememberConversationAlias(job.queueKey, job.selectedSessionId);
  rememberConversationAlias(job.queueKey, job.draftSessionId);

  const queued = state.running || state.jobs.length > 0;
  state.jobs.push(job);

  if (queued) {
    const sessionId = state.sessionId || job.selectedSessionId || job.draftSessionId;
    rememberTurn(job.turnId, {
      status: 'queued',
      label: '已加入队列',
      sessionId: sessionId || null
    });
    broadcast({
      type: 'status-update',
      projectId: job.project.id,
      sessionId,
      turnId: job.turnId,
      kind: 'turn',
      status: 'queued',
      label: '已加入队列',
      detail: '',
      timestamp: new Date().toISOString()
    });
  }

  runNextQueuedChat(job.queueKey);
  return queued;
}

function runNextQueuedChat(queueKey) {
  const state = getConversationQueue(queueKey);
  if (state.running) {
    return;
  }

  const job = state.jobs.shift();
  if (!job) {
    return;
  }

  state.running = true;
  const sessionId = state.sessionId || job.selectedSessionId;

  runCodexTurn(
    {
      sessionId,
      draftSessionId: job.draftSessionId,
      projectPath: job.project.path,
      message: job.codexMessage,
      model: job.model,
      reasoningEffort: job.reasoningEffort,
      permissionMode: job.permissionMode,
      turnId: job.turnId
    },
    (payload) => {
      if (payload.sessionId) {
        state.sessionId = payload.sessionId;
        rememberConversationAlias(queueKey, payload.sessionId);
      }
      if (payload.previousSessionId) {
        rememberConversationAlias(queueKey, payload.previousSessionId);
      }
      emitJobEvent(job, payload);
    }
  ).then(async (finalSessionId) => {
    const shouldRegisterMobileSession =
      finalSessionId &&
      finalSessionId !== sessionId &&
      finalSessionId !== job.selectedSessionId;
    if (shouldRegisterMobileSession) {
      state.sessionId = finalSessionId;
      rememberConversationAlias(queueKey, finalSessionId);
      await registerMobileSession({
        id: finalSessionId,
        projectPath: job.project.path,
        title: job.displayMessage.slice(0, 52),
        summary: job.displayMessage,
        updatedAt: new Date().toISOString()
      });
    } else if (finalSessionId) {
      state.sessionId = finalSessionId;
      rememberConversationAlias(queueKey, finalSessionId);
    }
    rememberTurn(job.turnId, {
      projectId: job.project.id,
      sessionId: finalSessionId || sessionId || job.selectedSessionId || job.draftSessionId || null,
      previousSessionId: job.draftSessionId || job.selectedSessionId || null
    });
  }).finally(async () => {
    try {
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    } catch (error) {
      console.warn('[sync] Failed to refresh after chat:', error.message);
    } finally {
      state.running = false;
      if (state.jobs.length) {
        setTimeout(() => runNextQueuedChat(queueKey), 0);
      }
    }
  });
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/status') {
    sendJson(res, 200, await publicStatus(await isAuthenticated(req)));
    return;
  }

  if (method === 'POST' && pathname === '/api/pair') {
    const body = await readBody(req);
    const paired = await pairDevice({
      code: body.code,
      deviceName: body.deviceName,
      userAgent: req.headers['user-agent'],
      remoteAddress: remoteAddress(req)
    });
    if (!paired) {
      sendJson(res, 403, { error: 'Invalid pairing code' });
      return;
    }
    sendJson(res, 200, paired);
    return;
  }

  if (method === 'GET' && pathname === '/api/feishu/auth/callback') {
    await handleFeishuCallback(req, res, url);
    return;
  }

  if (!(await requireAuth(req, res, pathname))) {
    return;
  }

  if (method === 'POST' && pathname === '/api/sync') {
    const snapshot = await refreshCodexCache();
    broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
    sendJson(res, 200, { success: true, ...snapshot });
    return;
  }

  if (method === 'GET' && pathname === '/api/projects') {
    sendJson(res, 200, { projects: listProjects() });
    return;
  }

  if (method === 'GET' && pathname === '/api/quotas/codex') {
    try {
      sendJson(res, 200, await getCodexQuota());
    } catch (error) {
      console.warn(`[quota] codex quota failed remote=${remoteAddress(req)} message=${error.message || 'unknown'}`);
      sendJson(res, 500, { error: 'Failed to query Codex quota' });
    }
    return;
  }

  if (method === 'GET' && pathname === '/api/feishu/status') {
    sendJson(res, 200, await publicDocsStatus(true));
    return;
  }

  if (method === 'POST' && pathname === '/api/feishu/cli/auth/start') {
    try {
      const auth = await startLarkCliAuth();
      sendJson(res, 200, {
        success: true,
        ...auth,
        docs: await publicDocsStatus(true)
      });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      console.warn(`[lark-cli] auth start failed remote=${remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || '飞书 CLI 授权失败' });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/feishu/cli/auth/logout') {
    try {
      await logoutLarkCli();
      sendJson(res, 200, {
        success: true,
        docs: await publicDocsStatus(true)
      });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      console.warn(`[lark-cli] auth logout failed remote=${remoteAddress(req)} message=${error.message}`);
      sendJson(res, statusCode, { error: error.message || '断开飞书 CLI 授权失败' });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/feishu/auth/start') {
    if (!feishuConfigured()) {
      sendJson(res, 400, { error: 'Feishu app credentials are not configured' });
      return;
    }
    cleanupFeishuPendingStates();
    const state = crypto.randomBytes(24).toString('base64url');
    const redirectUri = feishuRedirectUri(req);
    feishuAuthState.pendingStates[state] = {
      createdAt: Date.now(),
      redirectUri
    };
    await saveFeishuAuthState();
    const authUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/index');
    authUrl.searchParams.set('app_id', FEISHU_APP_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);
    sendJson(res, 200, {
      url: authUrl.toString(),
      redirectUri
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/feishu/auth/logout') {
    feishuAuthState.token = null;
    await saveFeishuAuthState();
    sendJson(res, 200, { success: true, ...(await publicDocsStatus(true)) });
    return;
  }

  const parts = pathname.split('/').filter(Boolean);

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
    const projectId = decodeURIComponent(parts[2]);
    sendJson(res, 200, { sessions: listProjectSessions(projectId) });
    return;
  }

  if (method === 'PATCH' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
    const projectId = decodeURIComponent(parts[2]);
    const sessionId = decodeURIComponent(parts[4]);
    const project = getProject(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const session = getSession(sessionId);
    if (!session || session.projectId !== project.id) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }

    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 52);
    if (!title) {
      sendJson(res, 400, { error: 'Title is required' });
      return;
    }

    try {
      const renamed = await renameSession(session.id, project.id, title);
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, session: renamed });
    } catch (error) {
      console.warn(`[sessions] rename failed session=${sessionId} project=${projectId}: ${error.message}`);
      sendJson(res, 500, { error: 'Failed to rename session' });
    }
    return;
  }

  if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'sessions') {
    const projectId = decodeURIComponent(parts[2]);
    const sessionId = decodeURIComponent(parts[4]);
    const project = getProject(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const session = getSession(sessionId);
    if (!session || session.projectId !== project.id) {
      sendJson(res, 404, { error: 'Session not found' });
      return;
    }
    if (sessionHasActiveWork(sessionId)) {
      sendJson(res, 409, { error: 'Session is running' });
      return;
    }
    try {
      const deleted = await deleteSession(sessionId, project.id);
      const snapshot = await refreshCodexCache();
      broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
      sendJson(res, 200, { success: true, ...deleted });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      console.warn(`[sessions] delete failed session=${sessionId} project=${projectId}: ${error.message}`);
      sendJson(res, statusCode, { error: statusCode === 409 ? error.message : 'Failed to delete session' });
    }
    return;
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'chat' && parts[2] === 'turns') {
    const turnId = decodeURIComponent(parts[3]);
    sendJson(res, 200, { turn: recentTurns.get(turnId) || null });
    return;
  }

  if (method === 'DELETE' && parts.length === 5 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
    const sessionId = decodeURIComponent(parts[2]);
    const messageId = decodeURIComponent(parts[4]);
    try {
      const deleted = await hideSessionMessage(sessionId, messageId);
      broadcast({ type: 'message-deleted', ...deleted });
      sendJson(res, 200, { success: true, ...deleted });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      console.warn(`[sessions] message delete failed session=${sessionId} message=${messageId}: ${error.message}`);
      sendJson(res, statusCode, { error: statusCode === 400 ? error.message : 'Failed to delete message' });
    }
    return;
  }

  if (method === 'GET' && parts.length === 4 && parts[0] === 'api' && parts[1] === 'sessions' && parts[3] === 'messages') {
    const sessionId = decodeURIComponent(parts[2]);
    const limit = url.searchParams.get('limit');
    const offset = url.searchParams.has('offset') ? url.searchParams.get('offset') : null;
    const result = await readSessionMessages(sessionId, {
      limit: limit ? Number(limit) : 120,
      offset: offset !== null ? Number(offset) : null,
      latest: offset === null || url.searchParams.get('latest') === '1'
    });
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && pathname === '/api/uploads') {
    const upload = await saveUpload(req);
    console.log(`[upload] saved name=${upload.name} size=${upload.size} kind=${upload.kind} remote=${remoteAddress(req)}`);
    sendJson(res, 200, { upload });
    return;
  }

  if (method === 'POST' && pathname === '/api/voice/transcribe') {
    const startedAt = Date.now();
    try {
      const audio = await readVoiceUpload(req);
      const config = getCacheSnapshot().config || {};
      const result = await transcribeAudio(audio, config);
      console.log(`[voice] transcribed size=${audio.data.length} mime=${audio.mimeType} provider=${result.provider} model=${result.model} remote=${remoteAddress(req)}`);
      sendJson(res, 200, { text: result.text || '', durationMs: Date.now() - startedAt });
    } catch (error) {
      const statusCode = error.statusCode || 502;
      const providerInfo = error.providerHost ? ` provider=${error.providerHost}` : '';
      const safeMessage = String(error.message || '语音转写失败')
        .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
        .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]');
      console.warn(`[voice] transcribe failed status=${statusCode}${providerInfo} remote=${remoteAddress(req)} message=${safeMessage}`);
      sendJson(res, statusCode, {
        error: safeMessage || '语音转写失败'
      });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/voice/speech') {
    const startedAt = Date.now();
    try {
      const body = await readBody(req);
      const config = getCacheSnapshot().config || {};
      const result = await synthesizeSpeech(body.text, config);
      console.log(`[voice] synthesized bytes=${result.data.length} provider=${result.provider} model=${result.model} voice=${result.voice} remote=${remoteAddress(req)}`);
      res.writeHead(200, {
        'content-type': result.mimeType,
        'content-length': result.data.length,
        'cache-control': 'no-store',
        'x-codexmobile-duration-ms': String(Date.now() - startedAt)
      });
      res.end(result.data);
    } catch (error) {
      const statusCode = error.statusCode || 502;
      const safeMessage = String(error.message || '语音合成失败')
        .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
        .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]');
      console.warn(`[voice] speech failed status=${statusCode} remote=${remoteAddress(req)} message=${safeMessage}`);
      sendJson(res, statusCode, {
        error: safeMessage || '语音合成失败'
      });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/chat/send') {
    const body = await readBody(req);
    const attachmentCount = Array.isArray(body.attachments) ? body.attachments.length : 0;
    console.log(
      `[chat] send request remote=${remoteAddress(req)} project=${body.projectId || ''} session=${body.sessionId || body.draftSessionId || ''} attachments=${attachmentCount}`
    );
    const project = getProject(body.projectId);
    if (!project) {
      console.warn(`[chat] rejected project not found: ${body.projectId || ''}`);
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    const attachments = normalizeAttachments(body.attachments);
    const message = String(body.message || '').trim();
    if (!message && !attachments.length) {
      sendJson(res, 400, { error: 'message or attachments are required' });
      return;
    }

    const requestedSessionId = String(body.sessionId || '').trim();
    const isDraftSession = requestedSessionId.startsWith('draft-');
    let session = requestedSessionId && !isDraftSession ? getSession(requestedSessionId) : null;
    if (requestedSessionId && !isDraftSession && !session) {
      await refreshCodexCache().catch((error) => {
        console.warn(`[chat] failed to refresh while resolving session=${requestedSessionId}: ${error.message}`);
      });
      session = getSession(requestedSessionId);
    }
    if (requestedSessionId && !isDraftSession && !session) {
      console.warn(`[chat] rejected unknown session: session=${requestedSessionId} requestedProject=${project.id}`);
      sendJson(res, 404, { error: 'Session not found in Codex App. Please reselect a visible thread or start a new conversation.' });
      return;
    }
    if (session && session.projectId !== project.id) {
      console.warn(
        `[chat] rejected cross-project session: session=${session.id} sessionProject=${session.projectId} requestedProject=${project.id}`
      );
      sendJson(res, 409, { error: 'Session does not belong to the selected project. Please reselect the thread under the correct project.' });
      return;
    }
    if (session?.mobileOnly) {
      console.warn(`[chat] rejected mobile-only session resume: session=${session.id} project=${project.id}`);
      sendJson(res, 409, { error: 'This mobile-only session is not resumable by Codex App. Please start a new conversation or select a Codex App thread.' });
      return;
    }
    const draftSessionId = String(body.draftSessionId || '').trim() || null;
    const selectedSessionId = session ? session.id : null;
    const turnId = String(body.clientTurnId || '').trim() || crypto.randomUUID();
    const config = getCacheSnapshot().config || {};
    const displayMessage = message || '请查看附件。';
    const codexMessage = withAttachmentReferences(displayMessage, attachments);
    const imagePrompt = isImageRequest(displayMessage, attachments)
      ? displayMessage
      : resolveContinuationImagePrompt(project.id, displayMessage);
    const conversationSessionId = selectedSessionId || draftSessionId || null;
    rememberTurn(turnId, {
      projectId: project.id,
      projectPath: project.path,
      sessionId: conversationSessionId,
      previousSessionId: draftSessionId || selectedSessionId || null,
      draftSessionId,
      status: 'accepted',
      label: '正在思考',
      hadAssistantText: false,
      startedAt: new Date().toISOString()
    });

    broadcast({
      type: 'user-message',
      sessionId: conversationSessionId,
      projectId: project.id,
      message: {
        id: `local-${Date.now()}`,
        role: 'user',
        content: displayMessage,
        timestamp: new Date().toISOString()
      }
    });

    if (imagePrompt) {
      rememberImagePrompt(project.id, imagePrompt);
      const imageSessionId = selectedSessionId || `mobile-image-${crypto.randomUUID()}`;
      const previousSessionId = imageSessionId === conversationSessionId ? draftSessionId : conversationSessionId;
      const imageLabel = attachments.some((attachment) => attachment.kind === 'image') ? '正在编辑图片' : '正在生成图片';
      activeImageRuns.set(turnId, {
        turnId,
        sessionId: imageSessionId,
        previousSessionId,
        startedAt: new Date().toISOString(),
        status: 'running',
        label: imageLabel
      });
      console.log(`[chat] accepted image turn=${turnId} session=${imageSessionId} project=${project.name}`);
      rememberTurn(turnId, {
        projectId: project.id,
        projectPath: project.path,
        sessionId: imageSessionId,
        previousSessionId,
        status: 'running',
        kind: 'image_generation_call',
        label: imageLabel
      });
      runImageTurn(
        {
          sessionId: imageSessionId,
          previousSessionId,
          projectPath: project.path,
          message: imagePrompt,
          attachments,
          config,
          turnId,
          persistMobileSession: true
        },
        (payload) => {
          if (payload.turnId && activeImageRuns.has(payload.turnId)) {
            const existing = activeImageRuns.get(payload.turnId);
            if (payload.type === 'status-update' || payload.type === 'activity-update') {
              activeImageRuns.set(payload.turnId, {
                ...existing,
                sessionId: payload.sessionId || existing.sessionId,
                previousSessionId: payload.previousSessionId || existing.previousSessionId,
                status: payload.status || existing.status,
                label: payload.label || existing.label
              });
            }
          }
          emitJobEvent({ project }, payload);
        }
      ).then(async (finalSessionId) => {
        rememberTurn(turnId, {
          projectId: project.id,
          sessionId: finalSessionId,
          previousSessionId
        });
        try {
          const snapshot = await refreshCodexCache();
          broadcast({ type: 'sync-complete', syncedAt: snapshot.syncedAt, projects: snapshot.projects });
        } catch (error) {
          console.warn('[sync] Failed to refresh after image chat:', error.message);
        }
      }).catch((error) => {
        const errorMessage = error?.message || '图片生成失败';
        activeImageRuns.delete(turnId);
        rememberTurn(turnId, {
          projectId: project.id,
          sessionId: imageSessionId,
          previousSessionId,
          status: 'failed',
          error: errorMessage,
          label: '图片生成失败'
        });
        emitJobEvent({ project }, {
          type: 'chat-error',
          sessionId: imageSessionId,
          previousSessionId,
          turnId,
          error: errorMessage
        });
      }).finally(() => {
        activeImageRuns.delete(turnId);
      });
      sendJson(res, 202, {
        accepted: true,
        queued: false,
        sessionId: imageSessionId,
        draftSessionId,
        turnId,
        mode: 'image'
      });
      return;
    }

    console.log(`[chat] accepted codex turn=${turnId} session=${selectedSessionId || draftSessionId || ''} project=${project.name}`);
    const queueKey = resolveConversationKey(selectedSessionId, draftSessionId, requestedSessionId);
    const queued = enqueueChatJob({
      queueKey,
      project,
      selectedSessionId,
      draftSessionId,
      turnId,
      codexMessage,
      displayMessage,
      model: session?.model || body.model || config.model || 'gpt-5.5',
      reasoningEffort: body.reasoningEffort || DEFAULT_REASONING_EFFORT,
      permissionMode: body.permissionMode || 'default'
    });

    sendJson(res, 202, { accepted: true, queued, sessionId: selectedSessionId, draftSessionId, turnId });
    return;
  }

  if (method === 'POST' && pathname === '/api/chat/abort') {
    const body = await readBody(req);
    console.log(`[chat] abort request remote=${remoteAddress(req)} turn=${body.turnId || ''} session=${body.sessionId || ''}`);
    const aborted = abortCodexTurn(body.turnId || body.sessionId);
    sendJson(res, aborted ? 200 : 404, { aborted });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

async function serveFileFromRoot(req, res, rootDir, requestedPath, cacheControl) {
  const relativePath = requestedPath.replace(/^\/+/, '');
  const candidate = path.normalize(path.join(rootDir, relativePath));
  const rootWithSep = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
  if (candidate !== rootDir && !candidate.startsWith(rootWithSep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return true;
  }

  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return true;
    }
    const ext = path.extname(candidate);
    const content = await fs.readFile(candidate);
    sendStaticContent(req, res, 200, content, {
      'content-type': mimeTypes.get(ext) || 'application/octet-stream',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff'
    }, ext);
    return true;
  } catch {
    res.writeHead(404);
    res.end('Not found');
    return true;
  }
}

async function serveStatic(req, res, url) {
  let requestedPath = decodeURIComponent(url.pathname);
  if (requestedPath === '/codexmobile-root-ca.cer') {
    try {
      const stat = await fs.stat(HTTPS_ROOT_CA_PATH);
      const content = await fs.readFile(HTTPS_ROOT_CA_PATH);
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-length': stat.size,
        'cache-control': 'no-store',
        'content-disposition': 'attachment; filename="codexmobile-root-ca.cer"',
        'x-content-type-options': 'nosniff'
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('Certificate not found');
    }
    return;
  }

  if (requestedPath.startsWith('/generated/')) {
    await serveFileFromRoot(
      req,
      res,
      GENERATED_ROOT,
      requestedPath.slice('/generated/'.length),
      'private, max-age=86400'
    );
    return;
  }

  if (requestedPath === '/') {
    requestedPath = '/index.html';
  }

  const candidate = path.normalize(path.join(CLIENT_DIST, requestedPath));
  if (!candidate.startsWith(CLIENT_DIST)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const stat = await fs.stat(candidate);
    const filePath = stat.isDirectory() ? path.join(candidate, 'index.html') : candidate;
    const ext = path.extname(filePath);
    const content = await fs.readFile(filePath);
    sendStaticContent(req, res, 200, content, {
      'content-type': mimeTypes.get(ext) || 'application/octet-stream',
      'cache-control': staticCacheControl(ext, filePath),
      'x-content-type-options': 'nosniff'
    }, ext);
  } catch {
    const indexPath = path.join(CLIENT_DIST, 'index.html');
    try {
      const content = await fs.readFile(indexPath);
      sendStaticContent(req, res, 200, content, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }, '.html');
    } catch {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('CodexMobile server is running. Build the PWA with: npm run build');
    }
  }
}

async function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    console.error('[server] Request failed:', error);
    sendJson(res, 500, { error: error.message || 'Internal server error' });
  }
}

async function main() {
  const auth = await initializeAuth();
  await loadFeishuAuthState();
  await loadRecentImagePrompts();
  await refreshCodexCache();

  const server = http.createServer(requestHandler);
  const wss = new WebSocketServer({ noServer: true });
  const realtimeWss = new WebSocketServer({ noServer: true });

  const handleUpgrade = async (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    if (url.pathname !== '/ws' && url.pathname !== '/ws/realtime') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token') || '';
    const ok = await verifyToken(token, { remoteAddress: remoteAddress(req) });
    if (!ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (url.pathname === '/ws/realtime') {
      realtimeWss.handleUpgrade(req, socket, head, (ws) => {
        startVoiceRealtimeProxy(ws, { remoteAddress: remoteAddress(req) });
      });
      return;
    }

    wss.handleUpgrade(req, socket, head, async (ws) => {
      sockets.add(ws);
      ws.on('close', () => sockets.delete(ws));
      ws.send(JSON.stringify({ type: 'connected', status: await publicStatus(true) }));
    });
  };

  server.on('upgrade', handleUpgrade);

  server.listen(PORT, HOST, () => {
    console.log(`CodexMobile listening on http://${HOST}:${PORT}`);
    console.log(`Pairing code: ${getPairingCode()} (${auth.trustedDevices} trusted device(s)${auth.fixedPairingCode ? ', fixed' : ''})`);
    console.log('Use Tailscale and open http://<this-pc-tailscale-ip>:3321 on iPhone.');
  });

  try {
    const pfx = await fs.readFile(HTTPS_PFX_PATH);
    const httpsServer = https.createServer({ pfx, passphrase: HTTPS_PFX_PASSPHRASE }, requestHandler);
    httpsServer.on('upgrade', handleUpgrade);
    httpsServer.listen(HTTPS_PORT, HOST, () => {
      console.log(`CodexMobile HTTPS listening on https://${HOST}:${HTTPS_PORT}`);
      if (PUBLIC_URL) {
        console.log(`Public/private URL: ${PUBLIC_URL}`);
      } else {
        console.log(`Use Tailscale HTTPS: https://<your-device>.<your-tailnet>.ts.net:${HTTPS_PORT}/`);
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log(`CodexMobile HTTPS disabled: certificate not found at ${HTTPS_PFX_PATH}`);
    } else {
      console.warn(`[server] Failed to start HTTPS listener: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error('[server] Failed to start:', error);
  process.exitCode = 1;
});
