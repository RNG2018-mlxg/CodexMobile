import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFeishuSkillInstruction } from './feishu-skills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const LARK_CLI = 'lark-cli';
const LARK_DOMAIN = 'https://open.feishu.cn';
const STATUS_CACHE_MS = 1500;
const REQUIRED_SKILLS = ['lark-doc', 'lark-drive', 'lark-markdown', 'lark-shared', 'lark-slides', 'lark-sheets'];
const AUTH_DOMAINS = ['docs', 'drive', 'markdown', 'slides', 'sheets'];

const REQUIRED_SCOPE_GROUPS = [
  {
    id: 'docs',
    label: '文档读写',
    scopes: ['docx:document:create', 'docx:document:write_only', 'docs:document.content:read']
  },
  {
    id: 'drive',
    label: '云空间文件',
    scopes: ['drive:file:upload', 'drive:file:download']
  },
  {
    id: 'slides',
    label: 'PPT 幻灯片',
    scopes: [
      'slides:presentation:create',
      'slides:presentation:write_only',
      'slides:presentation:read',
      'slides:presentation:update'
    ]
  },
  {
    id: 'sheets',
    label: '表格权限',
    scopes: [
      'sheets:spreadsheet:create',
      'sheets:spreadsheet:read',
      'sheets:spreadsheet:write_only',
      'sheets:spreadsheet.meta:read',
      'sheets:spreadsheet.meta:write_only'
    ]
  }
];

const CAPABILITIES = [
  { id: 'docs.create', label: '创建文档' },
  { id: 'docs.fetch', label: '读取内容' },
  { id: 'docs.update', label: '修改文档' },
  { id: 'docs.search', label: '搜索文档' },
  { id: 'docs.media', label: '插入媒体' },
  { id: 'drive.upload', label: '上传文件' },
  { id: 'drive.download', label: '下载文件' },
  { id: 'drive.folder', label: '创建文件夹' },
  { id: 'drive.move', label: '移动文件' },
  { id: 'drive.delete', label: '删除文件' },
  { id: 'slides.create', label: '创建 PPT' },
  { id: 'slides.fetch', label: '读取 PPT' },
  { id: 'slides.update', label: '修改 PPT' },
  { id: 'slides.delete', label: '删除幻灯片' },
  { id: 'sheets.create', label: '创建表格' },
  { id: 'sheets.read', label: '读取表格' },
  { id: 'sheets.write', label: '写入表格' },
  { id: 'sheets.append', label: '追加行' },
  { id: 'sheets.find', label: '查找替换' },
  { id: 'sheets.export', label: '导出表格' },
  { id: 'sheets.import', label: '导入 Excel/CSV' }
];

let statusCache = { at: 0, value: null };
let authRun = null;
let larkCliCommandPath = '';
let agentConfigPreparedAt = 0;

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function resolveLarkCliCommand() {
  if (larkCliCommandPath) {
    return larkCliCommandPath;
  }

  const candidates = [];
  if (process.env.LARK_CLI_PATH) {
    candidates.push(process.env.LARK_CLI_PATH);
  }
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'));
      candidates.push(path.join(process.env.APPDATA, 'npm', 'lark-cli.cmd'));
    }
    const pathValue = process.env.Path || process.env.PATH || '';
    for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, 'lark-cli.exe'));
      candidates.push(path.join(dir, 'lark-cli.cmd'));
    }
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      larkCliCommandPath = candidate;
      return candidate;
    }
  }

  larkCliCommandPath = LARK_CLI;
  return LARK_CLI;
}

