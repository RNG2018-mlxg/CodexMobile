import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CLIPROXY_CONFIG = process.platform === 'win32'
  ? 'D:\\CLIProxyAPI\\config.yaml'
  : path.join(os.homedir(), '.cli-proxy-api', 'config.yaml');
const DEFAULT_AUTH_DIR = path.join(os.homedir(), '.cli-proxy-api');
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const REQUEST_TIMEOUT_MS = 18_000;
const MANAGEMENT_TIMEOUT_MS = 30_000;
const FIXED_PAIRING_CODE_FILE = path.join(process.cwd(), '.codexmobile', 'state', 'pairing-code.txt');

function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandHome(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return raw;
  }
  if (raw === '~') {
    return os.homedir();
  }
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  return raw;
}

async function readCliproxyConfig() {
  const configPath = process.env.CLIPROXYAPI_CONFIG || DEFAULT_CLIPROXY_CONFIG;
  const config = {
    host: '127.0.0.1',
    port: 8317,
    tls: false,
    authDir: ''
  };
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    let section = '';
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const sectionMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*$/);
      if (sectionMatch) {
        section = sectionMatch[1];
        continue;
      }
      const valueMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+?)\s*(?:#.*)?$/);
      if (!valueMatch) {
        continue;
      }
      const key = valueMatch[1];
      const value = stripQuotes(valueMatch[2]);
      if (section === 'tls' && key === 'enable') {
        config.tls = /^true$/i.test(value);
      } else if (key === 'host') {
        config.host = value || config.host;
      } else if (key === 'port') {
        const port = Number(value);
        if (Number.isFinite(port) && port > 0) {
          config.port = port;
        }
      } else if (key === 'auth-dir') {
        config.authDir = path.resolve(expandHome(value));
      }
    }
  } catch {
    // Defaults are enough for the normal local CLIProxyAPI install.
  }
  return config;
}

async function resolveAuthDir() {
  const explicit = process.env.CODEXMOBILE_CLIPROXY_AUTH_DIR || process.env.CLIPROXYAPI_AUTH_DIR;
  if (explicit) {
    return path.resolve(expandHome(explicit));
  }

  const config = await readCliproxyConfig();
  if (config.authDir) {
    return config.authDir;
  }

  return DEFAULT_AUTH_DIR;
}

async function resolveManagementBaseUrl() {
  const explicit = String(process.env.CODEXMOBILE_CLIPROXY_MANAGEMENT_URL || process.env.CLIPROXYAPI_MANAGEMENT_URL || '').trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }
  const config = await readCliproxyConfig();
  const host = !config.host || config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  return `${config.tls ? 'https' : 'http'}://${host}:${config.port}`;
}

async function resolveManagementKey() {
  for (const value of [
    process.env.CODEXMOBILE_CLIPROXY_MANAGEMENT_KEY,
    process.env.CLIPROXYAPI_MANAGEMENT_KEY,
    process.env.MANAGEMENT_PASSWORD,
    process.env.CODEXMOBILE_PAIRING_CODE
  ]) {
    const trimmed = String(value || '').trim();
    if (trimmed) {
      return trimmed;
    }
  }
  try {
    return (await fs.readFile(FIXED_PAIRING_CODE_FILE, 'utf8')).trim();
  } catch {
    return '';
  }
}

function maskAccount(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 'Codex';
  }
  const emailMatch = text.match(/^(.)([^@]*)(@.+)$/);
  if (emailMatch) {
    return `${emailMatch[1]}***${emailMatch[3]}`;
  }
  if (text.length <= 6) {
    return `${text.slice(0, 1)}***`;
  }
  return `${text.slice(0, 3)}***${text.slice(-2)}`;
}

function safeId(...values) {
  const source = values.find((value) => value) || crypto.randomUUID();
  return crypto.createHash('sha256').update(String(source)).digest('hex').slice(0, 16);
}

