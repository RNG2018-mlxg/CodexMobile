import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { buildCodexLarkCliContext } from './lark-cli.js';
import { detectFeishuSkillKeys } from './feishu-skills.js';

const activeRuns = new Map();
const NON_ASCII_PATH_PATTERN = /[^\u0000-\u007F]/;
const MACOS_CODEX_APP_CLI = '/Applications/Codex.app/Contents/Resources/codex';
const DEFAULT_LOCAL_PROXY_URL = 'http://127.0.0.1:7890';
const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'];
const CODEXMOBILE_REPLY_INSTRUCTION = [
  'CodexMobile iOS/PWA 回复要求：最终回复必须简短、直接。',
  '除非用户明确要求，最终只写结果、关键链接、必要下一步；不要复述内部过程、命令日志或长篇验证细节。'
].join('\n');
let defaultProxyProbe = { checkedAt: 0, reachable: false };
let loggedCodexEnvSignature = '';

async function ensureAsciiWorkingDirectory(projectPath) {
  if (process.platform !== 'win32' || !NON_ASCII_PATH_PATTERN.test(projectPath)) {
    return projectPath;
  }

  const resolved = path.resolve(projectPath);
  const driveRoot = path.parse(resolved).root || 'C:\\';
  const aliasRoot = path.join(driveRoot, 'codex_project_aliases');
  const aliasName = crypto.createHash('sha1').update(resolved.toLowerCase()).digest('hex');
  const aliasPath = path.join(aliasRoot, aliasName);

  await fs.mkdir(aliasRoot, { recursive: true });
  try {
    const stats = await fs.lstat(aliasPath);
    if (stats.isDirectory() || stats.isSymbolicLink()) {
      return aliasPath;
    }
    await fs.rm(aliasPath, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.symlink(resolved, aliasPath, 'junction');
  return aliasPath;
}

function mapPermissionMode(permissionMode) {
  if (permissionMode === 'bypassPermissions') {
    return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' };
  }
  if (permissionMode === 'acceptEdits') {
    return { sandboxMode: 'workspace-write', approvalPolicy: 'never' };
  }
  return { sandboxMode: 'workspace-write', approvalPolicy: 'never' };
}

function normalizeReasoningEffort(reasoningEffort) {
  const value = String(reasoningEffort || '').trim();
  return ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(value) ? value : undefined;
}

function textFromContent(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part?.type === 'output_text' || part?.type === 'input_text' || part?.type === 'text') {
        return part.text || '';
      }
      return part?.text || '';
    })
    .filter(Boolean)
    .join('\n');
}