function envValue(...keys) {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

export function larkCliEnvironment(baseEnv = process.env, options = {}) {
  const stripProxy = options.stripProxy !== false;
  const env = { ...baseEnv };
  const appId = String(env.LARK_APP_ID || env.CODEXMOBILE_FEISHU_APP_ID || '').trim();
  const appSecret = String(env.LARK_APP_SECRET || env.CODEXMOBILE_FEISHU_APP_SECRET || '').trim();

  if (appId) {
    env.LARK_APP_ID = appId;
  }
  if (appSecret) {
    env.LARK_APP_SECRET = appSecret;
  }
  env.LARK_DOMAIN = String(env.LARK_DOMAIN || LARK_DOMAIN).trim() || LARK_DOMAIN;
  env.LARK_CLI_NO_PROXY = '1';

  if (stripProxy) {
    env.NO_PROXY = '*';
    env.no_proxy = '*';

    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      delete env[key];
    }
  }

  return env;
}

async function ensureAgentLarkConfigDir() {
  const sourceRoot = path.join(os.homedir(), '.lark-cli');
  const sourceProfile = path.join(sourceRoot, 'openclaw');
  const targetRoot = path.join(ROOT_DIR, '.codexmobile', 'lark-cli-agent');
  const targetProfile = path.join(targetRoot, 'openclaw');
  const now = Date.now();

  if (now - agentConfigPreparedAt < 5000) {
    return targetRoot;
  }

  await fs.mkdir(targetProfile, { recursive: true });
  await fs.cp(sourceProfile, targetProfile, {
    recursive: true,
    force: true,
    filter: (source) => {
      const name = path.basename(source).toLowerCase();
      return !['locks', 'cache', 'logs'].includes(name);
    }
  });
  await Promise.all([
    fs.mkdir(path.join(targetProfile, 'locks'), { recursive: true }),
    fs.mkdir(path.join(targetProfile, 'cache'), { recursive: true }),
    fs.mkdir(path.join(targetProfile, 'logs'), { recursive: true })
  ]);
  agentConfigPreparedAt = now;
  return targetRoot;
}

async function ensureLarkCliGuardDir() {
  const guardDir = path.join(ROOT_DIR, '.codexmobile', 'lark-cli-guard');
  const guardScript = path.join(ROOT_DIR, 'scripts', 'lark-cli-guard.mjs');
  const cmdPath = path.join(guardDir, 'lark-cli.cmd');
  const nodePath = process.execPath;
  await fs.mkdir(guardDir, { recursive: true });
  await fs.writeFile(
    cmdPath,
    [
      '@echo off',
      `"${nodePath}" "${guardScript}" %*`
    ].join('\r\n'),
    'utf8'
  );
  return guardDir;
}

function prependPathEntry(env, dir) {
  const current = env.Path || env.PATH || '';
  const next = [dir, current].filter(Boolean).join(path.delimiter);
  env.Path = next;
  env.PATH = next;
}