function normalizePlan(value, fallback = '') {
  const text = String(value || fallback || '').trim().toLowerCase();
  if (!text) {
    return '';
  }
  if (text.includes('team')) {
    return 'Team';
  }
  if (text.includes('plus')) {
    return 'Plus';
  }
  if (text.includes('prolite') || text.includes('pro_lite') || text.includes('pro 5')) {
    return 'Pro 5x';
  }
  if (text.includes('pro')) {
    return 'Pro 20x';
  }
  if (text.includes('free')) {
    return 'Free';
  }
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function planFromFileName(fileName) {
  const match = String(fileName || '').match(/-([A-Za-z0-9_]+)\.json$/);
  return match ? match[1] : '';
}

function authEntryName(entry) {
  return String(entry?.name || entry?.fileName || entry?.id || '').trim();
}

function authEntryAccountId(entry) {
  return String(
    entry?.id_token?.chatgpt_account_id ||
    entry?.id_token?.chatgptAccountId ||
    entry?.metadata?.id_token?.chatgpt_account_id ||
    entry?.metadata?.id_token?.chatgptAccountId ||
    entry?.account_id ||
    entry?.accountId ||
    ''
  ).trim();
}

function authEntryPlan(entry) {
  return (
    entry?.plan_type ||
    entry?.planType ||
    entry?.id_token?.plan_type ||
    entry?.id_token?.planType ||
    entry?.metadata?.id_token?.plan_type ||
    entry?.metadata?.id_token?.planType ||
    planFromFileName(authEntryName(entry))
  );
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const normalized = trimmed.endsWith('%') ? trimmed.slice(0, -1) : trimmed;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePercent(value, limitReached, allowed) {
  const parsed = numberOrNull(value);
  if (parsed !== null) {
    return Math.max(0, Math.min(100, parsed));
  }
  if (limitReached || allowed === false) {
    return 100;
  }
  return null;
}

function windowSeconds(window) {
  return numberOrNull(window?.limit_window_seconds ?? window?.limitWindowSeconds);
}

function slugLabel(value, fallback) {
  const text = String(value || fallback || '').trim();
  if (!text) {
    return 'additional';
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'additional';
}

function resetLabel(window) {
  const value =
    window?.reset_after_seconds ??
    window?.resetAfterSeconds ??
    window?.reset_in ??
    window?.resetIn ??
    window?.ttl;
  const seconds = numberOrNull(value);
  if (!seconds || seconds <= 0) {
    return '';
  }
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return '<1m';
}

function selectPrimaryWindows(rateLimit) {
  const primary = rateLimit?.primary_window ?? rateLimit?.primaryWindow ?? null;
  const secondary = rateLimit?.secondary_window ?? rateLimit?.secondaryWindow ?? null;
  const candidates = [primary, secondary].filter(Boolean);
  let fiveHourWindow = null;
  let weeklyWindow = null;

  for (const candidate of candidates) {
    const seconds = windowSeconds(candidate);
    if (seconds === 18_000 && !fiveHourWindow) {
      fiveHourWindow = candidate;
    } else if (seconds === 604_800 && !weeklyWindow) {
      weeklyWindow = candidate;
    }
  }

  if (!fiveHourWindow && primary !== weeklyWindow) {
    fiveHourWindow = primary;
  }
  if (!weeklyWindow && secondary !== fiveHourWindow) {
    weeklyWindow = secondary;
  }

  return { fiveHourWindow, weeklyWindow };
}

function quotaWindow(id, label, window, rateLimit) {
  if (!window) {
    return null;
  }
  const usedPercent = normalizePercent(
    window.used_percent ?? window.usedPercent,
    rateLimit?.limit_reached ?? rateLimit?.limitReached,
    rateLimit?.allowed
  );
  return {
    id,
    label,
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    displayPercent: usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)),
    resetLabel: resetLabel(window)
  };
}

function extractWindows(payload) {
  const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? null;
  if (!rateLimit) {
    return [];
  }
  const { fiveHourWindow, weeklyWindow } = selectPrimaryWindows(rateLimit);
  return [
    quotaWindow('five-hour', '5 小时限额', fiveHourWindow, rateLimit),
    quotaWindow('weekly', '周限额', weeklyWindow, rateLimit)
  ].filter(Boolean);
}

function quotaWindowsForRateLimit(rateLimit, labels) {
  if (!rateLimit) {
    return [];
  }
  const { fiveHourWindow, weeklyWindow } = selectPrimaryWindows(rateLimit);
  return [
    quotaWindow(labels.fiveHourId, labels.fiveHourLabel, fiveHourWindow, rateLimit),
    quotaWindow(labels.weeklyId, labels.weeklyLabel, weeklyWindow, rateLimit)
  ].filter(Boolean);
}

function additionalQuotaWindows(payload) {
  const limits = payload?.additional_rate_limits ?? payload?.additionalRateLimits;
  if (!Array.isArray(limits)) {
    return [];
  }
  return limits.flatMap((entry, index) => {
    const rateLimit = entry?.rate_limit ?? entry?.rateLimit ?? null;
    if (!rateLimit) {
      return [];
    }
    const rawName =
      entry?.limit_name ??
      entry?.limitName ??
      entry?.metered_feature ??
      entry?.meteredFeature ??
      `additional-${index + 1}`;
    const name = String(rawName || `additional-${index + 1}`).trim() || `additional-${index + 1}`;
    const slug = slugLabel(name, `additional-${index + 1}`);
    const primary = rateLimit.primary_window ?? rateLimit.primaryWindow ?? null;
    const secondary = rateLimit.secondary_window ?? rateLimit.secondaryWindow ?? null;
    return [
      quotaWindow(`${slug}-five-hour-${index}`, `${name} 5 小时限额`, primary, rateLimit),
      quotaWindow(`${slug}-weekly-${index}`, `${name} 周限额`, secondary, rateLimit)
    ].filter(Boolean);
  });
}

function extractQuotaWindows(payload) {
  const rateLimit = payload?.rate_limit ?? payload?.rateLimit ?? null;
  const codeReviewRateLimit = payload?.code_review_rate_limit ?? payload?.codeReviewRateLimit ?? null;
  return [
    ...quotaWindowsForRateLimit(rateLimit, {
      fiveHourId: 'five-hour',
      fiveHourLabel: '5 小时限额',
      weeklyId: 'weekly',
      weeklyLabel: '周限额'
    }),
    ...quotaWindowsForRateLimit(codeReviewRateLimit, {
      fiveHourId: 'code-review-five-hour',
      fiveHourLabel: '代码审查 5 小时限额',
      weeklyId: 'code-review-weekly',
      weeklyLabel: '代码审查周限额'
    }),
    ...additionalQuotaWindows(payload)
  ];
}

async function readJsonFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

function safeErrorMessage(error) {
  const status = error?.statusCode || error?.status;
  if (status) {
    return `HTTP ${status}`;
  }
  if (error?.name === 'AbortError') {
    return '请求超时';
  }
  return '查询失败';
}

async function requestCodexUsage(credential) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(CODEX_USAGE_URL, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${credential.access_token}`,
        'Chatgpt-Account-Id': credential.account_id,
        'Content-Type': 'application/json',
        'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
      }
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error('Codex quota request failed');
      error.statusCode = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function managementJson(baseUrl, managementKey, route, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MANAGEMENT_TIMEOUT_MS);
  try {
    const headers = {
      'X-Management-Key': managementKey,
      ...(options.headers || {})
    };
    const response = await fetch(`${baseUrl}${route}`, {
      ...options,
      signal: controller.signal,
      headers
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = new Error(body?.error || `CLIProxyAPI management HTTP ${response.status}`);
      error.statusCode = response.status;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function managementApiCall(baseUrl, managementKey, authIndex, accountId) {
  const response = await managementJson(baseUrl, managementKey, '/v0/management/api-call', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      authIndex,
      method: 'GET',
      url: CODEX_USAGE_URL,
      header: {
        Authorization: 'Bearer $TOKEN$',
        'Chatgpt-Account-Id': accountId,
        'Content-Type': 'application/json',
        'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal'
      }
    })
  });
  const statusCode = Number(response?.status_code ?? response?.statusCode ?? 0);
  const rawBody = response?.body ?? response?.bodyText ?? '';
  let body = null;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    body = null;
  }
  if (statusCode < 200 || statusCode >= 300) {
    const error = new Error(body?.error?.message || body?.error || `Codex quota HTTP ${statusCode || 'unknown'}`);
    error.statusCode = statusCode || 502;
    throw error;
  }
  return body;
}

function baseAccount(fileName, credential) {
  const email = credential.email || fileName.replace(/^codex-/, '').replace(/-[^-]+\.json$/, '');
  return {
    id: safeId(credential.account_id, credential.email, fileName),
    label: maskAccount(email),
    plan: normalizePlan(credential.plan_type || credential.planType, planFromFileName(fileName)),
    disabled: Boolean(credential.disabled),
    status: 'ok',
    windows: []
  };
}

function baseAccountFromAuthEntry(entry) {
  const name = authEntryName(entry);
  const email = entry?.email || entry?.account || entry?.label || name.replace(/^codex-/, '').replace(/-[^-]+\.json$/i, '');
  return {
    id: safeId(entry?.auth_index || entry?.authIndex, entry?.id, email, name),
    label: maskAccount(email),
    plan: normalizePlan(authEntryPlan(entry), planFromFileName(name)),
    disabled: Boolean(entry?.disabled),
    status: 'ok',
    windows: []
  };
}

async function quotaForFile(authDir, fileName) {
  const filePath = path.join(authDir, fileName);
  const credential = await readJsonFile(filePath);
  const account = baseAccount(fileName, credential);

  if (account.disabled) {
    return { ...account, status: 'disabled', error: '已停用' };
  }
  if (!credential.access_token || !credential.account_id) {
    return { ...account, status: 'failed', error: '凭证缺少额度查询信息' };
  }

  try {
    const usage = await requestCodexUsage(credential);
    return {
      ...account,
      plan: normalizePlan(usage?.plan_type ?? usage?.planType, account.plan),
      status: 'ok',
      windows: extractQuotaWindows(usage)
    };
  } catch (error) {
    return {
      ...account,
      status: 'failed',
      error: safeErrorMessage(error)
    };
  }
}

async function quotaForManagementEntry(baseUrl, managementKey, entry) {
  const account = baseAccountFromAuthEntry(entry);
  if (account.disabled) {
    return { ...account, status: 'disabled', error: '宸插仠鐢?' };
  }
  const authIndex = String(entry?.auth_index || entry?.authIndex || '').trim();
  if (!authIndex) {
    return { ...account, status: 'failed', error: 'missing auth_index' };
  }
  const accountId = authEntryAccountId(entry);
  if (!accountId) {
    return { ...account, status: 'failed', error: 'missing account_id' };
  }
  try {
    const usage = await managementApiCall(baseUrl, managementKey, authIndex, accountId);
    return {
      ...account,
      plan: normalizePlan(usage?.plan_type ?? usage?.planType, account.plan),
      status: 'ok',
      windows: extractQuotaWindows(usage)
    };
  } catch (error) {
    return {
      ...account,
      status: 'failed',
      error: safeErrorMessage(error)
    };
  }
}

async function getCodexQuotaFromManagement() {
  const managementKey = await resolveManagementKey();
  if (!managementKey) {
    return null;
  }
  const baseUrl = await resolveManagementBaseUrl();
  const payload = await managementJson(baseUrl, managementKey, '/v0/management/auth-files');
  const entries = (Array.isArray(payload?.files) ? payload.files : [])
    .filter((entry) => {
      const provider = String(entry?.provider || entry?.type || '').trim().toLowerCase();
      const name = authEntryName(entry).toLowerCase();
      return provider === 'codex' || name.startsWith('codex-');
    });
  const accounts = await Promise.all(
    entries.map((entry) => quotaForManagementEntry(baseUrl, managementKey, entry))
  );
  return {
    provider: 'cliproxyapi',
    source: 'cliproxyapi-management',
    accounts
  };
}

export async function getCodexQuota() {
  try {
    const managed = await getCodexQuotaFromManagement();
    if (managed) {
      return managed;
    }
  } catch (error) {
    console.warn(`[quota] CLIProxyAPI management quota fallback: ${safeErrorMessage(error)}`);
  }

  const authDir = await resolveAuthDir();
  let files = [];
  try {
    files = (await fs.readdir(authDir))
      .filter((fileName) => /^codex-.+\.json$/i.test(fileName))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    error.statusCode = 500;
    throw error;
  }

  const accounts = await Promise.all(
    files.map(async (fileName) => {
      try {
        return await quotaForFile(authDir, fileName);
      } catch {
        return {
          id: safeId(fileName),
          label: maskAccount(fileName.replace(/^codex-/, '').replace(/\.json$/, '')),
          plan: normalizePlan(planFromFileName(fileName)),
          disabled: false,
          status: 'failed',
          error: '凭证读取失败',
          windows: []
        };
      }
    })
  );

  return {
    provider: 'cliproxyapi',
    accounts
  };
}