function contentFromItem(item) {
  if (!item) {
    return '';
  }
  const contentText = textFromContent(item.content);
  if (contentText) {
    return contentText;
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  if (typeof item.aggregated_output === 'string') {
    return item.aggregated_output;
  }
  if (typeof item.message === 'string') {
    return item.message;
  }
  return '';
}

function statusLabel(kind, status = 'running') {
  const done = status === 'completed';
  const failed = status === 'failed';
  const labels = {
    turn: done ? '任务已完成' : failed ? '任务失败' : '正在处理',
    reasoning: done ? '思考完成' : '正在思考',
    agent_message: '正在回复',
    message: '正在回复',
    command_execution: done ? '命令已完成' : failed ? '命令失败' : '正在执行命令',
    file_change: done ? '文件已修改' : failed ? '文件修改失败' : '正在修改文件',
    mcp_tool_call: done ? '工具调用完成' : failed ? '工具调用失败' : '正在调用工具',
    web_search: done ? '搜索完成' : failed ? '搜索失败' : '正在搜索',
    todo_list: done ? '计划已更新' : '正在规划',
    image_generation_call: done ? '图片生成完成' : failed ? '图片生成失败' : '正在生成图片',
    custom_tool_call: done ? '工具调用完成' : failed ? '工具调用失败' : '正在调用工具',
    function_call: done ? '工具调用完成' : failed ? '工具调用失败' : '正在调用工具',
    error: '出现错误'
  };
  return labels[kind] || (done ? '已完成' : failed ? '失败' : '正在处理');
}

function compactStatusLabel(content, fallback = '正在处理') {
  const label = String(content || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!label) {
    return fallback;
  }
  return label.length > 68 ? `${label.slice(0, 68)}...` : label;
}

function detailFromItem(item) {
  if (!item) {
    return '';
  }
  if (item.command) {
    return item.command;
  }
  if (item.query) {
    return item.query;
  }
  if (item.tool || item.server) {
    return [item.server, item.tool].filter(Boolean).join(' / ');
  }
  if (Array.isArray(item.changes)) {
    return item.changes.map((change) => `${change.kind || 'update'} ${change.path}`).join('\n');
  }
  if (item.message) {
    return item.message;
  }
  return contentFromItem(item);
}

function eventItem(event) {
  if (event.item) {
    return event.item;
  }
  if (event.payload && (event.type === 'response_item' || event.type === 'event_msg')) {
    return event.payload;
  }
  return null;
}

function eventStatus(event, item) {
  if (item?.status) {
    if (item.status === 'in_progress') {
      return 'running';
    }
    return item.status;
  }
  if (event.type === 'item.completed') {
    return 'completed';
  }
  if (event.type === 'item.started' || event.type === 'item.updated') {
    return 'running';
  }
  if (event.type === 'event_msg' && item?.type?.endsWith('_end')) {
    return item.exit_code || item.exit_code === 0 ? (item.exit_code === 0 ? 'completed' : 'failed') : 'completed';
  }
  if (event.type === 'response_item') {
    return 'completed';
  }
  return 'running';
}

function emitStatus(emit, { sessionId, turnId, kind, status = 'running', label, detail = '' }) {
  emit({
    type: 'status-update',
    sessionId,
    turnId,
    kind,
    status,
    label: label || statusLabel(kind, status),
    detail,
    timestamp: new Date().toISOString()
  });
}

function isSpawnPermissionError(error) {
  return error?.code === 'EPERM' && String(error?.syscall || '').startsWith('spawn');
}

function userFacingCodexError(error) {
  const message = String(error?.message || 'Codex task failed');
  if (process.platform === 'win32' && isSpawnPermissionError(error)) {
    return [
      'Codex 执行器启动被 Windows 拒绝（spawn EPERM）。',
      '通常是后台服务从受限环境启动导致的，请重启正式服务后再试。'
    ].join(' ');
  }
  return message;
}

function codexErrorDiagnostics(error) {
  return {
    message: error?.message || '',
    code: error?.code || '',
    errno: error?.errno || '',
    syscall: error?.syscall || '',
    path: error?.path || '',
    spawnargs: Array.isArray(error?.spawnargs) ? error.spawnargs : [],
    cwd: process.cwd(),
    execPath: process.execPath,
    pathLength: String(process.env.Path || process.env.PATH || '').length
  };
}

function truthyEnv(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function disabledProxyValue(value) {
  return /^(0|false|no|off|none|direct|disabled)$/i.test(String(value || '').trim());
}

function firstProxyValue(env) {
  for (const key of PROXY_ENV_KEYS) {
    const value = String(env[key] || '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function mergeNoProxy(env) {
  const additions = ['localhost', '127.0.0.1', '::1'];
  for (const key of NO_PROXY_ENV_KEYS) {
    const current = String(env[key] || '').trim();
    if (current === '*') {
      env[key] = additions.join(',');
      continue;
    }
    const values = new Set(
      current
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    );
    for (const item of additions) {
      values.add(item);
    }
    env[key] = [...values].join(',');
  }
  if (!env.NO_PROXY && !env.no_proxy) {
    env.NO_PROXY = additions.join(',');
    env.no_proxy = env.NO_PROXY;
  }
}

async function canConnectToProxy(proxyUrl) {
  let parsed;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    return false;
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  const host = parsed.hostname || '127.0.0.1';
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(250);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function defaultLocalProxyReachable() {
  const now = Date.now();
  if (now - defaultProxyProbe.checkedAt < 10000) {
    return defaultProxyProbe.reachable;
  }
  const reachable = await canConnectToProxy(DEFAULT_LOCAL_PROXY_URL);
  defaultProxyProbe = { checkedAt: now, reachable };
  return reachable;
}

async function resolveCodexProxyUrl(env) {
  if (truthyEnv(env.CODEXMOBILE_CODEX_PROXY_DISABLED)) {
    return '';
  }
  const explicit = String(env.CODEXMOBILE_CODEX_PROXY || env.CODEXMOBILE_PROXY_URL || env.CODEXMOBILE_CLASH_PROXY_URL || '').trim();
  if (explicit) {
    return disabledProxyValue(explicit) ? '' : explicit;
  }
  if (firstProxyValue(env)) {
    return '';
  }
  return await defaultLocalProxyReachable() ? DEFAULT_LOCAL_PROXY_URL : '';
}

function applyProxyEnv(env, proxyUrl) {
  if (!proxyUrl) {
    mergeNoProxy(env);
    return;
  }
  for (const key of PROXY_ENV_KEYS) {
    if (!env[key]) {
      env[key] = proxyUrl;
    }
  }
  mergeNoProxy(env);
}

async function buildCodexChildEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  const proxyUrl = await resolveCodexProxyUrl(env);
  applyProxyEnv(env, proxyUrl);
  return env;
}

async function resolveCodexPathOverride() {
  const explicitPath = String(process.env.CODEXMOBILE_CODEX_PATH || '').trim();
  if (explicitPath) {
    return explicitPath;
  }
  if (process.platform !== 'darwin') {
    return undefined;
  }
  try {
    await fs.access(MACOS_CODEX_APP_CLI);
    return MACOS_CODEX_APP_CLI;
  } catch {
    return undefined;
  }
}

function logCodexChildRuntime(env, codexPathOverride) {
  const proxy = firstProxyValue(env) || 'direct';
  const noProxy = env.NO_PROXY || env.no_proxy || '';
  const codexPath = codexPathOverride || 'sdk-bundled';
  const signature = `${codexPath}|${proxy}|${noProxy}`;
  if (signature === loggedCodexEnvSignature) {
    return;
  }
  loggedCodexEnvSignature = signature;
  console.log(`[codex] child runtime codex=${codexPath} proxy=${proxy} no_proxy=${noProxy || '(empty)'}`);
}

function emitActivity(emit, { sessionId, turnId, messageId, item, kind, status }) {
  const detail = detailFromItem(item);
  emit({
    type: 'activity-update',
    sessionId,
    turnId,
    messageId,
    kind,
    label: statusLabel(kind, status),
    status,
    detail,
    command: item?.command || '',
    output: item?.aggregated_output || item?.output || '',
    fileChanges: Array.isArray(item?.changes) ? item.changes : [],
    toolName: item?.tool || item?.name || '',
    error: item?.error?.message || item?.message || '',
    timestamp: new Date().toISOString()
  });
}

function emitCodexEvent(event, sessionId, turnId, emit, state) {
  const threadId = event.thread_id || event.id || event.payload?.id;
  if (event.type === 'thread.started' && threadId) {
    emit({ type: 'thread-started', sessionId: threadId, turnId });
    return;
  }

  if (event.type === 'turn.started' || event.payload?.type === 'task_started') {
    emitStatus(emit, { sessionId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });
    return;
  }

  if (event.type === 'turn.completed') {
    state.usage = event.usage || null;
    emitStatus(emit, { sessionId, turnId, kind: 'turn', status: 'completed', label: '任务已完成' });
    emit({ type: 'turn-complete', sessionId, turnId, usage: event.usage || null });
    return;
  }

  if (event.type === 'turn.failed') {
    const error = event.error?.message || event.error || 'Codex turn failed';
    state.failed = true;
    emitStatus(emit, { sessionId, turnId, kind: 'turn', status: 'failed', label: '任务失败', detail: error });
    emit({ type: 'turn-failed', sessionId, turnId, error });
    emit({ type: 'chat-error', sessionId, turnId, error });
    console.error('[codex] Turn failed:', error);
    return;
  }

  if (event.type === 'error') {
    const error = event.message || 'Codex stream error';
    state.failed = true;
    emitStatus(emit, { sessionId, turnId, kind: 'error', status: 'failed', detail: error });
    emit({ type: 'chat-error', sessionId, turnId, error });
    console.error('[codex] Stream error:', error);
    return;
  }

  const item = eventItem(event);
  if (!item) {
    return;
  }
  const done = event.type === 'item.completed';
  const kind = item.type || 'item';
  const status = eventStatus(event, item);
  const messageId = item.id || `${turnId}-${kind}`;

  if (kind === 'agent_message' || item.phase === 'commentary') {
    const content = contentFromItem(item);
    if (content.trim()) {
      emitStatus(emit, {
        sessionId,
        turnId,
        kind: kind === 'message' ? 'agent_message' : kind,
        status: 'running',
        label: compactStatusLabel(content)
      });
    }
    return;
  }

  if (kind === 'message' && item.role === 'assistant') {
    const content = contentFromItem(item);
    if (content.trim()) {
      state.hadAssistantText = true;
      emitStatus(emit, { sessionId, turnId, kind, status: 'running', label: '正在回复' });
      emit({
        type: 'assistant-update',
        sessionId,
        turnId,
        messageId,
        role: 'assistant',
        kind,
        phase: item.phase || 'final_answer',
        content,
        done: done || status === 'completed'
      });
    }
    return;
  }

  if (kind === 'reasoning') {
    emitStatus(emit, {
      sessionId,
      turnId,
      kind,
      status,
      label: statusLabel(kind, status)
    });
    return;
  }

  if (kind === 'error') {
    const error = item.message || 'Codex item error';
    emitStatus(emit, { sessionId, turnId, kind, status: 'failed', detail: error });
    emit({
      type: 'chat-error',
      sessionId,
      turnId,
      error
    });
    console.error('[codex] Item error:', error);
    return;
  }

  if (
    kind === 'command_execution' ||
    kind === 'file_change' ||
    kind === 'mcp_tool_call' ||
    kind === 'web_search' ||
    kind === 'todo_list' ||
    kind === 'image_generation_call' ||
    kind === 'custom_tool_call' ||
    kind === 'function_call' ||
    kind === 'function_call_output' ||
    kind === 'exec_command_begin' ||
    kind === 'exec_command_end'
  ) {
    const normalizedKind =
      kind === 'exec_command_begin' || kind === 'exec_command_end' ? 'command_execution' : kind;
    const normalizedStatus = kind === 'function_call_output' ? 'completed' : status;
    emitStatus(emit, {
      sessionId,
      turnId,
      kind: normalizedKind,
      status: normalizedStatus,
      detail: detailFromItem(item)
    });
    emitActivity(emit, {
      sessionId,
      turnId,
      messageId,
      item,
      kind: normalizedKind,
      status: normalizedStatus
    });
    return;
  }

  const detail = detailFromItem(item);
  if (detail) {
    emitStatus(emit, { sessionId, turnId, kind, status, detail });
  }
}

export async function runCodexTurn({ sessionId, draftSessionId, projectPath, message, model, reasoningEffort, permissionMode, turnId: providedTurnId }, emit) {
  const { Codex } = await import('@openai/codex-sdk');
  const workingDirectory = await ensureAsciiWorkingDirectory(projectPath);
  const { sandboxMode, approvalPolicy } = mapPermissionMode(permissionMode);
  const feishuSkillKeys = detectFeishuSkillKeys(message);
  const normalizedReasoningEffort = normalizeReasoningEffort(reasoningEffort);
  const modelReasoningEffort =
    feishuSkillKeys.length && normalizedReasoningEffort === 'xhigh' ? 'low' : normalizedReasoningEffort;
  const larkCliContext = await buildCodexLarkCliContext(message).catch((error) => {
    console.warn('[lark-cli] Codex context disabled:', error.message);
    return { enabled: false, env: { ...process.env }, instruction: '' };
  });
  const abortController = new AbortController();
  const turnId = providedTurnId || crypto.randomUUID();
  const state = { hadAssistantText: false, failed: false, usage: null };
  const run = {
    thread: null,
    abortController,
    turnId,
    sessionId: sessionId || draftSessionId || null,
    previousSessionId: draftSessionId || sessionId || null,
    startedAt: new Date().toISOString(),
    status: 'running'
  };

  let currentSessionId = sessionId || null;
  let previousSessionId = draftSessionId || sessionId || null;
  let thread = null;
  let completed = false;

  try {
    if (larkCliContext.enabled && larkCliContext.env) {
      larkCliContext.env.CODEXMOBILE_TURN_ID = turnId;
      larkCliContext.env.CODEXMOBILE_SESSION_ID = sessionId || draftSessionId || '';
    }
    const codexEnv = await buildCodexChildEnv(larkCliContext.env || process.env);
    const codexPathOverride = await resolveCodexPathOverride();
    logCodexChildRuntime(codexEnv, codexPathOverride);
    const codex = new Codex({
      codexPathOverride,
      env: codexEnv
    });
    const threadOptions = {
      workingDirectory,
      skipGitRepoCheck: true,
      sandboxMode,
      approvalPolicy,
      model,
      modelReasoningEffort,
      ...(larkCliContext.enabled ? { networkAccessEnabled: true } : {})
    };

    thread = sessionId ? codex.resumeThread(sessionId, threadOptions) : codex.startThread(threadOptions);
    currentSessionId = thread.id || sessionId || `codex-${Date.now()}`;
    run.thread = thread;
    run.sessionId = currentSessionId;
    activeRuns.set(turnId, run);

    emit({
      type: 'chat-started',
      sessionId: currentSessionId,
      previousSessionId,
      turnId,
      projectPath,
      startedAt: new Date().toISOString()
    });
    emitStatus(emit, { sessionId: currentSessionId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });

    const codexInput = [message, CODEXMOBILE_REPLY_INSTRUCTION, larkCliContext.enabled ? larkCliContext.instruction : '']
      .filter(Boolean)
      .join('\n\n');
    const streamedTurn = await thread.runStreamed(codexInput, { signal: abortController.signal });
    for await (const event of streamedTurn.events) {
      const threadId = event.thread_id || event.id || event.payload?.id;
      if (event.type === 'thread.started' && threadId) {
        const fromSessionId = previousSessionId || currentSessionId;
        if (threadId !== currentSessionId) {
          currentSessionId = threadId;
          run.sessionId = threadId;
        }
        previousSessionId = fromSessionId;
        run.previousSessionId = fromSessionId;
        emit({
          type: 'thread-started',
          sessionId: threadId,
          previousSessionId: fromSessionId,
          turnId,
          projectPath,
          startedAt: new Date().toISOString()
        });
        emitStatus(emit, { sessionId: threadId, turnId, kind: 'reasoning', status: 'running', label: '正在思考' });
        continue;
      }
      if (run.status === 'aborted') {
        break;
      }
      emitCodexEvent(event, currentSessionId, turnId, emit, state);
    }

    if (!state.failed) {
      completed = true;
      emit({
        type: 'chat-complete',
        sessionId: currentSessionId,
        previousSessionId,
        turnId,
        usage: state.usage,
        hadAssistantText: state.hadAssistantText,
        completedAt: new Date().toISOString()
      });
    }
  } catch (error) {
    const wasAborted =
      error?.name === 'AbortError' ||
      String(error?.message || '').toLowerCase().includes('aborted') ||
      activeRuns.get(turnId)?.status === 'aborted';
    const userError = userFacingCodexError(error);

    emit({
      type: wasAborted ? 'chat-aborted' : 'chat-error',
      sessionId: currentSessionId,
      turnId,
      error: wasAborted ? null : userError
    });
    if (!wasAborted) {
      console.error('[codex] Chat error:', codexErrorDiagnostics(error));
      emitStatus(emit, {
        sessionId: currentSessionId,
        turnId,
        kind: 'turn',
        status: 'failed',
        label: '任务失败',
        detail: userError
      });
    }
  } finally {
    if (activeRuns.has(turnId)) {
      const activeRun = activeRuns.get(turnId);
      activeRun.status = activeRun.status === 'aborted' ? 'aborted' : 'completed';
      activeRuns.delete(turnId);
    }
  }

  return completed ? currentSessionId : null;
}

function runMatchesIdentifier(run, identifier) {
  return (
    Boolean(identifier) &&
    (run.turnId === identifier || run.sessionId === identifier || run.previousSessionId === identifier)
  );
}

export function abortCodexTurn(identifier) {
  const id = String(identifier || '').trim();
  const runs = [...activeRuns.values()].filter(
    (run) => run.status === 'running' && runMatchesIdentifier(run, id)
  );
  if (!runs.length) {
    return false;
  }
  for (const run of runs) {
    run.status = 'aborted';
    run.abortController.abort();
  }
  return true;
}

export function getActiveRuns() {
  return [...activeRuns.values()]
    .filter((run) => run.status === 'running')
    .map((run) => ({
      sessionId: run.sessionId,
      previousSessionId: run.previousSessionId,
      startedAt: run.startedAt,
      status: run.status,
      turnId: run.turnId
    }));
}