function windowsCmdQuote(value) {
  return `"${String(value || '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

function larkCliSpawnOptions(command, args) {
  if (process.platform === 'win32' && /\.cmd$|\.bat$/i.test(command)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/c', ['call', windowsCmdQuote(command), ...args.map(windowsCmdQuote)].join(' ')],
      windowsVerbatimArguments: true
    };
  }
  return {
    command,
    args,
    windowsVerbatimArguments: false
  };
}

function redacted(value) {
  return String(value || '')
    .replace(/"appSecret"\s*:\s*"[^"]+"/gi, '"appSecret":"****"')
    .replace(/"access[_-]?token"\s*:\s*"[^"]+"/gi, '"accessToken":"****"')
    .replace(/"refresh[_-]?token"\s*:\s*"[^"]+"/gi, '"refreshToken":"****"')
    .replace(/\b(u|ur|t)-[A-Za-z0-9._-]{20,}\b/g, '$1-[hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]');
}

function parseJsonObject(text) {
  const value = String(text || '').trim();
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(value.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseScopes(value) {
  if (Array.isArray(value)) {
    return value.map((scope) => String(scope || '').trim()).filter(Boolean);
  }
  return String(value || '')
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function larkScopeStatus(grantedScopes = []) {
  const granted = new Set(grantedScopes);
  const groups = REQUIRED_SCOPE_GROUPS.map((group) => {
    const missing = group.scopes.filter((scope) => !granted.has(scope));
    return {
      id: group.id,
      label: group.label,
      ok: missing.length === 0,
      missing
    };
  });
  return {
    groups,
    missingScopes: groups.flatMap((group) => group.missing),
    slidesAuthorized: Boolean(groups.find((group) => group.id === 'slides')?.ok),
    sheetsAuthorized: Boolean(groups.find((group) => group.id === 'sheets')?.ok)
  };
}

function larkError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

async function runLarkCli(args, options = {}) {
  const {
    input = '',
    timeoutMs = 15000,
    cwd = process.cwd()
  } = options;
  const command = await resolveLarkCliCommand();
  const spawnOptions = larkCliSpawnOptions(command, args);

  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child = null;
    try {
      child = spawn(spawnOptions.command, spawnOptions.args, {
        cwd,
        env: larkCliEnvironment(),
        windowsHide: true,
        windowsVerbatimArguments: spawnOptions.windowsVerbatimArguments
      });
    } catch (error) {
      resolve({
        ok: false,
        code: null,
        signal: '',
        stdout: '',
        stderr: '',
        json: null,
        error: error.message
      });
      return;
    }

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({
        ok: false,
        code: null,
        signal: 'timeout',
        stdout: redacted(stdout),
        stderr: redacted(stderr),
        json: parseJsonObject(stdout),
        error: `lark-cli timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        code: null,
        signal: '',
        stdout: redacted(stdout),
        stderr: redacted(stderr),
        json: null,
        error: error.message
      });
    });
    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        code,
        signal,
        stdout: redacted(stdout),
        stderr: redacted(stderr),
        json: parseJsonObject(stdout),
        error: code === 0 ? '' : redacted(stderr || stdout || `lark-cli exited with code ${code}`)
      });
    });

    if (input && child.stdin) {
      child.stdin.write(input);
    }
    child.stdin?.end();
  });
}

async function larkCliVersion() {
  const result = await runLarkCli(['--version'], { timeoutMs: 8000 });
  if (!result.ok) {
    return { installed: false, version: '', error: result.error || result.stderr };
  }
  const match = result.stdout.match(/(\d+\.\d+\.\d+)/);
  return { installed: true, version: match?.[1] || result.stdout.trim(), error: '' };
}

async function larkSkillsInstalled() {
  const root = path.join(os.homedir(), '.agents', 'skills');
  const missing = [];
  for (const skill of REQUIRED_SKILLS) {
    try {
      await fs.access(path.join(root, skill, 'SKILL.md'));
    } catch {
      missing.push(skill);
    }
  }
  return {
    installed: missing.length === 0,
    missing,
    root
  };
}

async function larkConfigStatus() {
  const appId = envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID');
  const appSecret = envValue('LARK_APP_SECRET', 'CODEXMOBILE_FEISHU_APP_SECRET');
  const show = await runLarkCli(['config', 'show'], { timeoutMs: 10000 });
  const config = show.json || {};
  return {
    configured: show.ok || Boolean(appId && appSecret),
    configReady: show.ok,
    appId: config.appId || appId || '',
    brand: config.brand || 'feishu',
    defaultAs: config.defaultAs || '',
    workspace: config.workspace || '',
    hasEnvCredentials: Boolean(appId && appSecret),
    error: show.ok ? '' : show.error || show.stderr || show.stdout
  };
}

function authUserFromStatus(data) {
  const candidate = data?.user || data?.currentUser || data?.current_user || data || {};
  const name =
    candidate.name ||
    candidate.userName ||
    candidate.user_name ||
    candidate.enName ||
    candidate.en_name ||
    candidate.email ||
    candidate.openId ||
    candidate.open_id ||
    candidate.userOpenId ||
    '';
  return name
    ? {
        name,
        email: candidate.email || candidate.enterpriseEmail || candidate.enterprise_email || '',
        openId: candidate.openId || candidate.open_id || candidate.userOpenId || candidate.user_open_id || ''
      }
    : null;
}

async function larkAuthStatusRaw() {
  const result = await runLarkCli(['auth', 'status'], { timeoutMs: 10000 });
  const data = result.json || {};
  const text = `${result.stdout}\n${result.stderr}\n${result.error || ''}`;
  const noUser = /no user logged in|only bot/i.test(text);
  const connected = Boolean(result.ok && !noUser && (data.identity === 'user' || data.user || data.currentUser || data.openId || data.open_id));
  return {
    connected,
    identity: data.identity || '',
    defaultAs: data.defaultAs || '',
    user: connected ? authUserFromStatus(data) || { name: '已授权用户', email: '', openId: '' } : null,
    scopes: parseScopes(data.scope || data.scopes),
    tokenStatus: data.tokenStatus || data.token_status || '',
    expiresAt: data.expiresAt || data.expires_at || '',
    refreshExpiresAt: data.refreshExpiresAt || data.refresh_expires_at || '',
    error: result.ok ? '' : result.error || result.stderr || result.stdout,
    note: data.note || ''
  };
}

async function larkAuthStatus() {
  const auth = await larkAuthStatusRaw();
  const tokenStatus = String(auth.tokenStatus || '');
  if (!auth.connected || !/needs_refresh|expired/i.test(tokenStatus)) {
    return auth;
  }

  const verifiedResult = await runLarkCli(['auth', 'status', '--verify'], { timeoutMs: 15000 });
  const verifiedData = verifiedResult.json || {};
  const verified = verifiedData.verified;
  const verifyError = verifiedData.verifyError || verifiedData.verify_error || verifiedResult.error || verifiedResult.stderr || '';
  const requiresReauth =
    verified === false &&
    /need_user_authorization|invalid_grant|token unusable|20064/i.test(String(verifyError || ''));

  return {
    ...auth,
    connected: requiresReauth ? false : auth.connected,
    user: requiresReauth ? null : auth.user,
    verified,
    verifyError,
    error: requiresReauth ? verifyError || 'Feishu authorization expired' : auth.error
  };
}

function publicPendingAuth() {
  if (!authRun) {
    return null;
  }
  return {
    verificationUrl: authRun.verificationUrl,
    userCode: authRun.userCode,
    expiresAt: authRun.expiresAt,
    status: authRun.status,
    error: authRun.error || ''
  };
}

export async function getLarkDocsStatus(options = {}) {
  const { authenticated = true, force = false } = options;
  const now = Date.now();
  if (!force && statusCache.value && now - statusCache.at <= STATUS_CACHE_MS) {
    return authenticated ? statusCache.value : { ...statusCache.value, connected: false, user: null, authPending: null };
  }

  const cli = await larkCliVersion();
  const skills = await larkSkillsInstalled();
  const config = cli.installed
    ? await larkConfigStatus()
    : {
        configured: Boolean(envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID') && envValue('LARK_APP_SECRET', 'CODEXMOBILE_FEISHU_APP_SECRET')),
        configReady: false,
        appId: envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID'),
        brand: 'feishu',
        defaultAs: '',
        workspace: '',
        hasEnvCredentials: Boolean(envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID') && envValue('LARK_APP_SECRET', 'CODEXMOBILE_FEISHU_APP_SECRET')),
        error: cli.error
      };
  const auth = authenticated && cli.installed && config.configured
    ? await larkAuthStatus()
    : { connected: false, user: null, identity: '', defaultAs: '', note: '', error: '', scopes: [] };
  const enabled = Boolean(cli.installed && skills.installed && config.configured && auth.connected);
  const scopeStatus = enabled
    ? larkScopeStatus(auth.scopes)
    : { groups: [], missingScopes: [], slidesAuthorized: false, sheetsAuthorized: false };
  const authorizationReady = enabled && scopeStatus.missingScopes.length === 0;
  const capabilities = enabled
    ? CAPABILITIES.filter((capability) => {
        if (capability.id.startsWith('slides.')) {
          return scopeStatus.slidesAuthorized;
        }
        if (capability.id.startsWith('sheets.')) {
          return scopeStatus.sheetsAuthorized;
        }
        return true;
      })
    : [];

  const status = {
    provider: 'feishu',
    integration: 'lark-cli',
    label: '飞书文档',
    configured: config.configured,
    configReady: config.configReady,
    connected: authenticated ? auth.connected : false,
    user: authenticated ? auth.user : null,
    cliInstalled: cli.installed,
    cliVersion: cli.version,
    skillsInstalled: skills.installed,
    missingSkills: skills.missing,
    identity: auth.identity || config.defaultAs || '',
    defaultAs: auth.defaultAs || config.defaultAs || '',
    workspace: config.workspace,
    homeUrl: process.env.CODEXMOBILE_FEISHU_DOCS_URL || 'https://docs.feishu.cn/',
    capabilities,
    codexEnabled: enabled,
    authorizationReady,
    scopeGroups: authenticated ? scopeStatus.groups : [],
    missingScopes: authenticated ? scopeStatus.missingScopes : [],
    slidesAuthorized: authenticated ? scopeStatus.slidesAuthorized : false,
    sheetsAuthorized: authenticated ? scopeStatus.sheetsAuthorized : false,
    tokenStatus: authenticated ? auth.tokenStatus : '',
    expiresAt: authenticated ? auth.expiresAt : '',
    authPending: authenticated ? publicPendingAuth() : null,
    error: cli.error || config.error || auth.error || ''
  };

  if (authenticated) {
    statusCache = { at: now, value: status };
  }
  return authenticated ? status : { ...status, connected: false, user: null, authPending: null };
}

async function ensureLarkConfigured() {
  const config = await larkConfigStatus();
  if (config.configReady) {
    return;
  }
  const appId = envValue('LARK_APP_ID', 'CODEXMOBILE_FEISHU_APP_ID');
  const appSecret = envValue('LARK_APP_SECRET', 'CODEXMOBILE_FEISHU_APP_SECRET');
  if (!appId || !appSecret) {
    throw larkError('缺少飞书 App ID 或 App Secret，请先配置 CODEXMOBILE_FEISHU_APP_ID / CODEXMOBILE_FEISHU_APP_SECRET。', {
      statusCode: 400
    });
  }

  const init = await runLarkCli(
    ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'],
    { input: `${appSecret}\n`, timeoutMs: 30000 }
  );
  if (!init.ok) {
    throw larkError(init.error || 'lark-cli 配置失败', { statusCode: 502 });
  }
}

async function setDefaultAsUser() {
  const result = await runLarkCli(['config', 'default-as', 'user'], { timeoutMs: 10000 });
  if (!result.ok) {
    console.warn('[lark-cli] failed to set default identity:', result.error || result.stderr || result.stdout);
  }
}

function extractUserCode(verificationUrl) {
  try {
    return new URL(verificationUrl).searchParams.get('user_code') || '';
  } catch {
    return '';
  }
}

async function startDevicePoll(deviceCode) {
  let child = null;
  try {
    const command = await resolveLarkCliCommand();
    const spawnOptions = larkCliSpawnOptions(command, ['auth', 'login', '--device-code', deviceCode]);
    child = spawn(spawnOptions.command, spawnOptions.args, {
      env: larkCliEnvironment(),
      windowsHide: true,
      windowsVerbatimArguments: spawnOptions.windowsVerbatimArguments
    });
  } catch (error) {
    authRun.status = 'failed';
    authRun.error = redacted(error.message);
    return;
  }
  authRun.process = child;
  authRun.status = 'polling';

  let stdout = '';
  let stderr = '';
  const finish = async (status, error = '') => {
    if (!authRun) {
      return;
    }
    authRun.status = status;
    authRun.error = error;
    authRun.process = null;
    statusCache = { at: 0, value: null };
    if (status === 'connected') {
      await setDefaultAsUser();
    }
  };

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    finish('failed', redacted(error.message));
  });
  child.on('close', (code) => {
    if (code === 0) {
      finish('connected');
      return;
    }
    finish('failed', redacted(stderr || stdout || `lark-cli auth login exited with code ${code}`));
  });
}

export async function startLarkCliAuth() {
  const cli = await larkCliVersion();
  if (!cli.installed) {
    throw larkError('未安装 lark-cli，请先安装 @larksuite/cli。', { statusCode: 400 });
  }

  await ensureLarkConfigured();
  await setDefaultAsUser();

  if (authRun?.status === 'polling' && Date.now() < authRun.expiresAt) {
    return {
      verificationUrl: authRun.verificationUrl,
      userCode: authRun.userCode,
      expiresAt: authRun.expiresAt,
      status: authRun.status
    };
  }

  const args = ['auth', 'login', '--recommend', '--no-wait', '--json'];
  for (const domain of AUTH_DOMAINS) {
    args.push('--domain', domain);
  }
  const result = await runLarkCli(args, { timeoutMs: 30000 });
  if (!result.ok || !result.json?.device_code || !result.json?.verification_url) {
    throw larkError(result.error || '获取飞书授权地址失败', { statusCode: 502 });
  }

  authRun = {
    deviceCode: result.json.device_code,
    verificationUrl: result.json.verification_url,
    userCode: extractUserCode(result.json.verification_url),
    expiresAt: Date.now() + Math.max(0, Number(result.json.expires_in || 600)) * 1000,
    status: 'pending',
    error: '',
    process: null
  };
  await startDevicePoll(authRun.deviceCode);
  statusCache = { at: 0, value: null };

  return {
    verificationUrl: authRun.verificationUrl,
    userCode: authRun.userCode,
    expiresAt: authRun.expiresAt,
    status: authRun.status
  };
}

export async function logoutLarkCli() {
  if (authRun?.process) {
    authRun.process.kill();
  }
  authRun = null;
  const result = await runLarkCli(['auth', 'logout'], { timeoutMs: 15000 });
  statusCache = { at: 0, value: null };
  if (!result.ok && !/no logged-in users/i.test(result.stdout || result.stderr || result.error || '')) {
    throw larkError(result.error || '断开飞书授权失败', { statusCode: 502 });
  }
  return true;
}

export async function buildCodexLarkCliContext(message = '') {
  const status = await getLarkDocsStatus({ authenticated: true, force: false }).catch(() => null);
  const enabled = Boolean(status?.codexEnabled);
  const requestedInstruction = await buildFeishuSkillInstruction(message);
  const instruction = enabled
    ? requestedInstruction
    : requestedInstruction
      ? [
          'CodexMobile Feishu/Lark was requested, but the integration is not currently authorized.',
          'Do not run lark-cli commands. Reply in concise Chinese that Feishu authorization has expired or is unavailable, and ask the user to open the top-right Docs panel and reconnect Feishu.'
        ].join('\n')
      : '';
  const env = larkCliEnvironment(process.env, { stripProxy: false });
  if (enabled) {
    const configRoot = await ensureAgentLarkConfigDir();
    const realCli = await resolveLarkCliCommand();
    env.LARKSUITE_CLI_CONFIG_DIR = configRoot;
    env.LARKSUITE_CLI_LOG_DIR = path.join(configRoot, 'openclaw', 'logs');
    env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
    if (realCli && realCli !== LARK_CLI) {
      const guardDir = await ensureLarkCliGuardDir();
      env.CODEXMOBILE_REAL_LARK_CLI = realCli;
      env.CODEXMOBILE_LARK_GUARD_STATE_DIR = path.join(ROOT_DIR, '.codexmobile', 'state');
      prependPathEntry(env, guardDir);
    }
  }
  return {
    enabled,
    env,
    instruction
  };
}
