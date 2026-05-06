import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  Headphones,
  Image,
  Loader2,
  Menu,
  Mic,
  MessageSquarePlus,
  Monitor,
  Paperclip,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  ShieldCheck,
  Square,
  Trash2,
  Volume2,
  Wifi,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiBlobFetch, apiFetch, clearToken, getToken, realtimeVoiceWebsocketUrl, setToken, websocketUrl } from './api.js';

const DEFAULT_STATUS = {
  connected: false,
  provider: 'cliproxyapi',
  model: 'gpt-5.5',
  modelShort: '5.5 中',
  reasoningEffort: 'xhigh',
  models: [{ value: 'gpt-5.5', label: 'gpt-5.5' }],
  docs: {
    provider: 'feishu',
    integration: 'lark-cli',
    label: '飞书文档',
    configured: false,
    connected: false,
    user: null,
    homeUrl: 'https://docs.feishu.cn/',
    cliInstalled: false,
    skillsInstalled: false,
    capabilities: [],
    codexEnabled: false,
    authorizationReady: false,
    missingScopes: [],
    scopeGroups: [],
    slidesAuthorized: false,
    sheetsAuthorized: false,
    authPending: null
  },
  voiceRealtime: { configured: false, model: 'qwen3.5-omni-plus-realtime', provider: '阿里百炼' },
  auth: { authenticated: false }
};

const CONNECTION_STATUS = {
  connected: { label: '已连接', className: 'is-connected' },
  connecting: { label: '连接中', className: 'is-connecting' },
  disconnected: { label: '已断开', className: 'is-disconnected' }
};

const DEFAULT_REASONING_EFFORT = 'xhigh';
const REASONING_DEFAULT_VERSION = 'xhigh-v1';
const THEME_KEY = 'codexmobile.theme';
const VOICE_MAX_RECORDING_MS = 90 * 1000;
const VOICE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const VOICE_MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
const VOICE_DIALOG_SILENCE_MS = 900;
const VOICE_DIALOG_MIN_RECORDING_MS = 600;
const VOICE_DIALOG_LEVEL_THRESHOLD = 0.018;
const VOICE_DIALOG_SILENCE_AUDIO =
  'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQIAAAAAAA==';
const REALTIME_VOICE_SAMPLE_RATE = 24000;
const REALTIME_VOICE_BUFFER_SIZE = 2048;
const REALTIME_VOICE_MIN_TURN_MS = 500;
const REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD = 0.026;
const REALTIME_VOICE_BARGE_IN_SUSTAIN_MS = 180;

function realtimePayloadErrorMessage(payload) {
  return String(payload?.error?.message || payload?.error || payload?.message || '');
}

function isBenignRealtimeCancelError(payload) {
  return /Conversation has none active response/i.test(realtimePayloadErrorMessage(payload));
}

function normalizeVoiceCommandText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s，。！？、,.!?;；:："'“”‘’（）()【】\[\]<>《》]/g, '');
}

function isVoiceHandoffCommand(value) {
  const text = normalizeVoiceCommandText(value);
  if (!text) {
    return false;
  }
  const wantsSummary = /总结|整理|归纳|汇总|梳理|提炼|概括|组织|形成任务|变成任务|整理成任务/.test(text);
  const wantsHandoff = /交给|发给|发送给|提交给|提交|让|叫|拿给|丢给|转给|传给|给/.test(text);
  const wantsAction = /执行|处理|做|改|实现|修|查|跑|操作|落实|开始干/.test(text);
  const mentionsExecutor =
    /codex|code[x叉]?|代码|扣德克斯|扣得克斯|扣的克斯|扣得|扣德|科德克斯|科得克斯|寇德克斯|口德克斯|口得克斯|助手|后台|你/.test(text);
  if (mentionsExecutor && ((wantsSummary && wantsHandoff) || (wantsSummary && wantsAction) || (wantsHandoff && wantsAction))) {
    return true;
  }
  if (wantsSummary && wantsHandoff) {
    return true;
  }
  if (/交给codex|发给codex|提交给codex|让codex|交给代码|发给代码|提交给代码|让代码/.test(text)) {
    return true;
  }
  return false;
}

async function copyTextToClipboard(text) {
  const value = String(text || '');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back below for browsers that block Clipboard API in PWA/http contexts.
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

const PERMISSION_OPTIONS = [
  { value: 'default', label: '默认权限' },
  { value: 'acceptEdits', label: '自动接受编辑' },
  { value: 'bypassPermissions', label: '完全访问', danger: true }
];

const REASONING_OPTIONS = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' }
];

function formatTime(value) {
  if (!value) {
    return '';
  }
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(new Date(value));
  } catch {
    return '';
  }
}

function compactPath(value) {
  if (!value) {
    return '';
  }
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 2 ? `${parts.at(-2)}/${parts.at(-1)}` : normalized;
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 102.4) / 10} KB`;
  }
  return `${Math.round(size / 1024 / 102.4) / 10} MB`;
}

function shortModelName(model) {
  if (!model) {
    return '5.5';
  }
  return model
    .replace(/^gpt-/i, '')
    .replace(/-codex.*$/i, '')
    .replace(/-mini$/i, ' mini');
}

function permissionLabel(value) {
  return PERMISSION_OPTIONS.find((option) => option.value === value)?.label || '默认权限';
}

function reasoningLabel(value) {
  return REASONING_OPTIONS.find((option) => option.value === value)?.label || '超高';
}

function imageUrlWithRetry(url, retryKey) {
  if (!retryKey) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}r=${retryKey}`;
}

function createClientTurnId() {
  return globalThis.crypto?.randomUUID?.() || `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createDraftSession(project) {
  const now = new Date().toISOString();
  return {
    id: `draft-${project.id}-${Date.now()}`,
    projectId: project.id,
    title: '新对话',
    summary: '等待第一条消息',
    messageCount: 0,
    updatedAt: now,
    draft: true
  };
}

function isDraftSession(session) {
  const id = typeof session === 'string' ? session : session?.id;
  return Boolean(session?.draft || id?.startsWith('draft-'));
}

function titleFromFirstMessage(message) {
  const value = String(message || '').trim().replace(/\s+/g, ' ');
  return value ? value.slice(0, 52) : '新对话';
}

function payloadRunKeys(payload) {
  return [payload?.turnId, payload?.sessionId, payload?.previousSessionId].filter(Boolean);
}

function selectedRunKeys(session) {
  return [session?.id, session?.turnId].filter(Boolean);
}

function hasRunningKey(runningById, keys) {
  return keys.some((key) => Boolean(runningById[key]));
}

function hasVisibleAssistantForTurn(messages, payload) {
  const hasExactTurnMatch = messages.some(
    (message) =>
      message.role === 'assistant' &&
      payload?.turnId &&
      message.turnId === payload.turnId &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
  if (hasExactTurnMatch) {
    return true;
  }

  const latestUserIndex = messages.reduce(
    (latest, message, index) => (message.role === 'user' ? index : latest),
    -1
  );
  return messages.some(
    (message, index) =>
      message.role === 'assistant' &&
      index > latestUserIndex &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}

function spokenReplyText(value) {
  return String(value || '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/```[\s\S]*?```/g, ' 代码块 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[#>*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
}

function voiceDialogStatusLabel(state) {
  const labels = {
    idle: '准备对话',
    listening: '正在听',
    transcribing: '正在转写',
    sending: '正在发送',
    waiting: '等待回复',
    speaking: '正在朗读',
    summarizing: '正在整理任务',
    handoff: '确认交给 Codex',
    error: '对话出错'
  };
  return labels[state] || labels.idle;
}

function downsampleAudio(input, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return input;
  }
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const before = Math.floor(sourceIndex);
    const after = Math.min(before + 1, input.length - 1);
    const weight = sourceIndex - before;
    output[index] = input[before] * (1 - weight) + input[after] * weight;
  }
  return output;
}

function floatToPcm16Base64(input) {
  const bytes = new Uint8Array(input.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]));
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function pcm16Base64ToFloat(base64) {
  const binary = atob(base64);
  const length = Math.floor(binary.length / 2);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    const lo = binary.charCodeAt(index * 2);
    const hi = binary.charCodeAt(index * 2 + 1);
    const value = (hi << 8) | lo;
    const signed = value >= 0x8000 ? value - 0x10000 : value;
    output[index] = Math.max(-1, Math.min(1, signed / 0x8000));
  }
  return output;
}

function audioLevel(samples) {
  if (!samples?.length) {
    return 0;
  }
  let total = 0;
  for (let index = 0; index < samples.length; index += 1) {
    total += samples[index] * samples[index];
  }
  return Math.sqrt(total / samples.length);
}

function upsertSessionInProject(current, projectId, session, replaceId = null) {
  if (!projectId || !session) {
    return current;
  }
  const existing = current[projectId] || [];
  const filtered = existing.filter((item) => item.id !== session.id && (!replaceId || item.id !== replaceId));
  return {
    ...current,
    [projectId]: [session, ...filtered]
  };
}

function isUsableSessionId(value) {
  const id = String(value || '').trim();
  return Boolean(id && !id.startsWith('draft-') && !id.startsWith('codex-'));
}

function statusMessageId(payload) {
  return `status-${payload.turnId || payload.sessionId || 'current'}`;
}

function larkCliActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!lower.includes('lark-cli')) {
    return '';
  }

  if (/\bauth\b/.test(lower)) {
    return '确认飞书授权';
  }

  if (/\bsheets?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建表格';
    }
    if (/\+append|\bappend\b/.test(lower)) {
      return '追加表格数据';
    }
    if (/\+write|\bwrite\b/.test(lower)) {
      return '写入表格数据';
    }
    if (/\+find|\bfind\b/.test(lower)) {
      return '查找表格内容';
    }
    if (/\+replace|\breplace\b/.test(lower)) {
      return '替换表格内容';
    }
    if (/\+export|\bexport\b/.test(lower)) {
      return '导出表格';
    }
    if (/title|rename|\bpatch\b|\bupdate\b|spreadsheet\.meta/.test(lower)) {
      return '修改表名';
    }
    if (/\+read|\bread\b|\bget\b|\bmeta\b/.test(lower)) {
      return '读取表格信息';
    }
    return '操作表格';
  }

  if (/\bslides?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建 PPT';
    }
    if (/\+update|\bupdate\b|\breplace\b|\bpatch\b/.test(lower)) {
      return '修改 PPT';
    }
    if (/\+read|\bread\b|\bget\b|\bxml_presentations\b/.test(lower)) {
      return '读取 PPT';
    }
    return '操作 PPT';
  }

  if (/\bdocs?\b/.test(lower)) {
    if (/\+create|\bcreate\b/.test(lower)) {
      return '创建文档';
    }
    if (/\+update|\bupdate\b|\bappend\b|\breplace\b|\bpatch\b/.test(lower)) {
      return '修改文档';
    }
    if (/\+search|\bsearch\b/.test(lower)) {
      return '搜索文档';
    }
    if (/\+fetch|\bread\b|\bget\b|\bfetch\b/.test(lower)) {
      return '读取文档';
    }
    return '操作文档';
  }

  if (/\bdrive\b/.test(lower)) {
    if (/\+import|\bimport\b/.test(lower)) {
      return '导入文件';
    }
    if (/\+upload|\bupload\b/.test(lower)) {
      return '上传文件';
    }
    if (/\+download|\bdownload\b/.test(lower)) {
      return '下载文件';
    }
    if (/\+delete|\bdelete\b|\btrash\b/.test(lower)) {
      return '删除文件';
    }
    if (/\+move|\bmove\b/.test(lower)) {
      return '移动文件';
    }
    if (/title|rename|\bpatch\b|\bupdate\b/.test(lower)) {
      return '修改文件名';
    }
    if (/\+search|\bsearch\b/.test(lower)) {
      return '搜索云空间';
    }
    return '操作云空间';
  }

  return '';
}

function shellCommandActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  if (!text) {
    return '';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bvite\s+build\b|\bwebpack\b|\brollup\b/.test(lower)) {
    return '构建前端';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?smoke\b|\bsmoke\.mjs\b/.test(lower)) {
    return '运行冒烟检查';
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\bmvn\b.*\btest\b|\bcargo\s+test\b/.test(lower)) {
    return '运行测试';
  }
  if (/\bnode\s+--check\b|\btsc\b|\beslint\b|\bbiome\b|\bprettier\b|\bflake8\b|\bmypy\b/.test(lower)) {
    return '检查代码';
  }
  if (/\bgit\s+(status|diff|show|log|ls-files)\b/.test(lower)) {
    return '检查改动';
  }
  if (/\b(get-content|select-string|rg|findstr|grep)\b/.test(lower)) {
    return /\b(select-string|rg|findstr|grep)\b/.test(lower) ? '搜索代码' : '读取文件';
  }
  if (/\b(get-childitem|ls|dir)\b/.test(lower)) {
    return '查看文件';
  }
  if (/\b(start-process|node\s+server\/index\.js|node\s+server\\index\.js)\b/.test(lower)) {
    return '启动服务';
  }
  return '';
}

function meaningfulActivityLabel(payload, rawLabel, detail) {
  const source = [payload.command, detail, rawLabel, payload.output]
    .filter(Boolean)
    .join(' ');
  const larkLabel = larkCliActivityLabel(source);
  if (larkLabel) {
    return larkLabel;
  }
  const commandLabel = shellCommandActivityLabel(payload.command || detail);
  if (commandLabel) {
    return commandLabel;
  }

  if (payload.kind === 'agent_message' || payload.kind === 'message' || payload.kind === 'reasoning') {
    return briefActivityLabel(rawLabel || payload.content || detail);
  }

  if (isGenericActivityLabel(rawLabel)) {
    return '';
  }

  return rawLabel && rawLabel.length <= 18 ? rawLabel : '';
}

function isGenericActivityLabel(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return true;
  }
  return /^(正在思考中?|思考完成|正在处理|正在回复|正在整理回复|正在准备任务|正在修改并验证|正在执行命令|命令已完成|命令完成|命令执行完成|执行完成|工具调用完成|正在调用工具|工具调用失败|工具已完成|计划已更新|正在规划|任务已完成|已完成|完成|失败)$/i.test(text);
}

function activityStepFromPayload(payload, fallbackKind = 'status') {
  const rawLabel = String(payload.label || payload.content || '').replace(/\s+/g, ' ').trim();
  const detail = String(payload.detail || payload.error || '').replace(/\s+/g, ' ').trim();
  const label = meaningfulActivityLabel(payload, rawLabel, detail);
  if (!label) {
    return null;
  }
  return {
    id: payload.messageId || `${statusMessageId(payload)}-${payload.kind || fallbackKind}-${label || payload.status || 'step'}`,
    kind: payload.kind || fallbackKind,
    label,
    status: payload.status || 'running',
    detail,
    command: payload.command || '',
    output: payload.output || '',
    error: payload.error || '',
    fileChanges: payload.fileChanges || [],
    timestamp: payload.timestamp || new Date().toISOString()
  };
}

function briefActivityLabel(value, fallback = '正在处理') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  if (/授权|登录|连接/.test(text)) {
    return '确认授权';
  }
  if (/记忆|skill|技能|能力|scope|权限/i.test(text)) {
    return '';
  }
  if (/搜索|查找|定位/.test(text)) {
    return '查找文件';
  }
  if (/创建|新建|生成/.test(text)) {
    return '创建文件';
  }
  if (/改名|重命名|修改标题|rename/i.test(text) && /验证|确认|检查|读取/.test(text)) {
    return '修改并验证';
  }
  if (/改名|重命名|修改标题|rename/i.test(text)) {
    return '修改标题';
  }
  if (/读取|获取|标题|内容/.test(text)) {
    return '读取内容';
  }
  if (/修改|更新|写入|追加|替换|编辑/.test(text)) {
    return '修改内容';
  }
  if (/上传|导入/.test(text)) {
    return '上传文件';
  }
  if (/下载|导出/.test(text)) {
    return '导出文件';
  }
  if (/删除|移除/.test(text)) {
    return '删除文件';
  }
  if (/验证|确认|检查/.test(text)) {
    return '验证结果';
  }
  if (/命令|lark-cli|PowerShell|shell|执行/i.test(text)) {
    return '';
  }
  return text.length > 18 ? '' : text;
}

function mergeActivityStep(currentSteps, step) {
  if (!step) {
    return currentSteps || [];
  }
  const steps = [...(currentSteps || [])];
  const existingIndex = steps.findIndex((item) => item.id === step.id);
  if (existingIndex >= 0) {
    steps[existingIndex] = { ...steps[existingIndex], ...step };
    return steps.slice(-8);
  }
  const sameWorkIndex = steps.findIndex(
    (item) =>
      item.kind === step.kind &&
      item.label === step.label &&
      (item.command || '') === (step.command || '')
  );
  if (sameWorkIndex >= 0) {
    steps[sameWorkIndex] = { ...steps[sameWorkIndex], ...step };
    return steps.slice(-8);
  }
  const last = steps[steps.length - 1];
  if (last && last.label === step.label && last.detail === step.detail && last.status === step.status) {
    return steps;
  }
  return [...steps, step].slice(-8);
}

function isVisibleActivityStep(step, messageStatus) {
  if (!step) {
    return false;
  }
  const label = String(step.label || '').trim();
  if (isGenericActivityLabel(label)) {
    return false;
  }
  if (
    ['reasoning', 'message', 'agent_message'].includes(step.kind) &&
    /^(正在思考中?|正在处理|正在回复|正在整理回复)$/.test(label)
  ) {
    return false;
  }
  if (messageStatus !== 'failed' && step.kind === 'command_execution' && step.status === 'failed') {
    return false;
  }
  if (messageStatus !== 'failed' && /blocked by policy|rejected/i.test(`${step.detail || ''}\n${step.output || ''}\n${step.error || ''}`)) {
    return false;
  }
  return true;
}

function upsertStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const normalizedPayload =
    payload.kind === 'agent_message'
      ? { ...payload, label: briefActivityLabel(payload.label || payload.content) }
      : payload;
  const detail =
    normalizedPayload.kind === 'reasoning'
      ? previous?.detail || ''
      : normalizedPayload.detail || previous?.detail || '';
  const isTurnLevel = normalizedPayload.kind === 'turn' || normalizedPayload.kind === 'error';
  const nextMessage = {
    id,
    role: 'activity',
    turnId: normalizedPayload.turnId || previous?.turnId || null,
    sessionId: normalizedPayload.sessionId || previous?.sessionId || null,
    content: isTurnLevel ? (normalizedPayload.label || previous?.content || '正在处理') : (previous?.content || '正在处理'),
    label: isTurnLevel ? (normalizedPayload.label || previous?.label || '正在处理') : (previous?.label || '正在处理'),
    detail,
    kind: normalizedPayload.kind || previous?.kind || 'turn',
    status: isTurnLevel ? (normalizedPayload.status || previous?.status || 'running') : (previous?.status || 'running'),
    timestamp: normalizedPayload.timestamp || previous?.timestamp || new Date().toISOString(),
    activities: mergeActivityStep(previous?.activities || [], activityStepFromPayload(normalizedPayload))
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...current, nextMessage];
}

function upsertActivityMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const isTurnLevel = payload.kind === 'turn' || payload.kind === 'error';
  const activity = activityStepFromPayload(payload, 'activity');
  if (!activity && !previous) {
    return current;
  }
  const activities = activity
    ? mergeActivityStep(previous?.activities || [], activity)
    : previous?.activities || [];

  const nextMessage = {
    id,
    role: 'activity',
    turnId: payload.turnId || previous?.turnId || null,
    sessionId: payload.sessionId || previous?.sessionId || null,
    content: previous?.content || '正在处理',
    label: previous?.label || '正在处理',
    detail: payload.detail || previous?.detail || activity?.detail || '',
    kind: payload.kind || previous?.kind || 'activity',
    status: isTurnLevel ? (payload.status || previous?.status || 'running') : (previous?.status || 'running'),
    timestamp: previous?.timestamp || payload.timestamp || new Date().toISOString(),
    activities
  };

  if (existingIndex >= 0) {
    const next = [...current];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...current, nextMessage];
}

function completeStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  return current.filter((message) => message.id !== id);
}

function hasAssistantMessageForTurn(messages, payload) {
  return messages.some(
    (message) =>
      message.role === 'assistant' &&
      payload?.turnId &&
      message.turnId === payload.turnId &&
      typeof message.content === 'string' &&
      message.content.trim()
  );
}

function removeActivityMessagesForTurn(messages, payload) {
  const keys = new Set(payloadRunKeys(payload));
  if (!keys.size) {
    return messages;
  }
  return messages.filter((message) => {
    if (message.role !== 'activity') {
      return true;
    }
    return !payloadRunKeys(message).some((key) => keys.has(key));
  });
}

function upsertAssistantMessage(current, payload) {
  const content = String(payload.content || '').trim();
  if (!content) {
    return current;
  }
  const id = payload.messageId || `assistant-${payload.turnId || Date.now()}`;
  const nextMessage = {
    id,
    role: 'assistant',
    content,
    timestamp: new Date().toISOString(),
    turnId: payload.turnId || null,
    sessionId: payload.sessionId || null,
    kind: payload.kind
  };
  const withoutActivity = removeActivityMessagesForTurn(current, payload);
  const existingIndex = withoutActivity.findIndex((message) => message.id === id);
  if (existingIndex >= 0) {
    const next = [...withoutActivity];
    next[existingIndex] = nextMessage;
    return next;
  }
  return [...withoutActivity, nextMessage];
}

function PairingScreen({ onPaired }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);

  async function handlePair(event) {
    event.preventDefault();
    setPairing(true);
    setError('');
    try {
      const result = await apiFetch('/api/pair', {
        method: 'POST',
        body: {
          code,
          deviceName: navigator.platform || 'iPhone'
        }
      });
      setToken(result.token);
      onPaired();
    } catch (err) {
      setError(err.message);
    } finally {
      setPairing(false);
    }
  }

  return (
    <main className="pairing-screen">
      <div className="pairing-mark">
        <Monitor size={30} />
      </div>
      <h1>CodexMobile</h1>
      <p>输入电脑端启动日志里的配对码。</p>
      <form className="pairing-form" onSubmit={handlePair}>
        <input
          inputMode="numeric"
          maxLength={6}
          placeholder="6 位配对码"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
        />
        <button type="submit" disabled={code.length !== 6 || pairing}>
          {pairing ? <Loader2 className="spin" size={18} /> : <Check size={18} />}
          连接
        </button>
      </form>
      {error ? <div className="pairing-error">{error}</div> : null}
    </main>
  );
}

function quotaPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    return null;
  }
  return Math.max(0, Math.min(100, percent));
}

function quotaRemainingPercent(quotaWindow) {
  if (!quotaWindow || typeof quotaWindow !== 'object') {
    return null;
  }
  const display = quotaPercent(quotaWindow.displayPercent ?? quotaWindow.display_percent);
  if (display !== null) {
    return display;
  }
  const explicit = quotaPercent(quotaWindow.remainingPercent ?? quotaWindow.remaining_percent);
  if (explicit !== null) {
    return explicit;
  }
  const used = quotaPercent(quotaWindow.usedPercent ?? quotaWindow.used_percent);
  return used === null ? null : Math.max(0, Math.min(100, 100 - used));
}

function formatQuotaPercent(quotaWindow) {
  const percent = quotaRemainingPercent(quotaWindow);
  return percent === null ? '--' : `${Math.round(percent)}%`;
}

function quotaToneClass(percent) {
  if (percent === null) {
    return 'is-low';
  }
  if (percent >= 80) {
    return 'is-healthy';
  }
  if (percent >= 60) {
    return 'is-medium';
  }
  if (percent >= 40) {
    return 'is-warning';
  }
  return 'is-low';
}

function Drawer({
  open,
  onClose,
  projects,
  selectedProject,
  selectedSession,
  expandedProjectIds,
  sessionsByProject,
  loadingProjectId,
  onToggleProject,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onNewConversation,
  onSync,
  syncing,
  theme,
  setTheme
}) {
  const [drawerView, setDrawerView] = useState('main');
  const [quotaExpanded, setQuotaExpanded] = useState(false);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [quotaLoaded, setQuotaLoaded] = useState(false);
  const [quotaError, setQuotaError] = useState('');
  const [quotaAccounts, setQuotaAccounts] = useState([]);

  async function refreshCodexQuota(event) {
    event?.preventDefault();
    event?.stopPropagation();
    if (quotaLoading) {
      return;
    }
    setQuotaExpanded(true);
    setQuotaLoading(true);
    setQuotaError('');
    try {
      const result = await apiFetch('/api/quotas/codex');
      setQuotaAccounts(Array.isArray(result.accounts) ? result.accounts : []);
      setQuotaLoaded(true);
    } catch {
      setQuotaError('查询失败，点击刷新重试');
      setQuotaLoaded(true);
    } finally {
      setQuotaLoading(false);
    }
  }

  if (drawerView === 'settings') {
    return (
      <>
        <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
        <aside className={`drawer ${open ? 'is-open' : ''}`}>
          <div className="drawer-subheader">
            <button className="icon-button" onClick={() => setDrawerView('main')} aria-label="返回">
              <ChevronLeft size={22} />
            </button>
            <strong>设置</strong>
            <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
              <X size={20} />
            </button>
          </div>
          <div className="settings-view">
            <section className="settings-group">
              <div className="drawer-heading">外观</div>
              <div className="theme-setting">
                <div className="theme-setting-title">
                  <span>主题选择</span>
                </div>
                <div className="theme-segment" role="group" aria-label="主题选择">
                  <button
                    type="button"
                    className={theme === 'light' ? 'is-selected' : ''}
                    onClick={() => setTheme('light')}
                  >
                    白色
                  </button>
                  <button
                    type="button"
                    className={theme === 'dark' ? 'is-selected' : ''}
                    onClick={() => setTheme('dark')}
                  >
                    黑色
                  </button>
                </div>
              </div>
            </section>
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      <div className={`drawer-backdrop ${open ? 'is-open' : ''}`} onClick={onClose} />
      <aside className={`drawer ${open ? 'is-open' : ''}`}>
        <div className="drawer-grip">
          <button className="icon-button" onClick={onClose} aria-label="关闭菜单">
            <X size={20} />
          </button>
        </div>

        <button className="drawer-action" onClick={onNewConversation}>
          <MessageSquarePlus size={20} />
          <span>
            <strong>新对话</strong>
            <small>在当前项目中新建</small>
          </span>
        </button>

        <section className="drawer-section project-section">
          <div className="drawer-heading">项目</div>
          <div className="project-list">
            {projects.map((project) => {
              const isSelected = selectedProject?.id === project.id;
              const isExpanded = Boolean(expandedProjectIds[project.id]);
              const projectSessions = sessionsByProject[project.id] || [];
              return (
                <div key={project.id} className="project-group">
                  <button
                    className={`project-row ${isSelected ? 'is-selected' : ''} ${isExpanded ? 'is-expanded' : ''}`}
                    onClick={() => onToggleProject(project)}
                  >
                    <Folder size={18} />
                    <span>
                      <strong>{project.name}</strong>
                      <small>{compactPath(project.path)}</small>
                    </span>
                    <small className="project-count">{project.sessionCount || projectSessions.length || 0}</small>
                    <ChevronDown size={15} className="project-chevron" />
                  </button>
                  {isExpanded ? (
                    <div className="thread-list">
                      {loadingProjectId === project.id ? (
                        <div className="thread-empty">
                          <Loader2 className="spin" size={14} />
                          加载中
                        </div>
                      ) : projectSessions.length ? (
                        projectSessions.map((session) => (
                          <div
                            key={session.id}
                            className={`thread-row ${selectedSession?.id === session.id ? 'is-selected' : ''} ${session.draft ? 'is-draft' : ''}`}
                          >
                            <button
                              type="button"
                              className="thread-main"
                              onClick={() => onSelectSession(project, session)}
                            >
                              <span>{session.title || '对话'}</span>
                              <small>{session.draft ? '待发送' : formatTime(session.updatedAt)}</small>
                            </button>
                            <button
                              type="button"
                              className="thread-rename"
                              onClick={() => onRenameSession(project, session)}
                              aria-label="重命名线程"
                              title="重命名线程"
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              type="button"
                              className="thread-delete"
                              onClick={() => onDeleteSession(project, session)}
                              aria-label="删除线程"
                              title="删除线程"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="thread-empty">暂无线程</div>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section className="drawer-section drawer-controls">
          <div className="control-row sync-row">
            <span>
              对话同步
            </span>
            <button className="sync-button" onClick={onSync} disabled={syncing}>
              {syncing ? <Loader2 className="spin" size={16} /> : null}
              同步
            </button>
            <span className="sync-spacer" aria-hidden="true" />
          </div>
          <div className={`quota-widget ${quotaExpanded ? 'is-expanded' : ''}`}>
            <div className="quota-row">
              <button
                type="button"
                className="quota-main"
                onClick={() => setQuotaExpanded((current) => !current)}
              >
                <span className="quota-title">额度查询</span>
                <span className="quota-kind">Codex</span>
              </button>
              <button
                type="button"
                className="quota-refresh"
                onClick={refreshCodexQuota}
                disabled={quotaLoading}
              >
                {quotaLoading ? '刷新中...' : '刷新'}
              </button>
              <button
                type="button"
                className="quota-toggle"
                onClick={() => setQuotaExpanded((current) => !current)}
                aria-label={quotaExpanded ? '收起额度查询' : '展开额度查询'}
              >
                <ChevronDown size={16} />
              </button>
            </div>
            {quotaExpanded ? (
              <div className="quota-panel">
                {quotaError ? (
                  <button type="button" className="quota-error" onClick={refreshCodexQuota}>
                    {quotaError}
                  </button>
                ) : null}
                {!quotaError && quotaAccounts.length ? (
                  quotaAccounts.map((account) => {
                    const windows = Array.isArray(account.windows) ? account.windows : [];
                    const accountStatus = account.status || 'ok';
                    const plan = account.plan || 'Codex';
                    return (
                      <div key={account.id} className={`quota-account is-${accountStatus}`}>
                        <div className="quota-account-head">
                          <span>{account.label || 'Codex'}</span>
                          <small>{plan}</small>
                        </div>
                        {accountStatus === 'ok' && windows.length ? (
                          <div className="quota-window-list">
                            {windows.map((quotaWindow) => {
                              const percent = quotaRemainingPercent(quotaWindow);
                              return (
                                <div
                                  key={quotaWindow.id}
                                  className={`quota-window ${quotaToneClass(percent)}`}
                                  style={{ '--quota-percent': `${percent ?? 0}%` }}
                                >
                                  <div className="quota-window-meta">
                                    <span>{quotaWindow.label}</span>
                                    <strong>{formatQuotaPercent(quotaWindow)}</strong>
                                  </div>
                                  <div className="quota-bar">
                                    <span />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="quota-account-message"
                            onClick={accountStatus === 'failed' ? refreshCodexQuota : undefined}
                          >
                            {accountStatus === 'disabled' ? '已停用' : '查询失败，点击刷新重试'}
                          </button>
                        )}
                      </div>
                    );
                  })
                ) : null}
                {!quotaLoading && !quotaError && quotaLoaded && !quotaAccounts.length ? (
                  <div className="quota-empty">暂无 Codex 凭证</div>
                ) : null}
              </div>
            ) : null}
          </div>
          <button type="button" className="settings-entry" onClick={() => setDrawerView('settings')}>
            <span>
              <Settings size={18} />
              设置
            </span>
            <ChevronRight size={17} />
          </button>
        </section>
      </aside>
    </>
  );
}

function TopBar({ selectedProject, connectionState, onMenu, onOpenDocs }) {
  const status = CONNECTION_STATUS[connectionState] || CONNECTION_STATUS.disconnected;
  return (
    <header className="top-bar">
      <button className="icon-button" onClick={onMenu} aria-label="打开菜单">
        <Menu size={22} />
      </button>
      <div className="top-title">
        <strong>{selectedProject?.name || 'CodexMobile'}</strong>
        <span className={`connection-status ${status.className}`}>
          <Wifi size={13} />
          {status.label}
        </span>
      </div>
      <button type="button" className="icon-button" onClick={onOpenDocs} aria-label="打开文档">
        <FeishuLogoIcon size={23} className="top-docs-logo" />
      </button>
    </header>
  );
}

function FeishuLogoIcon({ size = 30, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="飞书"
    >
      <rect x="4" y="4" width="56" height="56" rx="15" fill="#fff" />
      <path
        d="M24 15h16.4c2.2 0 3.4.7 4.7 2.5 4.1 5.7 6.5 12.2 7 19.6-6.4-5.5-13.3-8.5-20.4-8.7L24 15Z"
        fill="#12C9B7"
      />
      <path
        d="M14.5 25.8c7.1 7.9 15.3 13.8 24.5 17.8 7.4 3.2 14.7 2.7 21.4-1.6-5.7 9.6-14.7 15.1-27 16.4-7.1.8-13.9-.1-20.5-2.8-2.4-1-4.2-3.2-4.2-5.9V28.1c0-2.3 2.4-3.8 5.8-2.3Z"
        fill="#3A73F6"
      />
      <path
        d="M30.8 38.4c8.7-9.7 18.3-14.1 28.8-8.7-4.8 9.1-12.2 16.1-21.5 17.2-5.8.7-11.7-1-17.8-5.1 3.7-.5 7.2-1.6 10.5-3.4Z"
        fill="#1F45A7"
      />
    </svg>
  );
}

function DocsPanel({ open, docs, busy, error, onClose, onConnect, onDisconnect, onOpenHome, onOpenAuth, onRefresh }) {
  if (!open) {
    return null;
  }

  const cliInstalled = Boolean(docs?.cliInstalled);
  const skillsInstalled = Boolean(docs?.skillsInstalled);
  const configured = Boolean(docs?.configured);
  const connected = Boolean(docs?.connected);
  const authorizationReady = connected && Boolean(docs?.authorizationReady);
  const missingScopes = Array.isArray(docs?.missingScopes) ? docs.missingScopes : [];
  const needsExtraAuth = connected && (!authorizationReady || missingScopes.length > 0);
  const slidesAuthorized = connected && Boolean(docs?.slidesAuthorized);
  const sheetsAuthorized = connected && Boolean(docs?.sheetsAuthorized);
  const authPending = docs?.authPending;
  const setupItems = [
    { id: 'cli', label: 'lark-cli', ok: cliInstalled },
    { id: 'skills', label: '官方 skills', ok: skillsInstalled },
    { id: 'config', label: 'App 凭证', ok: configured },
    { id: 'auth', label: '用户授权', ok: connected },
    { id: 'slides', label: 'PPT 权限', ok: slidesAuthorized },
    { id: 'sheets', label: '表格权限', ok: sheetsAuthorized }
  ];
  const subtitle = connected
    ? needsExtraAuth
      ? '待补权限'
      : ''
    : authPending?.status === 'polling'
      ? '等待授权'
      : configured
        ? '未连接'
        : '未配置';
  const summary = authPending?.status === 'polling'
      ? '授权页已打开，完成后回到这里刷新状态。'
      : connected
        ? needsExtraAuth
          ? '飞书账号已连接，但部分文档权限还没授权。补充授权后，Codex 可完整操作飞书文档、PPT、表格和云空间文件。'
          : 'Codex 已可操作飞书文档、PPT、表格和云空间文件。'
        : !cliInstalled
          ? '本机还没有检测到 lark-cli。'
          : !skillsInstalled
            ? '官方文档 skills 还没有安装完整。'
            : configured
              ? '连接飞书账号后，Codex 才能以你的身份操作文档、PPT 和表格。'
              : '请先在后端配置飞书 App ID 和 Secret。';
  const canConnect = cliInstalled && skillsInstalled && configured;

  return (
    <section className="docs-panel" role="dialog" aria-modal="true" aria-label="飞书文档">
      <header className="docs-panel-header">
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭文档">
          <ChevronLeft size={22} />
        </button>
        <div className="docs-panel-title">
          <strong>飞书文档</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭文档">
          <X size={20} />
        </button>
      </header>
      <div className="docs-panel-body">
        <div className="docs-status-state">
          <div className="docs-status-icon">
            <FeishuLogoIcon size={58} />
          </div>
          <h2>飞书文档</h2>
          <p>{summary}</p>
          {error ? <div className="docs-panel-error">{error}</div> : null}
          {authPending?.verificationUrl && (!connected || needsExtraAuth) ? (
            <div className="docs-auth-box">
              <span>授权码 {authPending.userCode || '已生成'}</span>
              <button type="button" onClick={() => onOpenAuth(authPending.verificationUrl)}>
                打开授权页
              </button>
            </div>
          ) : null}
          <div className="docs-check-list">
            {setupItems.map((item) => (
              <div key={item.id} className={item.ok ? 'is-ok' : ''}>
                {item.ok ? <Check size={15} /> : <X size={15} />}
                <span>{item.label}</span>
              </div>
            ))}
          </div>
          {needsExtraAuth && missingScopes.length ? (
            <div className="docs-scope-hint">
              缺少 {missingScopes.slice(0, 4).join('、')}
            </div>
          ) : null}
          <div className="docs-panel-actions">
            {connected ? (
              <>
                <button type="button" onClick={needsExtraAuth ? onConnect : onOpenHome} disabled={needsExtraAuth && busy}>
                  {needsExtraAuth ? (
                    busy ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />
                  ) : (
                    <FeishuLogoIcon size={18} />
                  )}
                  {needsExtraAuth ? '补充授权' : '打开飞书'}
                </button>
                <button type="button" onClick={onDisconnect} disabled={busy}>
                  {busy ? <Loader2 className="spin" size={16} /> : <X size={16} />}
                  断开
                </button>
                <button type="button" onClick={onRefresh} disabled={busy}>
                  <RefreshCw size={16} />
                  刷新
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={onConnect} disabled={!canConnect || busy}>
                  {busy ? <Loader2 className="spin" size={16} /> : <ShieldCheck size={16} />}
                  连接飞书
                </button>
                <button type="button" onClick={onRefresh} disabled={busy}>
                  <RefreshCw size={16} />
                  刷新
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ActivityMessage({ message }) {
  const running = message.status === 'running' || message.status === 'queued';
  const failed = message.status === 'failed';
  const activities = message.activities || [];
  const visibleSteps = activities.filter((activity) => isVisibleActivityStep(activity, message.status)).slice(-4);
  const headline = running ? '正在思考中' : message.label || message.content || '正在处理';

  return (
    <div className="message-row is-activity">
      <div className={`message-bubble activity-bubble ${failed ? 'is-failed' : ''}`}>
        <div className="activity-summary" role="status" aria-live="polite">
          {running ? <Loader2 className="spin" size={15} /> : failed ? <X size={15} /> : <Check size={15} />}
          <span>{headline}</span>
        </div>
        {visibleSteps.length ? (
          <div className="activity-steps" aria-label="任务进度">
            {visibleSteps.map((activity) => (
              <div key={activity.id} className={`activity-step is-${activity.status || 'running'}`}>
                <span className="activity-step-dot" />
                <span>{activity.label}</span>
              </div>
            ))}
          </div>
        ) : null}
        {message.timestamp ? <time>{formatTime(message.timestamp)}</time> : null}
      </div>
    </div>
  );
}

function GeneratedImage({ part, onPreviewImage }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);
  const src = imageUrlWithRetry(part.url, retryKey);

  function retry(event) {
    event.stopPropagation();
    setLoadState('loading');
    setRetryKey(Date.now());
  }

  return (
    <button
      type="button"
      className={`message-image-link ${loadState === 'failed' ? 'is-failed' : ''}`}
      onClick={() => (loadState === 'failed' ? setRetryKey(Date.now()) : onPreviewImage(part))}
      aria-label="预览图片"
    >
      <img
        className="message-image"
        src={src}
        alt={part.alt}
        loading="eager"
        decoding="async"
        onLoad={() => setLoadState('loaded')}
        onError={() => setLoadState('failed')}
      />
      {loadState === 'failed' ? (
        <span className="image-error">
          图片加载失败
          <span onClick={retry}>重试</span>
        </span>
      ) : null}
    </button>
  );
}

function ImagePreviewModal({ image, onClose }) {
  const [loadState, setLoadState] = useState('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    setLoadState('loading');
    setRetryKey(0);
  }, [image?.url]);

  if (!image) {
    return null;
  }

  const src = imageUrlWithRetry(image.url, retryKey);

  return (
    <div className="image-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="lightbox-top">
        <button type="button" className="lightbox-close" onClick={onClose} aria-label="关闭图片预览">
          <X size={22} />
        </button>
      </div>
      <div className="lightbox-stage" onClick={(event) => event.stopPropagation()}>
        <img
          src={src}
          alt={image.alt || '生成图片'}
          onLoad={() => setLoadState('loaded')}
          onError={() => setLoadState('failed')}
        />
      </div>
      {loadState === 'failed' ? (
        <div className="lightbox-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            onClick={() => {
              setLoadState('loading');
              setRetryKey(Date.now());
            }}
          >
            <RefreshCw size={16} />
            重新加载
          </button>
        </div>
      ) : null}
    </div>
  );
}

function MessageContent({ content, onPreviewImage }) {
  const text = String(content || '');
  const parts = [];
  const pattern = /!\[([^\]]*)\]\((\/generated\/[^)\s]+)\)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: 'image', alt: match[1] || '生成图片', url: match[2] });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  if (!parts.length) {
    return <div className="message-content">{renderInlineText(text, 'message-root')}</div>;
  }

  const rendered = [];
  parts.forEach((part, index) => {
    if (part.type === 'image') {
      rendered.push(<GeneratedImage key={`${part.url}-${index}`} part={part} onPreviewImage={onPreviewImage} />);
      return;
    }
    rendered.push(...renderInlineText(part.value, `message-${index}`));
  });

  return (
    <div className="message-content">
      {rendered}
    </div>
  );
}

function normalizeInlineHref(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  if (/^https?:\/\//i.test(raw) || /^mailto:/i.test(raw)) {
    return raw;
  }
  return `https://${raw}`;
}

function renderInlineText(text, keyPrefix) {
  const value = String(text || '');
  const pattern = /\[([^\]]+)\]\(((?:https?:\/\/|www\.)[^\s)]+)\)|((?:https?:\/\/|www\.)[^\s<>()]+)/gi;
  const nodes = [];
  let lastIndex = 0;
  let match;
  let partIndex = 0;

  while ((match = pattern.exec(value))) {
    if (match.index > lastIndex) {
      nodes.push(<span key={`${keyPrefix}-text-${partIndex++}`}>{value.slice(lastIndex, match.index)}</span>);
    }

    if (match[1] && match[2]) {
      const href = normalizeInlineHref(match[2]);
      nodes.push(
        <a key={`${keyPrefix}-link-${partIndex++}`} href={href} target="_blank" rel="noreferrer noopener">
          {match[1]}
        </a>
      );
    } else if (match[3]) {
      const href = normalizeInlineHref(match[3]);
      nodes.push(
        <a key={`${keyPrefix}-link-${partIndex++}`} href={href} target="_blank" rel="noreferrer noopener">
          {match[3]}
        </a>
      );
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < value.length) {
    nodes.push(<span key={`${keyPrefix}-text-${partIndex++}`}>{value.slice(lastIndex)}</span>);
  }

  return nodes.length ? nodes : [<span key={`${keyPrefix}-text-0`}>{value}</span>];
}

function ChatMessage({ message, onPreviewImage, onDeleteMessage }) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef(null);

  useEffect(() => () => {
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  if (message.role === 'activity') {
    return <ActivityMessage message={message} />;
  }
  const isUser = message.role === 'user';
  const canAct = message.role === 'user' || message.role === 'assistant';

  async function handleCopy() {
    const copiedText = await copyTextToClipboard(message.content);
    if (!copiedText) {
      window.alert('复制失败');
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className={`message-row ${isUser ? 'is-user' : ''}`}>
      <div className="message-stack">
        <div className="message-bubble">
          <MessageContent content={message.content} onPreviewImage={onPreviewImage} />
          {message.timestamp ? <time>{formatTime(message.timestamp)}</time> : null}
        </div>
        {canAct ? (
          <div className="message-actions" aria-label="消息操作">
            <button type="button" className="message-action" onClick={handleCopy}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
            <button type="button" className="message-action is-delete" onClick={() => onDeleteMessage?.(message)}>
              <Trash2 size={13} />
              <span>删除</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChatPane({ messages, selectedSession, running, onPreviewImage, onDeleteMessage }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, running]);

  if (!messages.length) {
    return (
      <section className="chat-pane empty-chat">
        <div className="empty-orbit">
          <ShieldCheck size={30} />
        </div>
        <h2>{selectedSession ? selectedSession.title : '新对话'}</h2>
        <p>问 Codex 任何事。</p>
      </section>
    );
  }

  return (
    <section className="chat-pane">
      {messages.map((message) => (
        <ChatMessage
          key={message.id}
          message={message}
          onPreviewImage={onPreviewImage}
          onDeleteMessage={onDeleteMessage}
        />
      ))}
      <div ref={bottomRef} />
    </section>
  );
}

function VoiceDialogPanel({
  open,
  state,
  error,
  transcript,
  assistantText,
  handoffDraft,
  onHandoffDraftChange,
  onHandoffSubmit,
  onHandoffContinue,
  onHandoffCancel,
  onStart,
  onStop,
  onClose
}) {
  if (!open) {
    return null;
  }

  const listening = state === 'listening';
  const confirmingHandoff = state === 'handoff';
  const busy = ['transcribing', 'sending', 'waiting', 'speaking', 'summarizing'].includes(state);
  const statusIcon = state === 'speaking'
    ? <Volume2 size={28} />
    : busy
      ? <Loader2 className="spin" size={28} />
      : <Mic size={28} />;

  return (
    <div className="voice-dialog-backdrop">
      <section className="voice-dialog-panel" role="dialog" aria-modal="true" aria-label="语音对话">
        <div className="voice-dialog-header">
          <span>
            <Headphones size={17} />
            语音对话
          </span>
          <button type="button" onClick={onClose} aria-label="关闭语音对话">
            <X size={18} />
          </button>
        </div>
        <div className={`voice-dialog-orb is-${state}`}>
          {statusIcon}
        </div>
        <div className={`voice-dialog-status ${error ? 'is-error' : ''}`}>
          {error || voiceDialogStatusLabel(state)}
        </div>
        {transcript ? <p className="voice-dialog-line is-user">{transcript}</p> : null}
        {assistantText ? <p className="voice-dialog-line is-assistant">{assistantText}</p> : null}
        {confirmingHandoff ? (
          <div className="voice-dialog-handoff">
            <textarea
              value={handoffDraft}
              onChange={(event) => onHandoffDraftChange(event.target.value)}
              rows={8}
              aria-label="交给 Codex 的任务"
            />
            <div className="voice-dialog-actions voice-dialog-handoff-actions">
              <button type="button" className="voice-dialog-secondary" onClick={onHandoffContinue}>
                继续补充
              </button>
              <button type="button" className="voice-dialog-secondary" onClick={onHandoffCancel}>
                取消
              </button>
              <button
                type="button"
                className="voice-dialog-primary"
                onClick={onHandoffSubmit}
                disabled={!String(handoffDraft || '').trim()}
              >
                交给 Codex
              </button>
            </div>
          </div>
        ) : (
          <div className="voice-dialog-actions">
          <button
            type="button"
            className={`voice-dialog-primary ${listening ? 'is-listening' : ''}`}
            onClick={listening ? onStop : onStart}
            disabled={busy}
          >
            {listening ? '停止' : '开始'}
          </button>
          <button type="button" className="voice-dialog-secondary" onClick={onClose}>
            结束
          </button>
          </div>
        )}
      </section>
    </div>
  );
}

function Composer({
  input,
  setInput,
  onSubmit,
  running,
  onAbort,
  models,
  selectedModel,
  onSelectModel,
  selectedReasoningEffort,
  onSelectReasoningEffort,
  permissionMode,
  onSelectPermission,
  attachments,
  onUploadFiles,
  onRemoveAttachment,
  uploading,
  onVoiceSubmit,
  onOpenVoiceDialog,
  voiceDialogActive
}) {
  const textareaRef = useRef(null);
  const imageInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const voiceChunksRef = useRef([]);
  const voiceStreamRef = useRef(null);
  const voiceTimerRef = useRef(null);
  const voiceErrorTimerRef = useRef(null);
  const [openMenu, setOpenMenu] = useState(null);
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceError, setVoiceError] = useState('');
  const hasInput = input.trim().length > 0 || attachments.length > 0;
  const modelList = models?.length ? models : [{ value: selectedModel || 'gpt-5.5', label: selectedModel || 'gpt-5.5' }];
  const selectedModelLabel = modelList.find((model) => model.value === selectedModel)?.label || selectedModel || 'gpt-5.5';
  const voiceRecording = voiceState === 'recording';
  const voiceTranscribing = voiceState === 'transcribing';
  const voiceSending = voiceState === 'sending';

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`;
  }, [input]);

  useEffect(() => () => {
    clearVoiceTimer();
    clearVoiceErrorTimer();
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
    }
    stopVoiceStream();
  }, []);

  function submit(event) {
    event.preventDefault();
    if (running && !hasInput) {
      onAbort();
      return;
    }
    if (hasInput) {
      onSubmit();
      setOpenMenu(null);
    }
  }

  function toggleMenu(name) {
    setOpenMenu((current) => (current === name ? null : name));
  }

  function handleFiles(event, kind) {
    const files = Array.from(event.target.files || []);
    if (files.length) {
      onUploadFiles(files, kind);
    }
    event.target.value = '';
    setOpenMenu(null);
  }

  function setVoiceErrorBriefly(message) {
    clearVoiceErrorTimer();
    setVoiceError(message);
    voiceErrorTimerRef.current = window.setTimeout(() => {
      setVoiceError('');
      voiceErrorTimerRef.current = null;
    }, 2600);
  }

  function clearVoiceErrorTimer() {
    if (voiceErrorTimerRef.current) {
      window.clearTimeout(voiceErrorTimerRef.current);
      voiceErrorTimerRef.current = null;
    }
  }

  function clearVoiceTimer() {
    if (voiceTimerRef.current) {
      window.clearTimeout(voiceTimerRef.current);
      voiceTimerRef.current = null;
    }
  }

  function stopVoiceStream() {
    voiceStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    voiceStreamRef.current = null;
  }

  function voiceMimeType() {
    if (!window.MediaRecorder?.isTypeSupported) {
      return '';
    }
    return VOICE_MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
  }

  async function transcribeVoiceBlob(blob) {
    if (!blob?.size) {
      setVoiceErrorBriefly('没有录到声音');
      return '';
    }
    if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
      setVoiceErrorBriefly('录音超过 10MB');
      return '';
    }

    const formData = new FormData();
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', blob, `voice.${extension}`);

    try {
      const result = await apiFetch('/api/voice/transcribe', {
        method: 'POST',
        body: formData
      });
      if (!result.text?.trim()) {
        setVoiceErrorBriefly('没有识别到文字');
        return '';
      }
      return result.text.trim();
    } catch (error) {
      setVoiceErrorBriefly(error.message || '语音转写失败');
      return '';
    }
  }

  async function startVoiceRecording() {
    setOpenMenu(null);
    clearVoiceErrorTimer();
    setVoiceError('');
    if (window.location.protocol !== 'https:') {
      setVoiceErrorBriefly('请使用 HTTPS 地址或 iOS 键盘听写');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceErrorBriefly('当前浏览器不支持录音');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = voiceMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceStreamRef.current = stream;
      voiceChunksRef.current = [];
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          voiceChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        clearVoiceTimer();
        stopVoiceStream();
        setVoiceState('idle');
        setVoiceErrorBriefly('录音失败');
      };
      recorder.onstop = async () => {
        clearVoiceTimer();
        stopVoiceStream();
        const recordedType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(voiceChunksRef.current, { type: recordedType });
        voiceChunksRef.current = [];
        mediaRecorderRef.current = null;
        try {
          setVoiceState('transcribing');
          const transcript = await transcribeVoiceBlob(blob);
          if (transcript) {
            setVoiceState('sending');
            await onVoiceSubmit(transcript);
          }
        } catch (error) {
          setVoiceErrorBriefly(error.message || '语音发送失败');
        } finally {
          setVoiceState('idle');
        }
      };

      recorder.start();
      setVoiceState('recording');
      voiceTimerRef.current = window.setTimeout(() => {
        if (mediaRecorderRef.current?.state === 'recording') {
          setVoiceState('transcribing');
          mediaRecorderRef.current.stop();
        }
      }, VOICE_MAX_RECORDING_MS);
    } catch (error) {
      clearVoiceTimer();
      stopVoiceStream();
      mediaRecorderRef.current = null;
      setVoiceState('idle');
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      setVoiceErrorBriefly(denied ? '麦克风权限被拒绝' : '录音启动失败');
    }
  }

  function stopVoiceRecording() {
    if (mediaRecorderRef.current?.state === 'recording') {
      clearVoiceErrorTimer();
      setVoiceError('');
      setVoiceState('transcribing');
      mediaRecorderRef.current.stop();
      return;
    }
    clearVoiceTimer();
    stopVoiceStream();
    setVoiceState('idle');
  }

  function toggleVoiceInput() {
    if (voiceRecording) {
      stopVoiceRecording();
    } else if (!voiceTranscribing && !voiceSending) {
      startVoiceRecording();
    }
  }

  return (
    <form className="composer-wrap" onSubmit={submit}>
      <input
        ref={imageInputRef}
        className="file-input"
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => handleFiles(event, 'image')}
      />
      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        multiple
        onChange={(event) => handleFiles(event, 'file')}
      />
      {openMenu === 'attach' ? (
        <div className="composer-menu attach-menu">
          <button type="button" onClick={() => imageInputRef.current?.click()}>
            <Image size={17} />
            相册
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()}>
            <FileText size={17} />
            文件
          </button>
        </div>
      ) : null}
      {openMenu === 'permission' ? (
        <div className="composer-menu permission-menu">
          {PERMISSION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${permissionMode === option.value ? 'is-selected' : ''} ${option.danger ? 'is-danger' : ''}`}
              onClick={() => {
                onSelectPermission(option.value);
                setOpenMenu(null);
              }}
            >
              {permissionMode === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {openMenu === 'model' ? (
        <div className="composer-menu model-menu">
          <div className="menu-section-label">智能</div>
          {REASONING_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={selectedReasoningEffort === option.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectReasoningEffort(option.value);
                setOpenMenu(null);
              }}
            >
              {selectedReasoningEffort === option.value ? <Check size={16} /> : <span className="menu-spacer" />}
              <span>{option.label}</span>
            </button>
          ))}
          <div className="menu-divider" />
          <div className="menu-section-label">模型</div>
          {modelList.map((model) => (
            <button
              key={model.value}
              type="button"
              className={selectedModel === model.value ? 'is-selected' : ''}
              onClick={() => {
                onSelectModel(model.value);
                setOpenMenu(null);
              }}
            >
              {selectedModel === model.value ? <Check size={16} /> : <span className="menu-spacer" />}
              <span>{model.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {voiceState !== 'idle' || voiceError ? (
        <div className={`voice-popover ${voiceError ? 'is-error' : ''}`}>
          <Mic size={14} />
          <span>{voiceError || (voiceSending ? '正在发送...' : voiceTranscribing ? '正在转写...' : '正在录音...')}</span>
        </div>
      ) : null}
      <div className="composer">
        {attachments.length ? (
          <div className="attachment-tray">
            {attachments.map((attachment) => (
              <span key={attachment.id} className="attachment-chip">
                <Paperclip size={14} />
                <span>{attachment.name}</span>
                <small>{formatBytes(attachment.size)}</small>
                <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label="移除附件">
                  <Trash2 size={13} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="给 Codex 发送消息"
        />
        <div className="composer-controls">
          <div className="control-left">
            <button type="button" className="ghost-icon" aria-label="添加" onClick={() => toggleMenu('attach')} disabled={uploading}>
              <Plus size={21} />
            </button>
            <button type="button" className="permission-pill" onClick={() => toggleMenu('permission')}>
              {permissionLabel(permissionMode)}
              <ChevronDown size={15} />
            </button>
          </div>
          <div className="control-right">
            <button type="button" className="model-select" onClick={() => toggleMenu('model')}>
              {shortModelName(selectedModelLabel)} {reasoningLabel(selectedReasoningEffort)}
              <ChevronDown size={15} />
            </button>
            <button
              type="button"
              className={`dialog-button ${voiceDialogActive ? 'is-active' : ''}`}
              onClick={onOpenVoiceDialog}
              aria-label="语音对话"
            >
              <Headphones size={16} />
              <span>对话</span>
            </button>
            <button
              type="button"
              className={`voice-button ${voiceRecording ? 'is-recording' : ''} ${voiceTranscribing ? 'is-transcribing' : ''} ${voiceSending ? 'is-sending' : ''}`}
              onClick={toggleVoiceInput}
              disabled={voiceTranscribing || voiceSending}
              aria-label={voiceRecording ? '停止语音输入' : voiceSending ? '正在发送语音' : '开始语音输入'}
            >
              {voiceTranscribing || voiceSending ? <Loader2 className="spin" size={16} /> : <Mic size={17} />}
            </button>
            <button type="submit" className={`send-button ${running ? 'is-running' : ''}`} disabled={uploading || (!hasInput && !running)}>
              {running && !hasInput ? <Square size={16} /> : uploading ? <Loader2 className="spin" size={16} /> : <ArrowUp size={19} />}
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

export default function App() {
  const [status, setStatus] = useState(DEFAULT_STATUS);
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [expandedProjectIds, setExpandedProjectIds] = useState({});
  const [sessionsByProject, setSessionsByProject] = useState({});
  const [loadingProjectId, setLoadingProjectId] = useState(null);
  const [selectedSession, setSelectedSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [previewImage, setPreviewImage] = useState(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [docsBusy, setDocsBusy] = useState(false);
  const [docsError, setDocsError] = useState('');
  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [permissionMode, setPermissionMode] = useState('default');
  const [selectedModel, setSelectedModel] = useState(DEFAULT_STATUS.model);
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState(() => {
    const defaultVersion = localStorage.getItem('codexmobile.reasoningDefaultVersion');
    if (defaultVersion !== REASONING_DEFAULT_VERSION) {
      localStorage.setItem('codexmobile.reasoningDefaultVersion', REASONING_DEFAULT_VERSION);
      localStorage.setItem('codexmobile.reasoningEffort', DEFAULT_REASONING_EFFORT);
      return DEFAULT_REASONING_EFFORT;
    }
    return localStorage.getItem('codexmobile.reasoningEffort') || DEFAULT_REASONING_EFFORT;
  });
  const [runningById, setRunningById] = useState({});
  const [theme, setTheme] = useState(() =>
    localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  );
  const [syncing, setSyncing] = useState(false);
  const [connectionState, setConnectionState] = useState(() => (getToken() ? 'connecting' : 'disconnected'));
  const wsRef = useRef(null);
  const selectedProjectRef = useRef(null);
  const selectedSessionRef = useRef(null);
  const runningByIdRef = useRef({});
  const lastLocalRunAtRef = useRef(0);
  const activePollsRef = useRef(new Set());
  const turnRefreshTimersRef = useRef(new Map());
  const voiceDialogRecorderRef = useRef(null);
  const voiceDialogChunksRef = useRef([]);
  const voiceDialogStreamRef = useRef(null);
  const voiceDialogTimerRef = useRef(null);
  const voiceDialogSilenceFrameRef = useRef(null);
  const voiceDialogAudioContextRef = useRef(null);
  const voiceDialogAudioSourceRef = useRef(null);
  const voiceDialogSpeechStartedRef = useRef(false);
  const voiceDialogLastSoundAtRef = useRef(0);
  const voiceDialogAudioRef = useRef(null);
  const voiceDialogAudioUnlockedRef = useRef(false);
  const voiceDialogAudioUrlRef = useRef('');
  const voiceDialogAwaitingTurnRef = useRef(null);
  const voiceDialogLastSpokenRef = useRef('');

  function sessionBelongsToProject(session, project) {
    if (!session || !project?.id) {
      return false;
    }
    if (session.projectId) {
      return session.projectId === project.id;
    }
    return Boolean((sessionsByProject[project.id] || []).some((item) => item.id === session.id));
  }

  function resolveSessionForTurn(project) {
    if (!project?.id) {
      return null;
    }

    if (sessionBelongsToProject(selectedSession, project)) {
      return { ...selectedSession, projectId: selectedSession.projectId || project.id };
    }

    const currentSession = selectedSessionRef.current;
    if (sessionBelongsToProject(currentSession, project)) {
      return { ...currentSession, projectId: currentSession.projectId || project.id };
    }

    const projectSessions = sessionsByProject[project.id] || [];
    const byId = new Map(projectSessions.map((session) => [session.id, { ...session, projectId: session.projectId || project.id }]));

    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const sessionId = String(messages[index]?.sessionId || '').trim();
      if (!isUsableSessionId(sessionId)) {
        continue;
      }
      const matched = byId.get(sessionId);
      if (matched) {
        return matched;
      }
    }

    return null;
  }
  const voiceDialogAutoListenRef = useRef(false);
  const voiceDialogOpenRef = useRef(false);
  const voiceDialogStateRef = useRef('idle');
  const voiceDialogRealtimeRef = useRef(false);
  const voiceRealtimeSocketRef = useRef(null);
  const voiceRealtimeStreamRef = useRef(null);
  const voiceRealtimeAudioContextRef = useRef(null);
  const voiceRealtimeAudioSourceRef = useRef(null);
  const voiceRealtimeProcessorRef = useRef(null);
  const voiceRealtimePlaybackContextRef = useRef(null);
  const voiceRealtimePlaybackSourcesRef = useRef(new Set());
  const voiceRealtimePlayheadRef = useRef(0);
  const voiceRealtimeAssistantTextRef = useRef('');
  const voiceRealtimeSpeechStartedRef = useRef(false);
  const voiceRealtimeTurnStartedAtRef = useRef(0);
  const voiceRealtimeLastSoundAtRef = useRef(0);
  const voiceRealtimeAwaitingResponseRef = useRef(false);
  const voiceRealtimeBargeInStartedAtRef = useRef(0);
  const voiceRealtimeSuppressAssistantAudioRef = useRef(false);
  const voiceDialogIdeaBufferRef = useRef([]);
  const voiceDialogHandoffDraftRef = useRef('');
  const [voiceDialogOpen, setVoiceDialogOpen] = useState(false);
  const [voiceDialogState, setVoiceDialogState] = useState('idle');
  const [voiceDialogError, setVoiceDialogError] = useState('');
  const [voiceDialogTranscript, setVoiceDialogTranscript] = useState('');
  const [voiceDialogAssistantText, setVoiceDialogAssistantText] = useState('');
  const [voiceDialogHandoffDraft, setVoiceDialogHandoffDraft] = useState('');

  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    const updateViewport = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const viewport = window.visualViewport;
        const height = Math.round(viewport?.height || window.innerHeight || 0);
        const width = Math.round(viewport?.width || window.innerWidth || 0);
        const layoutHeight = Math.round(document.documentElement.clientHeight || window.innerHeight || 0);
        const keyboardOpen = height > 0 && layoutHeight > 0 && layoutHeight - height > 120;
        if (height > 0) {
          root.style.setProperty('--app-height', `${height}px`);
        }
        if (width > 0) {
          root.style.setProperty('--app-width', `${width}px`);
        }
        root.dataset.keyboard = keyboardOpen ? 'open' : 'closed';
        if (window.scrollX || window.scrollY) {
          window.scrollTo(0, 0);
        }
      });
    };

    updateViewport();
    window.visualViewport?.addEventListener('resize', updateViewport);
    window.visualViewport?.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);

    return () => {
      cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', updateViewport);
      window.visualViewport?.removeEventListener('scroll', updateViewport);
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
      root.style.removeProperty('--app-height');
      root.style.removeProperty('--app-width');
      delete root.dataset.keyboard;
    };
  }, []);

  const running =
    hasRunningKey(runningById, selectedRunKeys(selectedSession)) ||
    messages.some((message) => message.role === 'activity' && (message.status === 'running' || message.status === 'queued'));

  function setVoiceDialogMode(next) {
    voiceDialogStateRef.current = next;
    setVoiceDialogState(next);
  }

  function setVoiceDialogHandoffDraftValue(next) {
    const value = String(next || '');
    voiceDialogHandoffDraftRef.current = value;
    setVoiceDialogHandoffDraft(value);
  }

  function clearVoiceDialogTimer() {
    if (voiceDialogTimerRef.current) {
      window.clearTimeout(voiceDialogTimerRef.current);
      voiceDialogTimerRef.current = null;
    }
  }

  function clearVoiceDialogSilenceDetection() {
    if (voiceDialogSilenceFrameRef.current) {
      window.cancelAnimationFrame(voiceDialogSilenceFrameRef.current);
      voiceDialogSilenceFrameRef.current = null;
    }
    voiceDialogAudioSourceRef.current?.disconnect?.();
    voiceDialogAudioSourceRef.current = null;
    const context = voiceDialogAudioContextRef.current;
    voiceDialogAudioContextRef.current = null;
    if (context && context.state !== 'closed') {
      const closePromise = context.close?.();
      closePromise?.catch?.(() => null);
    }
    voiceDialogSpeechStartedRef.current = false;
    voiceDialogLastSoundAtRef.current = 0;
  }

  function stopVoiceDialogStream() {
    clearVoiceDialogSilenceDetection();
    voiceDialogStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    voiceDialogStreamRef.current = null;
  }

  function setupVoiceDialogSilenceDetection(stream, recorder) {
    clearVoiceDialogSilenceDetection();
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    try {
      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      voiceDialogAudioContextRef.current = context;
      voiceDialogAudioSourceRef.current = source;
      voiceDialogSpeechStartedRef.current = false;

      const samples = new Uint8Array(analyser.fftSize);
      const startedAt = performance.now();
      voiceDialogLastSoundAtRef.current = startedAt;

      const tick = (now) => {
        if (!voiceDialogOpenRef.current || recorder.state !== 'recording') {
          return;
        }

        analyser.getByteTimeDomainData(samples);
        let total = 0;
        for (let index = 0; index < samples.length; index += 1) {
          const value = (samples[index] - 128) / 128;
          total += value * value;
        }
        const level = Math.sqrt(total / samples.length);
        if (level >= VOICE_DIALOG_LEVEL_THRESHOLD) {
          voiceDialogSpeechStartedRef.current = true;
          voiceDialogLastSoundAtRef.current = now;
        }

        const heardSpeech = voiceDialogSpeechStartedRef.current;
        const recordingLongEnough = now - startedAt >= VOICE_DIALOG_MIN_RECORDING_MS;
        const silentLongEnough = now - voiceDialogLastSoundAtRef.current >= VOICE_DIALOG_SILENCE_MS;
        if (heardSpeech && recordingLongEnough && silentLongEnough) {
          setVoiceDialogMode('transcribing');
          recorder.stop();
          return;
        }

        voiceDialogSilenceFrameRef.current = window.requestAnimationFrame(tick);
      };

      const resumePromise = context.resume?.();
      resumePromise?.catch?.(() => null);
      voiceDialogSilenceFrameRef.current = window.requestAnimationFrame(tick);
    } catch {
      clearVoiceDialogSilenceDetection();
    }
  }

  function ensureVoiceDialogAudio() {
    if (!voiceDialogAudioRef.current) {
      const audio = new Audio();
      audio.preload = 'auto';
      audio.playsInline = true;
      voiceDialogAudioRef.current = audio;
    }
    return voiceDialogAudioRef.current;
  }

  function unlockVoiceDialogAudio() {
    if (voiceDialogAudioUnlockedRef.current) {
      return;
    }
    try {
      const audio = ensureVoiceDialogAudio();
      audio.muted = true;
      audio.src = VOICE_DIALOG_SILENCE_AUDIO;
      const playPromise = audio.play();
      playPromise
        ?.then?.(() => {
          audio.pause();
          audio.muted = false;
          audio.removeAttribute('src');
          audio.load?.();
          voiceDialogAudioUnlockedRef.current = true;
        })
        ?.catch?.(() => {
          audio.muted = false;
        });
    } catch {
      voiceDialogAudioUnlockedRef.current = false;
    }
  }

  function clearVoiceDialogAudio({ release = false } = {}) {
    const audio = voiceDialogAudioRef.current;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load?.();
      if (release) {
        voiceDialogAudioRef.current = null;
        voiceDialogAudioUnlockedRef.current = false;
      }
    }
    if (voiceDialogAudioUrlRef.current) {
      URL.revokeObjectURL(voiceDialogAudioUrlRef.current);
      voiceDialogAudioUrlRef.current = '';
    }
    window.speechSynthesis?.cancel?.();
  }

  function stopRealtimePlayback({ release = false } = {}) {
    for (const source of voiceRealtimePlaybackSourcesRef.current) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    voiceRealtimePlaybackSourcesRef.current.clear();
    const context = voiceRealtimePlaybackContextRef.current;
    voiceRealtimePlayheadRef.current = context?.currentTime || 0;
    if (release && context && context.state !== 'closed') {
      context.close?.().catch?.(() => null);
      voiceRealtimePlaybackContextRef.current = null;
      voiceRealtimePlayheadRef.current = 0;
    }
  }

  function stopRealtimeVoiceDialog({ keepPanel = false } = {}) {
    const socket = voiceRealtimeSocketRef.current;
    voiceRealtimeSocketRef.current = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.send(JSON.stringify({ type: 'close' }));
      } catch {
        // Socket may already be closed.
      }
      try {
        socket.close();
      } catch {
        // Socket may already be closed.
      }
    }

    voiceRealtimeProcessorRef.current?.disconnect?.();
    voiceRealtimeProcessorRef.current = null;
    voiceRealtimeAudioSourceRef.current?.disconnect?.();
    voiceRealtimeAudioSourceRef.current = null;
    voiceRealtimeStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    voiceRealtimeStreamRef.current = null;
    const context = voiceRealtimeAudioContextRef.current;
    voiceRealtimeAudioContextRef.current = null;
    if (context && context.state !== 'closed') {
      context.close?.().catch?.(() => null);
    }
    voiceRealtimeAssistantTextRef.current = '';
    voiceRealtimeSpeechStartedRef.current = false;
    voiceRealtimeTurnStartedAtRef.current = 0;
    voiceRealtimeLastSoundAtRef.current = 0;
    voiceRealtimeAwaitingResponseRef.current = false;
    voiceRealtimeBargeInStartedAtRef.current = 0;
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    stopRealtimePlayback({ release: true });
    if (!keepPanel) {
      voiceDialogRealtimeRef.current = false;
    }
  }

  function playRealtimeAudioDelta(delta) {
    if (!delta) {
      return;
    }
    const samples = pcm16Base64ToFloat(delta);
    if (!samples.length) {
      return;
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }
    let context = voiceRealtimePlaybackContextRef.current;
    if (!context || context.state === 'closed') {
      context = new AudioContextCtor();
      voiceRealtimePlaybackContextRef.current = context;
      voiceRealtimePlayheadRef.current = context.currentTime;
    }
    context.resume?.().catch?.(() => null);
    const outputSampleRate = Number(status.voiceRealtime?.outputSampleRate) || REALTIME_VOICE_SAMPLE_RATE;
    const buffer = context.createBuffer(1, samples.length, outputSampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    voiceRealtimePlaybackSourcesRef.current.add(source);
    source.onended = () => {
      voiceRealtimePlaybackSourcesRef.current.delete(source);
      if (
        voiceDialogOpenRef.current &&
        voiceDialogRealtimeRef.current &&
        voiceRealtimePlaybackSourcesRef.current.size === 0 &&
        voiceDialogStateRef.current === 'speaking'
      ) {
        voiceRealtimeAwaitingResponseRef.current = false;
        setVoiceDialogMode('listening');
      }
    };
    const startAt = Math.max(voiceRealtimePlayheadRef.current, context.currentTime + 0.03);
    source.start(startAt);
    voiceRealtimePlayheadRef.current = startAt + buffer.duration;
  }

  function appendVoiceDialogIdeaTranscript(transcript) {
    const text = String(transcript || '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return;
    }
    const buffer = voiceDialogIdeaBufferRef.current;
    if (buffer[buffer.length - 1] === text) {
      return;
    }
    buffer.push(text);
    if (buffer.length > 30) {
      buffer.splice(0, buffer.length - 30);
    }
  }

  function requestVoiceHandoffSummary(triggerText = '') {
    const socket = voiceRealtimeSocketRef.current;
    const transcripts = voiceDialogIdeaBufferRef.current.filter(Boolean);
    if (!transcripts.length) {
      setVoiceDialogErrorBriefly('还没有可整理的语音内容');
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setVoiceDialogErrorBriefly('实时语音连接不可用');
      return;
    }
    stopRealtimePlayback();
    voiceRealtimeSuppressAssistantAudioRef.current = true;
    voiceRealtimeAwaitingResponseRef.current = false;
    voiceRealtimeBargeInStartedAtRef.current = 0;
    voiceRealtimeAssistantTextRef.current = '';
    setVoiceDialogAssistantText('');
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    setVoiceDialogMode('summarizing');
    socket.send(JSON.stringify({
      type: 'voice.handoff.summarize',
      transcripts,
      trigger: triggerText
    }));
  }

  async function startRealtimeMicrophone(socket) {
    if (!window.isSecureContext) {
      throw new Error('请使用 HTTPS 地址');
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('当前浏览器不支持录音');
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      throw new Error('当前浏览器不支持实时音频');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    const context = new AudioContextCtor();
    await context.resume?.().catch?.(() => null);
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(REALTIME_VOICE_BUFFER_SIZE, 1, 1);
    const inputSampleRate = Number(status.voiceRealtime?.inputSampleRate) || REALTIME_VOICE_SAMPLE_RATE;
    const useClientVad = Boolean(status.voiceRealtime?.clientTurnDetection);
    const silenceMs = Number(status.voiceRealtime?.clientVadSilenceMs) || VOICE_DIALOG_SILENCE_MS;
    const commitCurrentTurn = () => {
      if (!voiceRealtimeSpeechStartedRef.current || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      voiceRealtimeSpeechStartedRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      voiceRealtimeAwaitingResponseRef.current = true;
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      setVoiceDialogMode('waiting');
      socket.send(JSON.stringify({ type: 'input_audio.commit' }));
    };
    const beginBargeIn = () => {
      voiceRealtimeSuppressAssistantAudioRef.current = true;
      socket.send(JSON.stringify({ type: 'response.cancel' }));
      socket.send(JSON.stringify({ type: 'input_audio.clear' }));
      stopRealtimePlayback();
      voiceRealtimeAwaitingResponseRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      voiceRealtimeAssistantTextRef.current = '';
      setVoiceDialogAssistantText('');
      setVoiceDialogMode('listening');
    };
    processor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      output.fill(0);
      if (
        !voiceDialogOpenRef.current ||
        !voiceDialogRealtimeRef.current ||
        socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (voiceDialogStateRef.current === 'summarizing' || voiceDialogStateRef.current === 'handoff') {
        return;
      }
      const input = event.inputBuffer.getChannelData(0);
      const downsampled = downsampleAudio(input, context.sampleRate, inputSampleRate);
      if (!useClientVad) {
        socket.send(JSON.stringify({
          type: 'input_audio.append',
          audio: floatToPcm16Base64(downsampled)
        }));
        return;
      }

      const now = performance.now();
      const level = audioLevel(downsampled);
      const hasSound = level >= VOICE_DIALOG_LEVEL_THRESHOLD;
      if (voiceRealtimeAwaitingResponseRef.current) {
        const playbackActive =
          voiceRealtimePlaybackSourcesRef.current.size > 0 ||
          voiceDialogStateRef.current === 'speaking';
        if (playbackActive) {
          const bargeInCandidate = level >= REALTIME_VOICE_BARGE_IN_LEVEL_THRESHOLD;
          if (!bargeInCandidate) {
            voiceRealtimeBargeInStartedAtRef.current = 0;
            return;
          }
          if (!voiceRealtimeBargeInStartedAtRef.current) {
            voiceRealtimeBargeInStartedAtRef.current = now;
            return;
          }
          if (now - voiceRealtimeBargeInStartedAtRef.current < REALTIME_VOICE_BARGE_IN_SUSTAIN_MS) {
            return;
          }
          beginBargeIn();
        } else if (hasSound) {
          beginBargeIn();
        } else {
          voiceRealtimeBargeInStartedAtRef.current = 0;
          return;
        }
      }

      if (hasSound) {
        if (!voiceRealtimeSpeechStartedRef.current) {
          voiceRealtimeSpeechStartedRef.current = true;
          voiceRealtimeTurnStartedAtRef.current = now;
          setVoiceDialogMode('listening');
        }
        voiceRealtimeLastSoundAtRef.current = now;
      }

      if (!voiceRealtimeSpeechStartedRef.current) {
        return;
      }

      socket.send(JSON.stringify({
        type: 'input_audio.append',
        audio: floatToPcm16Base64(downsampled)
      }));

      const turnLongEnough = now - voiceRealtimeTurnStartedAtRef.current >= REALTIME_VOICE_MIN_TURN_MS;
      const silentLongEnough = now - voiceRealtimeLastSoundAtRef.current >= silenceMs;
      if (turnLongEnough && silentLongEnough) {
        commitCurrentTurn();
      }
    };

    source.connect(processor);
    processor.connect(context.destination);
    voiceRealtimeStreamRef.current = stream;
    voiceRealtimeAudioContextRef.current = context;
    voiceRealtimeAudioSourceRef.current = source;
    voiceRealtimeProcessorRef.current = processor;
  }

  function handleRealtimeVoiceEvent(payload) {
    if (!voiceDialogOpenRef.current || !voiceDialogRealtimeRef.current) {
      return;
    }
    if (payload.type === 'voice.realtime.connecting') {
      setVoiceDialogMode('waiting');
      return;
    }
    if (payload.type === 'voice.realtime.ready') {
      const socket = voiceRealtimeSocketRef.current;
      if (!socket || voiceRealtimeStreamRef.current) {
        setVoiceDialogMode('listening');
        return;
      }
      startRealtimeMicrophone(socket)
        .then(() => {
          setVoiceDialogError('');
          setVoiceDialogMode('listening');
        })
        .catch((error) => {
          setVoiceDialogErrorBriefly(error.message || '实时语音启动失败');
          stopRealtimeVoiceDialog({ keepPanel: true });
        });
      return;
    }
    if (payload.type === 'voice.realtime.cancel_ignored') {
      voiceRealtimeAwaitingResponseRef.current = false;
      voiceRealtimeBargeInStartedAtRef.current = 0;
      setVoiceDialogError('');
      setVoiceDialogMode('listening');
      return;
    }
    if (payload.type === 'voice.handoff.summarizing') {
      stopRealtimePlayback();
      voiceRealtimeSuppressAssistantAudioRef.current = true;
      voiceRealtimeAssistantTextRef.current = '';
      setVoiceDialogAssistantText('');
      setVoiceDialogError('');
      setVoiceDialogMode('summarizing');
      return;
    }
    if (payload.type === 'voice.handoff.summary_delta') {
      return;
    }
    if (payload.type === 'voice.handoff.summary_done') {
      const draft = String(payload.message || payload.rawText || '').trim();
      if (!draft) {
        setVoiceDialogErrorBriefly('没有整理出可交给 Codex 的任务');
        return;
      }
      setVoiceDialogHandoffDraftValue(draft);
      setVoiceDialogAssistantText('');
      setVoiceDialogError(payload.parsed ? '' : '整理结果不是标准 JSON，已作为草稿保留');
      setVoiceDialogMode('handoff');
      return;
    }
    if (payload.type === 'voice.handoff.summary_error') {
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      setVoiceDialogErrorBriefly(payload.error || '语音任务整理失败');
      return;
    }
    if (payload.type === 'response.created') {
      if (voiceDialogStateRef.current === 'summarizing' || voiceDialogStateRef.current === 'handoff') {
        return;
      }
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      voiceRealtimeAwaitingResponseRef.current = true;
      return;
    }
    if (payload.type === 'voice.realtime.error' || payload.type === 'error') {
      if (isBenignRealtimeCancelError(payload)) {
        voiceRealtimeAwaitingResponseRef.current = false;
        voiceRealtimeBargeInStartedAtRef.current = 0;
        setVoiceDialogError('');
        setVoiceDialogMode('listening');
        return;
      }
      const message = payload.error?.message || payload.error || '实时语音连接失败';
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogErrorBriefly(message);
      stopRealtimeVoiceDialog({ keepPanel: true });
      return;
    }
    if (payload.type === 'input_audio_buffer.speech_started') {
      stopRealtimePlayback();
      voiceRealtimeAssistantTextRef.current = '';
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogAssistantText('');
      setVoiceDialogMode('listening');
      return;
    }
    if (payload.type === 'input_audio_buffer.speech_stopped') {
      setVoiceDialogMode('waiting');
      return;
    }
    if (
      payload.type === 'conversation.item.input_audio_transcription.completed' &&
      payload.transcript
    ) {
      const transcript = String(payload.transcript || '').trim();
      setVoiceDialogTranscript(transcript);
      if (isVoiceHandoffCommand(transcript)) {
        requestVoiceHandoffSummary(transcript);
        return;
      }
      appendVoiceDialogIdeaTranscript(transcript);
      return;
    }
    if (
      (payload.type === 'response.audio_transcript.delta' ||
        payload.type === 'response.output_audio_transcript.delta') &&
      payload.delta
    ) {
      if (voiceRealtimeSuppressAssistantAudioRef.current) {
        return;
      }
      voiceRealtimeAssistantTextRef.current += payload.delta;
      setVoiceDialogAssistantText(voiceRealtimeAssistantTextRef.current.trim());
      return;
    }
    if (
      (payload.type === 'response.audio.delta' ||
        payload.type === 'response.output_audio.delta') &&
      payload.delta
    ) {
      if (voiceRealtimeSuppressAssistantAudioRef.current) {
        return;
      }
      voiceRealtimeAwaitingResponseRef.current = true;
      setVoiceDialogMode('speaking');
      playRealtimeAudioDelta(payload.delta);
      return;
    }
    if (
      payload.type === 'response.done' &&
      voiceDialogStateRef.current !== 'summarizing' &&
      voiceDialogStateRef.current !== 'handoff' &&
      voiceRealtimePlaybackSourcesRef.current.size === 0
    ) {
      voiceRealtimeSuppressAssistantAudioRef.current = false;
      voiceRealtimeAwaitingResponseRef.current = false;
      setVoiceDialogMode('listening');
    }
  }

  function startRealtimeVoiceDialog() {
    if (!status.voiceRealtime?.configured) {
      setVoiceDialogErrorBriefly('未配置实时语音');
      return;
    }
    if (voiceRealtimeSocketRef.current) {
      return;
    }
    clearVoiceDialogAudio();
    stopRealtimeVoiceDialog({ keepPanel: true });
    voiceDialogRealtimeRef.current = true;
    voiceRealtimeAssistantTextRef.current = '';
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('waiting');

    const socket = new WebSocket(realtimeVoiceWebsocketUrl());
    voiceRealtimeSocketRef.current = socket;
    socket.onopen = () => {
      setVoiceDialogMode('waiting');
    };
    socket.onmessage = (event) => {
      try {
        handleRealtimeVoiceEvent(JSON.parse(event.data));
      } catch {
        // Ignore malformed proxy events.
      }
    };
    socket.onerror = () => {
      setVoiceDialogErrorBriefly('实时语音连接失败');
      stopRealtimeVoiceDialog({ keepPanel: true });
    };
    socket.onclose = () => {
      if (voiceDialogOpenRef.current && voiceDialogRealtimeRef.current) {
        stopRealtimeVoiceDialog({ keepPanel: true });
        setVoiceDialogMode('idle');
      }
    };
  }

  function voiceDialogMimeType() {
    if (!window.MediaRecorder?.isTypeSupported) {
      return '';
    }
    return VOICE_MIME_CANDIDATES.find((type) => window.MediaRecorder.isTypeSupported(type)) || '';
  }

  function setVoiceDialogErrorBriefly(message) {
    setVoiceDialogError(message);
    setVoiceDialogMode('error');
  }

  async function transcribeVoiceDialogBlob(blob) {
    if (!blob?.size) {
      throw new Error('没有录到声音');
    }
    if (blob.size > VOICE_MAX_UPLOAD_BYTES) {
      throw new Error('录音超过 10MB');
    }

    const formData = new FormData();
    const extension = blob.type.includes('mp4') ? 'm4a' : 'webm';
    formData.append('audio', blob, `voice-dialog.${extension}`);
    const result = await apiFetch('/api/voice/transcribe', {
      method: 'POST',
      body: formData
    });
    const text = String(result.text || '').trim();
    if (!text) {
      throw new Error('没有识别到文字');
    }
    return text;
  }

  function playAudioBlob(blob) {
    return new Promise((resolve, reject) => {
      clearVoiceDialogAudio();
      const url = URL.createObjectURL(blob);
      const audio = ensureVoiceDialogAudio();
      voiceDialogAudioUrlRef.current = url;
      audio.muted = false;
      audio.src = url;
      audio.playsInline = true;
      audio.onended = () => {
        voiceDialogAudioUnlockedRef.current = true;
        resolve();
      };
      audio.onerror = () => reject(new Error('播放失败'));
      audio.load?.();
      audio.play().catch(reject);
    });
  }

  function speakWithBrowser(text) {
    return new Promise((resolve, reject) => {
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        reject(new Error('当前浏览器不支持朗读'));
        return;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = resolve;
      utterance.onerror = () => reject(new Error('朗读失败'));
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  function scheduleNextVoiceDialogTurn() {
    if (!voiceDialogOpenRef.current || !voiceDialogAutoListenRef.current) {
      setVoiceDialogMode('idle');
      return;
    }
    setVoiceDialogMode('idle');
    window.setTimeout(() => {
      if (voiceDialogOpenRef.current && voiceDialogAutoListenRef.current) {
        startVoiceDialogRecording();
      }
    }, 220);
  }

  async function playVoiceDialogReply(message) {
    const text = spokenReplyText(message?.content);
    if (!text) {
      scheduleNextVoiceDialogTurn();
      return;
    }

    setVoiceDialogAssistantText(text);
    setVoiceDialogError('');
    setVoiceDialogMode('speaking');

    try {
      const blob = await apiBlobFetch('/api/voice/speech', {
        method: 'POST',
        body: { text }
      });
      await playAudioBlob(blob);
    } catch (error) {
      try {
        await speakWithBrowser(text);
      } catch {
        setVoiceDialogError(error.message || '朗读失败');
      }
    } finally {
      clearVoiceDialogAudio();
      scheduleNextVoiceDialogTurn();
    }
  }

  async function startVoiceDialogRecording() {
    if (voiceDialogRealtimeRef.current) {
      startRealtimeVoiceDialog();
      return;
    }
    if (!voiceDialogOpenRef.current) {
      return;
    }
    if (['transcribing', 'sending', 'waiting', 'speaking'].includes(voiceDialogStateRef.current)) {
      return;
    }
    clearVoiceDialogTimer();
    clearVoiceDialogAudio();
    unlockVoiceDialogAudio();
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');

    if (!selectedProjectRef.current && !selectedProject) {
      setVoiceDialogErrorBriefly('请先选择项目');
      return;
    }
    if (!window.isSecureContext) {
      setVoiceDialogErrorBriefly('请使用 HTTPS 地址');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setVoiceDialogErrorBriefly('当前浏览器不支持录音');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = voiceDialogMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceDialogStreamRef.current = stream;
      voiceDialogChunksRef.current = [];
      voiceDialogRecorderRef.current = recorder;
      setupVoiceDialogSilenceDetection(stream, recorder);

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          voiceDialogChunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        clearVoiceDialogTimer();
        stopVoiceDialogStream();
        voiceDialogRecorderRef.current = null;
        setVoiceDialogErrorBriefly('录音失败');
      };
      recorder.onstop = async () => {
        clearVoiceDialogTimer();
        stopVoiceDialogStream();
        const recordedType = recorder.mimeType || mimeType || 'audio/webm';
        const blob = new Blob(voiceDialogChunksRef.current, { type: recordedType });
        voiceDialogChunksRef.current = [];
        voiceDialogRecorderRef.current = null;

        try {
          setVoiceDialogMode('transcribing');
          const transcript = await transcribeVoiceDialogBlob(blob);
          setVoiceDialogTranscript(transcript);
          setVoiceDialogMode('sending');
          const turn = await handleVoiceSubmit(transcript);
          voiceDialogAwaitingTurnRef.current = {
            turnId: turn?.turnId,
            message: transcript,
            startedAt: Date.now()
          };
          setVoiceDialogMode('waiting');
        } catch (error) {
          voiceDialogAwaitingTurnRef.current = null;
          setVoiceDialogErrorBriefly(error.message || '语音对话失败');
        }
      };

      recorder.start();
      setVoiceDialogMode('listening');
      voiceDialogTimerRef.current = window.setTimeout(() => {
        if (voiceDialogRecorderRef.current?.state === 'recording') {
          setVoiceDialogMode('transcribing');
          voiceDialogRecorderRef.current.stop();
        }
      }, VOICE_MAX_RECORDING_MS);
    } catch (error) {
      clearVoiceDialogTimer();
      stopVoiceDialogStream();
      voiceDialogRecorderRef.current = null;
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      setVoiceDialogErrorBriefly(denied ? '麦克风权限被拒绝' : '录音启动失败');
    }
  }

  function stopVoiceDialogRecording() {
    if (voiceDialogRealtimeRef.current) {
      stopRealtimeVoiceDialog({ keepPanel: true });
      setVoiceDialogMode('idle');
      return;
    }
    if (voiceDialogRecorderRef.current?.state === 'recording') {
      setVoiceDialogError('');
      setVoiceDialogMode('transcribing');
      voiceDialogRecorderRef.current.stop();
      return;
    }
    clearVoiceDialogTimer();
    stopVoiceDialogStream();
    setVoiceDialogMode('idle');
  }

  function continueVoiceHandoffCollection() {
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    setVoiceDialogAssistantText('');
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    setVoiceDialogMode('listening');
  }

  function cancelVoiceHandoffConfirmation() {
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogError('');
    voiceRealtimeSuppressAssistantAudioRef.current = false;
    setVoiceDialogMode('listening');
  }

  async function submitVoiceHandoffToCodex() {
    const message = voiceDialogHandoffDraftRef.current.trim();
    if (!message) {
      return;
    }
    if (!selectedProjectRef.current && !selectedProject) {
      setVoiceDialogError('请先选择项目');
      setVoiceDialogMode('handoff');
      return;
    }
    try {
      setVoiceDialogError('');
      setVoiceDialogMode('sending');
      await submitCodexMessage({ message });
      voiceDialogIdeaBufferRef.current = [];
      setVoiceDialogHandoffDraftValue('');
      closeVoiceDialog();
    } catch (error) {
      setVoiceDialogError(error.message || '发送给 Codex 失败');
      setVoiceDialogMode('handoff');
    }
  }

  function openVoiceDialog() {
    unlockVoiceDialogAudio();
    voiceDialogOpenRef.current = true;
    voiceDialogRealtimeRef.current = Boolean(status.voiceRealtime?.configured);
    voiceDialogAutoListenRef.current = !voiceDialogRealtimeRef.current;
    voiceDialogAwaitingTurnRef.current = null;
    voiceDialogIdeaBufferRef.current = [];
    setVoiceDialogHandoffDraftValue('');
    setVoiceDialogOpen(true);
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('idle');
    window.setTimeout(() => {
      if (voiceDialogOpenRef.current) {
        if (voiceDialogRealtimeRef.current) {
          startRealtimeVoiceDialog();
        } else {
          startVoiceDialogRecording();
        }
      }
    }, 80);
  }

  function closeVoiceDialog() {
    voiceDialogAutoListenRef.current = false;
    voiceDialogOpenRef.current = false;
    voiceDialogAwaitingTurnRef.current = null;
    voiceDialogIdeaBufferRef.current = [];
    setVoiceDialogHandoffDraftValue('');
    stopRealtimeVoiceDialog();
    if (voiceDialogRecorderRef.current?.state === 'recording') {
      voiceDialogRecorderRef.current.onstop = null;
      voiceDialogRecorderRef.current.stop();
    }
    voiceDialogRecorderRef.current = null;
    clearVoiceDialogTimer();
    stopVoiceDialogStream();
    clearVoiceDialogAudio({ release: true });
    setVoiceDialogOpen(false);
    setVoiceDialogError('');
    setVoiceDialogTranscript('');
    setVoiceDialogAssistantText('');
    setVoiceDialogMode('idle');
  }

  function markRun(payload) {
    const keys = payloadRunKeys(payload);
    if (!keys.length) {
      return;
    }
    lastLocalRunAtRef.current = Date.now();
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        next[key] = true;
      }
      runningByIdRef.current = next;
      return next;
    });
  }

  function clearRun(payload) {
    const keys = payloadRunKeys(payload);
    if (!keys.length) {
      return;
    }
    setRunningById((current) => {
      const next = { ...current };
      for (const key of keys) {
        delete next[key];
      }
      runningByIdRef.current = next;
      return next;
    });
  }

  function syncActiveRunsFromStatus(nextStatus) {
    const activeRuns = Array.isArray(nextStatus?.activeRuns) ? nextStatus.activeRuns : [];

    if (!activeRuns.length) {
      setMessages((current) => {
        const hasRecentLocalRun = Date.now() - lastLocalRunAtRef.current < 15000;
        if (activePollsRef.current.size || turnRefreshTimersRef.current.size || hasRecentLocalRun) {
          return current;
        }
        return current.filter(
          (message) => !(message.role === 'activity' && (message.status === 'running' || message.status === 'queued'))
        );
      });
      return;
    }

    const nextRunning = {};
    for (const run of activeRuns) {
      for (const key of payloadRunKeys(run)) {
        nextRunning[key] = true;
      }
    }
    const shouldPreserveLocalRuns =
      activePollsRef.current.size > 0 ||
      turnRefreshTimersRef.current.size > 0 ||
      Date.now() - lastLocalRunAtRef.current < 15000;
    setRunningById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRunning } : nextRunning;
      runningByIdRef.current = next;
      return next;
    });
  }

  function payloadMatchesCurrentConversation(payload) {
    const current = selectedSessionRef.current;
    if (!current) {
      return true;
    }
    const keys = payloadRunKeys(payload);
    return keys.includes(current.id) || keys.includes(current.turnId);
  }

  function clearTurnRefreshTimer(turnId) {
    if (!turnId) {
      return;
    }
    const timer = turnRefreshTimersRef.current.get(turnId);
    if (timer) {
      window.clearTimeout(timer);
      turnRefreshTimersRef.current.delete(turnId);
    }
  }

  async function refreshMessagesForPayload(payload) {
    if (!payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return false;
    }
    try {
      const data = await apiFetch(`/api/sessions/${encodeURIComponent(payload.sessionId)}/messages?limit=120`);
      if (data.messages?.length && hasVisibleAssistantForTurn(data.messages, payload)) {
        setMessages(data.messages);
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  function finalizeTurnWithoutAssistant(payload) {
    if (!payload?.turnId) {
      return;
    }
    clearTurnRefreshTimer(payload.turnId);
    setMessages((current) =>
      upsertStatusMessage(current, {
        ...payload,
        status: 'completed',
        label: '任务已完成',
        detail: payload.error || payload.detail || ''
      })
    );
    clearRun(payload);
  }

  function markTurnCompleted(payload, detail = '结果同步中') {
    if (!payload?.turnId) {
      return;
    }
    setMessages((current) => {
      if (hasAssistantMessageForTurn(current, payload)) {
        return removeActivityMessagesForTurn(current, payload);
      }
      return upsertStatusMessage(current, {
        ...payload,
        kind: 'turn',
        status: 'running',
        label: '正在思考中',
        detail
      });
    });
  }

  function scheduleTurnRefresh(payload, attempt = 0) {
    const turnId = payload?.turnId;
    if (!turnId || !payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return;
    }
    clearTurnRefreshTimer(turnId);
    const delays = [300, 800, 1500, 2500, 4000, 6500, 10000, 15000, 22000, 30000, 30000];
    const delay = delays[attempt];
    if (delay === undefined) {
      finalizeTurnWithoutAssistant(payload);
      return;
    }

    const timer = window.setTimeout(async () => {
      if (!payloadMatchesCurrentConversation(payload)) {
        return;
      }
      const loaded = await refreshMessagesForPayload(payload);
      if (loaded) {
        clearTurnRefreshTimer(turnId);
        clearRun(payload);
        return;
      }
      scheduleTurnRefresh(payload, attempt + 1);
    }, delay);
    turnRefreshTimersRef.current.set(turnId, timer);
  }

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

  useEffect(() => () => closeVoiceDialog(), []);

  useEffect(
    () => () => {
      for (const timer of turnRefreshTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      turnRefreshTimersRef.current.clear();
    },
    []
  );

  useEffect(() => {
    const awaiting = voiceDialogAwaitingTurnRef.current;
    if (!voiceDialogOpen || !awaiting?.turnId || voiceDialogStateRef.current !== 'waiting') {
      return;
    }
    if (runningById[awaiting.turnId]) {
      return;
    }

    const reversed = [...messages].reverse();
    let reply = reversed.find(
      (message) =>
        message.role === 'assistant' &&
        message.turnId === awaiting.turnId &&
        String(message.content || '').trim()
    );

    if (!reply) {
      let userIndex = -1;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (
          message.role === 'user' &&
          (message.turnId === awaiting.turnId || String(message.content || '').trim() === awaiting.message)
        ) {
          userIndex = index;
          break;
        }
      }
      if (userIndex >= 0) {
        reply = [...messages.slice(userIndex + 1)].reverse().find(
          (message) => message.role === 'assistant' && String(message.content || '').trim()
        );
      }
    }

    const speechText = spokenReplyText(reply?.content);
    if (!reply || !speechText) {
      return;
    }

    const speechKey = `${awaiting.turnId}:${reply.id}:${speechText.length}`;
    if (voiceDialogLastSpokenRef.current === speechKey) {
      return;
    }
    voiceDialogLastSpokenRef.current = speechKey;
    voiceDialogAwaitingTurnRef.current = null;
    playVoiceDialogReply(reply);
  }, [messages, runningById, voiceDialogOpen]);

  useEffect(() => {
    localStorage.setItem(THEME_KEY, theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (selectedReasoningEffort) {
      localStorage.setItem('codexmobile.reasoningEffort', selectedReasoningEffort);
    }
  }, [selectedReasoningEffort]);

  useEffect(() => {
    if (status.model && selectedModel === DEFAULT_STATUS.model) {
      setSelectedModel(status.model);
    }
  }, [selectedModel, status.model]);

  useEffect(() => {
    const saved = localStorage.getItem('codexmobile.reasoningEffort');
    if (!saved && status.reasoningEffort && !selectedReasoningEffort) {
      setSelectedReasoningEffort(status.reasoningEffort);
    }
  }, [selectedReasoningEffort, status.reasoningEffort]);

  const loadStatus = useCallback(async () => {
    const data = await apiFetch('/api/status');
    setStatus(data);
    setAuthenticated(Boolean(data.auth?.authenticated));
    syncActiveRunsFromStatus(data);
    return data;
  }, []);

  const loadSessions = useCallback(async (project, chooseLatest = true) => {
    if (!project) {
      setSelectedSession(null);
      setMessages([]);
      return;
    }
    setLoadingProjectId(project.id);
    try {
      const data = await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`);
      const nextSessions = (data.sessions || []).map((session) => ({
        ...session,
        projectId: session.projectId || project.id
      }));
      setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));
      if (chooseLatest) {
        const next = nextSessions[0] || null;
        setSelectedSession(next);
        if (next) {
          const messageData = await apiFetch(`/api/sessions/${encodeURIComponent(next.id)}/messages?limit=120`);
          setMessages(messageData.messages || []);
        } else {
          setMessages([]);
        }
      } else {
        setSelectedSession(null);
        setMessages([]);
      }
    } finally {
      setLoadingProjectId((current) => (current === project.id ? null : current));
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const data = await apiFetch('/api/projects');
    const list = data.projects || [];
    setProjects(list);
    const preferred =
      list.find((project) => project.name.toLowerCase() === 'codexmobile') ||
      list.find((project) => project.path.toLowerCase().includes('codexmobile')) ||
      list[0] ||
      null;
    setSelectedProject(preferred);
    if (preferred) {
      setExpandedProjectIds((current) => ({ ...current, [preferred.id]: true }));
    }
    await loadSessions(preferred);
  }, [loadSessions]);

  const bootstrap = useCallback(async () => {
    try {
      const currentStatus = await loadStatus();
      if (currentStatus.auth?.authenticated) {
        await loadProjects();
        setSyncing(true);
        apiFetch('/api/sync', { method: 'POST' })
          .then(async () => {
            await loadStatus();
            await loadProjects();
          })
          .catch(() => null)
          .finally(() => setSyncing(false));
      }
    } catch (error) {
      if (String(error.message).includes('Pairing')) {
        clearToken();
        setAuthenticated(false);
      }
    }
  }, [loadProjects, loadStatus]);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!authenticated || !getToken()) {
      setConnectionState('disconnected');
      return undefined;
    }

    let stopped = false;
    let reconnectTimer = null;

    const connect = () => {
      setConnectionState('connecting');
      const ws = new WebSocket(websocketUrl());
      wsRef.current = ws;

      ws.onopen = () => setConnectionState('connecting');
      ws.onclose = () => {
        setConnectionState('disconnected');
        if (!stopped) {
          reconnectTimer = window.setTimeout(connect, 1200);
        }
      };
      ws.onerror = () => setConnectionState('disconnected');
      ws.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      if (payload.type === 'connected') {
        setStatus(payload.status || DEFAULT_STATUS);
        setConnectionState(payload.status?.connected ? 'connected' : 'disconnected');
        syncActiveRunsFromStatus(payload.status || DEFAULT_STATUS);
        return;
      }
      if (payload.type === 'chat-started') {
        markRun(payload);
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        if (!selectedSessionRef.current && payload.sessionId) {
          setSelectedSession({ id: payload.sessionId, projectId: payload.projectId, title: '新对话' });
        }
        return;
      }
      if (payload.type === 'thread-started' && payload.sessionId) {
        const projectId = payload.projectId || selectedProjectRef.current?.id || selectedSessionRef.current?.projectId;
        const currentSession = selectedSessionRef.current;
        const nextSession = {
          ...(currentSession || {}),
          id: payload.sessionId,
          projectId,
          title: currentSession?.title || '新对话',
          updatedAt: new Date().toISOString(),
          draft: false
        };
        markRun(payload);
        setSelectedSession((current) => {
          if (!current) {
            return nextSession;
          }
          const shouldReplace =
            current.id === payload.previousSessionId ||
            current.id === payload.sessionId ||
            current.turnId === payload.turnId ||
            (current.draft && current.projectId === projectId);
          return shouldReplace ? { ...current, ...nextSession } : current;
        });
        setSessionsByProject((current) =>
          upsertSessionInProject(current, projectId, nextSession, payload.previousSessionId)
        );
        setMessages((current) =>
          current.map((message) =>
            message.turnId === payload.turnId || message.sessionId === payload.previousSessionId
              ? { ...message, sessionId: payload.sessionId }
              : message
          )
        );
        return;
      }
      if (payload.type === 'message-deleted') {
        if (payloadMatchesCurrentConversation(payload)) {
          setMessages((current) => current.filter((message) => String(message.id) !== String(payload.messageId)));
        }
        return;
      }
      if (payload.type === 'user-message') {
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        setMessages((current) => {
          const alreadyShown = current.some(
            (message) => message.role === 'user' && message.content === payload.message.content
          );
          if (alreadyShown) {
            return current;
          }
          return [...current, payload.message];
        });
        return;
      }
      if (payload.type === 'assistant-update') {
        if (!payload.content?.trim()) {
          return;
        }
        markRun(payload);
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        if (payload.phase === 'commentary' || payload.kind === 'agent_message') {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              kind: payload.kind || 'agent_message',
              label: briefActivityLabel(payload.content),
              status: payload.status || 'running'
            })
          );
          return;
        }
        if (!payload.done) {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              kind: payload.kind || 'message',
              label: '正在整理回复',
              status: payload.status || 'running'
            })
          );
          return;
        }
        setMessages((current) => upsertAssistantMessage(current, payload));
        return;
      }
      if (payload.type === 'status-update') {
        if (payload.status === 'running' || payload.status === 'queued') {
          markRun(payload);
        }
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        if (payload.kind === 'turn' && payload.status === 'completed') {
          markTurnCompleted(payload);
          return;
        }
        setMessages((current) => upsertStatusMessage(current, payload));
        return;
      }
      if (payload.type === 'activity-update') {
        if (payload.status === 'running' || payload.status === 'queued') {
          markRun(payload);
        }
        if (!payloadMatchesCurrentConversation(payload)) {
          return;
        }
        setMessages((current) => upsertActivityMessage(current, payload));
        return;
      }
      if (payload.type === 'chat-complete' || payload.type === 'chat-error' || payload.type === 'chat-aborted') {
      if (!payloadMatchesCurrentConversation(payload)) {
          clearRun(payload);
          return;
        }
        if (payload.type === 'chat-complete') {
          markTurnCompleted(payload);
          scheduleTurnRefresh(payload);
          return;
        }
        clearRun(payload);
        if (payload.type === 'chat-error' && payload.error) {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              status: 'failed',
              label: '任务失败',
              detail: payload.error
            })
          );
        } else if (payload.type === 'chat-aborted') {
          setMessages((current) =>
            upsertStatusMessage(current, {
              ...payload,
              status: 'completed',
              label: '已中止'
            })
          );
        }
        return;
      }
      if (payload.type === 'sync-complete' && payload.projects) {
        setProjects(payload.projects);
        const project = selectedProjectRef.current;
        if (project?.id) {
          apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
            .then((data) => {
              const nextSessions = (data.sessions || []).map((session) => ({
                ...session,
                projectId: session.projectId || project.id
              }));
              setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));
            })
            .catch(() => null);
        }
      }
      };
    };

    connect();

    return () => {
      stopped = true;
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
      }
      wsRef.current?.close();
      setConnectionState('disconnected');
    };
  }, [authenticated]);

  async function handleSync() {
    setSyncing(true);
    try {
      await apiFetch('/api/sync', { method: 'POST' });
      await loadStatus();
      await loadProjects();
    } finally {
      setSyncing(false);
    }
  }

  async function handleToggleProject(project) {
    const isExpanded = Boolean(expandedProjectIds[project.id]);
    if (isExpanded) {
      setExpandedProjectIds((current) => {
        const next = { ...current };
        delete next[project.id];
        return next;
      });
      return;
    }

    setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    const projectChanged = selectedProject?.id !== project.id;
    setSelectedProject(project);
    if (projectChanged) {
      setSelectedSession(null);
      setMessages([]);
    }
    if (!sessionsByProject[project.id]) {
      await loadSessions(project, false);
    }
  }

  async function handleSelectSession(project, session) {
    const projectForSession =
      project ||
      projects.find((item) => item.id === session?.projectId) ||
      selectedProjectRef.current;
    const nextSession = {
      ...session,
      projectId: session?.projectId || projectForSession?.id || null
    };
    if (projectForSession) {
      setSelectedProject(projectForSession);
      setExpandedProjectIds((current) => ({ ...current, [projectForSession.id]: true }));
    }
    setSelectedSession(nextSession);
    if (isDraftSession(nextSession)) {
      setMessages([]);
      setDrawerOpen(false);
      return;
    }
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(nextSession.id)}/messages?limit=120`);
    setMessages(data.messages || []);
    setDrawerOpen(false);
  }

  async function refreshProjectSessions(project) {
    if (!project?.id) {
      return;
    }
    const [projectData, sessionData] = await Promise.all([
      apiFetch('/api/projects'),
      apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`)
    ]);
    const nextProjects = projectData.projects || [];
    const nextSessions = (sessionData.sessions || []).map((session) => ({
      ...session,
      projectId: session.projectId || project.id
    }));
    setProjects(nextProjects);
    setSessionsByProject((current) => ({ ...current, [project.id]: nextSessions }));
    const nextSelectedProject = nextProjects.find((item) => item.id === selectedProjectRef.current?.id);
    if (nextSelectedProject) {
      setSelectedProject(nextSelectedProject);
    }
  }

  async function handleRenameSession(project, session) {
    if (!project?.id || !session?.id) {
      return;
    }

    const currentTitle = session.title || '对话';
    const nextTitle = window.prompt('重命名线程', currentTitle)?.trim().slice(0, 52);
    if (!nextTitle || nextTitle === currentTitle) {
      return;
    }

    const applyLocalTitle = () => {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).map((item) =>
          item.id === session.id ? { ...item, title: nextTitle, titleLocked: true } : item
        )
      }));
      if (selectedSessionRef.current?.id === session.id) {
        setSelectedSession((current) => (current ? { ...current, title: nextTitle, titleLocked: true } : current));
      }
    };

    if (isDraftSession(session)) {
      applyLocalTitle();
      return;
    }

    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'PATCH',
        body: { title: nextTitle }
      });
      applyLocalTitle();
      await refreshProjectSessions(project);
    } catch (error) {
      window.alert(`重命名失败：${error.message}`);
    }
  }

  async function handleDeleteSession(project, session) {
    if (!project?.id || !session?.id) {
      return;
    }

    const title = session.title || '\u5bf9\u8bdd';
    const confirmed = window.confirm(
      `\u4ece CodexMobile \u9690\u85cf\u7ebf\u7a0b\u201c${title}\u201d\uff1f\u4e0d\u4f1a\u5f71\u54cd Codex App \u7684\u539f\u59cb\u4f1a\u8bdd\u3002`
    );
    if (!confirmed) {
      return;
    }

    const removeLocalSession = () => {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).filter((item) => item.id !== session.id)
      }));
      if (selectedSessionRef.current?.id === session.id) {
        setSelectedSession(null);
        setMessages([]);
        setAttachments([]);
        setInput('');
      }
    };

    if (isDraftSession(session)) {
      removeLocalSession();
      return;
    }

    try {
      await apiFetch(`/api/projects/${encodeURIComponent(project.id)}/sessions/${encodeURIComponent(session.id)}`, {
        method: 'DELETE'
      });
      removeLocalSession();
      await refreshProjectSessions(project);
    } catch (error) {
      const message = String(error.message || '');
      window.alert(
        message.toLowerCase().includes('running')
          ? '\u7ebf\u7a0b\u6b63\u5728\u8fd0\u884c\uff0c\u7a0d\u540e\u518d\u5220\u9664\u3002'
          : `\u5220\u9664\u5931\u8d25\uff1a${message}`
      );
    }
  }

  async function handleDeleteMessage(message) {
    if (!message?.id) {
      return;
    }
    if (!window.confirm('删除这条消息？')) {
      return;
    }

    const messageId = String(message.id);
    const sessionId = selectedSessionRef.current?.id || message.sessionId || '';
    const existingIndex = messages.findIndex((item) => String(item.id) === messageId);
    const removedMessage = existingIndex >= 0 ? messages[existingIndex] : message;
    setMessages((current) => current.filter((item) => String(item.id) !== messageId));

    if (!sessionId || isDraftSession({ id: sessionId })) {
      return;
    }

    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
        { method: 'DELETE' }
      );
    } catch (error) {
      setMessages((current) => {
        if (current.some((item) => String(item.id) === messageId)) {
          return current;
        }
        const next = [...current];
        const insertAt = existingIndex >= 0 ? Math.min(existingIndex, next.length) : next.length;
        next.splice(insertAt, 0, removedMessage);
        return next;
      });
      window.alert(`删除失败：${error.message}`);
    }
  }

  function handleNewConversation() {
    const project = selectedProject || projects[0];
    if (!project) {
      return;
    }
    const draft = createDraftSession(project);
    setSelectedProject(project);
    setSelectedSession(draft);
    setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
    setSessionsByProject((current) => upsertSessionInProject(current, project.id, draft));
    setMessages([]);
    setAttachments([]);
    setDrawerOpen(false);
  }

  async function handleUploadFiles(files) {
    setUploading(true);
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append('file', file);
        const result = await apiFetch('/api/uploads', {
          method: 'POST',
          body: formData
        });
        setAttachments((current) => [...current, result.upload]);
      }
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `upload-error-${Date.now()}`,
          role: 'activity',
          content: error.message,
          timestamp: new Date().toISOString()
        }
      ]);
    } finally {
      setUploading(false);
    }
  }

  function handleRemoveAttachment(id) {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  }

  function turnMatchesCurrentSelection(turnId, optimisticSessionId, realSessionId, previousSessionId) {
    const current = selectedSessionRef.current;
    if (!current) {
      return true;
    }
    return (
      current.id === optimisticSessionId ||
      current.id === realSessionId ||
      current.id === previousSessionId ||
      current.turnId === turnId ||
      current.draft
    );
  }

  function applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId) {
    const sessionIdText = String(turn.sessionId || '');
    const realSessionId =
      sessionIdText && !sessionIdText.startsWith('draft-') && !sessionIdText.startsWith('codex-')
        ? sessionIdText
        : null;
    if (!realSessionId) {
      return null;
    }

    const currentSession = selectedSessionRef.current;
    const nextSession = {
      ...(currentSession || {}),
      id: realSessionId,
      projectId,
      title: currentSession?.title || '新对话',
      updatedAt: turn.completedAt || turn.updatedAt || new Date().toISOString(),
      draft: false
    };

    setSelectedSession((current) => {
      if (!current) {
        return nextSession;
      }
      if (!turnMatchesCurrentSelection(turn.turnId, optimisticSessionId, realSessionId, previousSessionId)) {
        return current;
      }
      return { ...current, ...nextSession };
    });
    setSessionsByProject((current) =>
      upsertSessionInProject(current, projectId, nextSession, previousSessionId || optimisticSessionId)
    );
    setMessages((current) =>
      current.map((message) =>
        message.turnId === turn.turnId || message.sessionId === optimisticSessionId || message.sessionId === previousSessionId
          ? { ...message, sessionId: realSessionId }
          : message
      )
    );
    return realSessionId;
  }

  async function loadTurnMessages(realSessionId, turnId, optimisticSessionId, previousSessionId) {
    if (!realSessionId) {
      return false;
    }
    const current = selectedSessionRef.current;
    if (
      current &&
      current.id !== realSessionId &&
      current.id !== optimisticSessionId &&
      current.id !== previousSessionId &&
      current.turnId !== turnId
    ) {
      return false;
    }
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(realSessionId)}/messages?limit=120`);
    if (data.messages?.length && hasVisibleAssistantForTurn(data.messages, { turnId })) {
      setMessages(data.messages);
      return true;
    }
    return false;
  }

  async function pollTurnUntilComplete({ turnId, optimisticSessionId, projectId, previousSessionId }) {
    if (!turnId || activePollsRef.current.has(turnId)) {
      return;
    }
    activePollsRef.current.add(turnId);
    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < 1800000) {
        await new Promise((resolve) => window.setTimeout(resolve, 1400));
        let turn = null;
        try {
          const result = await apiFetch(`/api/chat/turns/${encodeURIComponent(turnId)}`);
          turn = result.turn;
        } catch {
          continue;
        }
        if (!turn) {
          continue;
        }

        const realSessionId = applyTurnSession(turn, optimisticSessionId, projectId, previousSessionId);
        if (turn.status === 'failed') {
          clearRun({ turnId, sessionId: realSessionId || optimisticSessionId, previousSessionId });
          setMessages((current) =>
            upsertStatusMessage(current, {
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              kind: 'turn',
              status: 'failed',
              label: '任务失败',
              detail: turn.error || turn.detail || '任务失败'
            })
          );
          break;
        }
        if (turn.status === 'aborted') {
          clearRun({ turnId, sessionId: realSessionId || optimisticSessionId, previousSessionId });
          setMessages((current) =>
            upsertStatusMessage(current, {
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              kind: 'turn',
              status: 'completed',
              label: '已中止'
            })
          );
          break;
        }
        if (turn.status === 'completed') {
          const terminalPayload = {
            sessionId: realSessionId || optimisticSessionId,
            turnId,
            previousSessionId,
            detail: turn.detail || ''
          };
          markTurnCompleted(terminalPayload);
          const loaded = await loadTurnMessages(realSessionId, turnId, optimisticSessionId, previousSessionId);
          if (loaded) {
            clearRun(terminalPayload);
          } else {
            scheduleTurnRefresh({
              sessionId: realSessionId || optimisticSessionId,
              turnId,
              previousSessionId,
              hadAssistantText: turn.hadAssistantText || Boolean(turn.assistantPreview),
              usage: turn.usage || null
            });
          }
          break;
        }
      }
    } finally {
      activePollsRef.current.delete(turnId);
    }
  }

  async function submitCodexMessage({
    message,
    attachmentsForTurn = [],
    clearComposer = false,
    restoreTextOnError = false
  }) {
    const project = selectedProject || selectedProjectRef.current;
    const selectedAttachments = Array.isArray(attachmentsForTurn) ? attachmentsForTurn : [];
    const displayMessage = String(message || '').trim() || (selectedAttachments.length ? '请查看附件。' : '');
    if ((!displayMessage && !selectedAttachments.length) || !project) {
      if (restoreTextOnError && displayMessage) {
        restoreVoiceTextToInput(displayMessage);
      }
      throw new Error(project ? 'message or attachments are required' : '请先选择项目');
    }

    let sessionForTurn = resolveSessionForTurn(project);
    if (!sessionForTurn) {
      sessionForTurn = createDraftSession(project);
      setSelectedSession(sessionForTurn);
      setExpandedProjectIds((current) => ({ ...current, [project.id]: true }));
      setSessionsByProject((current) => upsertSessionInProject(current, project.id, sessionForTurn));
    } else if (selectedSessionRef.current?.id !== sessionForTurn.id) {
      setSelectedSession(sessionForTurn);
    }

    const turnId = createClientTurnId();
    const draftSessionId = isDraftSession(sessionForTurn) ? sessionForTurn.id : null;
    const outgoingSessionId = draftSessionId ? null : sessionForTurn?.id || null;
    const optimisticSessionId = draftSessionId || outgoingSessionId || turnId;
    const initialTitle = draftSessionId && !sessionForTurn.titleLocked
      ? titleFromFirstMessage(displayMessage)
      : null;

    if (clearComposer) {
      setInput('');
      setAttachments([]);
    }

    markRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
    setSelectedSession((current) =>
      current?.id === sessionForTurn?.id
        ? { ...current, turnId, ...(initialTitle ? { title: initialTitle, titleLocked: true } : {}) }
        : current
    );
    if (initialTitle) {
      setSessionsByProject((current) => ({
        ...current,
        [project.id]: (current[project.id] || []).map((item) =>
          item.id === sessionForTurn.id ? { ...item, title: initialTitle, titleLocked: true } : item
        )
      }));
    }
    setMessages((current) =>
      upsertStatusMessage(
        [
          ...current,
          {
            id: `local-${Date.now()}`,
            role: 'user',
            content: displayMessage,
            timestamp: new Date().toISOString(),
            sessionId: optimisticSessionId,
            turnId
          }
        ],
        {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'reasoning',
          status: 'running',
          label: '正在思考中',
          timestamp: new Date().toISOString()
        }
      )
    );

    try {
      const result = await apiFetch('/api/chat/send', {
        method: 'POST',
        body: {
          projectId: project.id,
          sessionId: outgoingSessionId,
          draftSessionId,
          clientTurnId: turnId,
          message: displayMessage,
          permissionMode,
          model: selectedModel || status.model,
          reasoningEffort: selectedReasoningEffort || status.reasoningEffort || DEFAULT_REASONING_EFFORT,
          attachments: selectedAttachments
        }
      });
      pollTurnUntilComplete({
        turnId: result.turnId || turnId,
        optimisticSessionId,
        projectId: project.id,
        previousSessionId: draftSessionId || outgoingSessionId
      });
      return {
        turnId: result.turnId || turnId,
        optimisticSessionId,
        projectId: project.id,
        previousSessionId: draftSessionId || outgoingSessionId
      };
    } catch (error) {
      clearRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
      if (clearComposer) {
        setAttachments(selectedAttachments);
      }
      if (restoreTextOnError) {
        restoreVoiceTextToInput(displayMessage);
      }
      setMessages((current) =>
        upsertStatusMessage(current, {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'turn',
          status: 'failed',
          label: '发送失败',
          detail: error.message,
          timestamp: new Date().toISOString()
        })
      );
      throw error;
    }
  }

  async function handleSubmit() {
    const message = input.trim();
    if ((!message && !attachments.length) || !selectedProject) {
      return;
    }
    try {
      await submitCodexMessage({
        message,
        attachmentsForTurn: attachments,
        clearComposer: true
      });
    } catch {
      // submitCodexMessage already reflects the failure in the chat UI.
    }
    return;
    let sessionForTurn = selectedSession;
    if (!sessionForTurn) {
      sessionForTurn = createDraftSession(selectedProject);
      setSelectedSession(sessionForTurn);
      setExpandedProjectIds((current) => ({ ...current, [selectedProject.id]: true }));
      setSessionsByProject((current) => upsertSessionInProject(current, selectedProject.id, sessionForTurn));
    }
    const turnId = createClientTurnId();
    const draftSessionId = isDraftSession(sessionForTurn) ? sessionForTurn.id : null;
    const outgoingSessionId = draftSessionId ? null : sessionForTurn?.id || null;
    const optimisticSessionId = draftSessionId || outgoingSessionId || turnId;
    const selectedAttachments = attachments;
    const initialTitle = draftSessionId && !sessionForTurn.titleLocked
      ? titleFromFirstMessage(message || '查看附件')
      : null;
    const displayMessage = message || '请查看附件。';
    setInput('');
    setAttachments([]);
    markRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
    setSelectedSession((current) =>
      current?.id === sessionForTurn?.id
        ? { ...current, turnId, ...(initialTitle ? { title: initialTitle, titleLocked: true } : {}) }
        : current
    );
    if (initialTitle) {
      setSessionsByProject((current) => ({
        ...current,
        [selectedProject.id]: (current[selectedProject.id] || []).map((item) =>
          item.id === sessionForTurn.id ? { ...item, title: initialTitle, titleLocked: true } : item
        )
      }));
    }
    setMessages((current) => [
      ...current,
      {
        id: `local-${Date.now()}`,
        role: 'user',
        content: displayMessage,
        timestamp: new Date().toISOString(),
        sessionId: optimisticSessionId,
        turnId
      }
    ]);
    try {
      const result = await apiFetch('/api/chat/send', {
        method: 'POST',
        body: {
          projectId: selectedProject.id,
          sessionId: outgoingSessionId,
          draftSessionId,
          clientTurnId: turnId,
          message: displayMessage,
          permissionMode,
          model: selectedModel || status.model,
          reasoningEffort: selectedReasoningEffort || status.reasoningEffort || DEFAULT_REASONING_EFFORT,
          attachments: selectedAttachments
        }
      });
      pollTurnUntilComplete({
        turnId: result.turnId || turnId,
        optimisticSessionId,
        projectId: selectedProject.id,
        previousSessionId: draftSessionId || outgoingSessionId
      });
    } catch (error) {
      clearRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
      setAttachments(selectedAttachments);
      setMessages((current) =>
        upsertStatusMessage(current, {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'turn',
          status: 'failed',
          label: '发送失败',
          detail: error.message,
          timestamp: new Date().toISOString()
        })
      );
    }
  }

  function restoreVoiceTextToInput(text) {
    const value = String(text || '').trim();
    if (!value) {
      return;
    }
    setInput((current) => {
      const base = String(current || '').trimEnd();
      if (!base) {
        return value;
      }
      if (base.includes(value)) {
        return current;
      }
      return `${base}\n${value}`;
    });
  }

  async function handleVoiceSubmit(transcript) {
    const message = String(transcript || '').trim();
    if (!message) {
      throw new Error('没有识别到文字');
    }
    return submitCodexMessage({
      message,
      attachmentsForTurn: [],
      restoreTextOnError: true
    });
    if (!selectedProject) {
      restoreVoiceTextToInput(message);
      throw new Error('请先选择项目');
    }

    let sessionForTurn = selectedSession;
    if (!sessionForTurn) {
      sessionForTurn = createDraftSession(selectedProject);
      setSelectedSession(sessionForTurn);
      setExpandedProjectIds((current) => ({ ...current, [selectedProject.id]: true }));
      setSessionsByProject((current) => upsertSessionInProject(current, selectedProject.id, sessionForTurn));
    }

    const turnId = createClientTurnId();
    const draftSessionId = isDraftSession(sessionForTurn) ? sessionForTurn.id : null;
    const outgoingSessionId = draftSessionId ? null : sessionForTurn?.id || null;
    const optimisticSessionId = draftSessionId || outgoingSessionId || turnId;
    const displayMessage = message;
    const initialTitle = draftSessionId && !sessionForTurn.titleLocked
      ? titleFromFirstMessage(displayMessage)
      : null;

    markRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
    setSelectedSession((current) =>
      current?.id === sessionForTurn?.id
        ? { ...current, turnId, ...(initialTitle ? { title: initialTitle, titleLocked: true } : {}) }
        : current
    );
    if (initialTitle) {
      setSessionsByProject((current) => ({
        ...current,
        [selectedProject.id]: (current[selectedProject.id] || []).map((item) =>
          item.id === sessionForTurn.id ? { ...item, title: initialTitle, titleLocked: true } : item
        )
      }));
    }
    setMessages((current) => [
      ...current,
      {
        id: `local-${Date.now()}`,
        role: 'user',
        content: displayMessage,
        timestamp: new Date().toISOString(),
        sessionId: optimisticSessionId,
        turnId
      }
    ]);

    try {
      const result = await apiFetch('/api/chat/send', {
        method: 'POST',
        body: {
          projectId: selectedProject.id,
          sessionId: outgoingSessionId,
          draftSessionId,
          clientTurnId: turnId,
          message: displayMessage,
          permissionMode,
          model: selectedModel || status.model,
          reasoningEffort: selectedReasoningEffort || status.reasoningEffort || DEFAULT_REASONING_EFFORT,
          attachments: []
        }
      });
      pollTurnUntilComplete({
        turnId: result.turnId || turnId,
        optimisticSessionId,
        projectId: selectedProject.id,
        previousSessionId: draftSessionId || outgoingSessionId
      });
      return {
        turnId: result.turnId || turnId,
        optimisticSessionId,
        projectId: selectedProject.id,
        previousSessionId: draftSessionId || outgoingSessionId
      };
    } catch (error) {
      clearRun({ turnId, sessionId: optimisticSessionId, previousSessionId: draftSessionId || outgoingSessionId });
      restoreVoiceTextToInput(displayMessage);
      setMessages((current) =>
        upsertStatusMessage(current, {
          sessionId: optimisticSessionId,
          turnId,
          kind: 'turn',
          status: 'failed',
          label: '发送失败',
          detail: error.message,
          timestamp: new Date().toISOString()
        })
      );
      throw error;
    }
  }

  async function handleAbort() {
    const abortId =
      selectedSessionRef.current?.id ||
      selectedSessionRef.current?.turnId ||
      Object.keys(runningById)[0];
    if (!abortId) {
      return;
    }
    await apiFetch('/api/chat/abort', {
      method: 'POST',
      body: { sessionId: abortId, turnId: selectedSessionRef.current?.turnId || null }
    }).catch(() => null);
    clearRun({ sessionId: abortId, turnId: selectedSessionRef.current?.turnId || null });
  }

  async function handleConnectDocs() {
    if (docsBusy) {
      return;
    }
    setDocsBusy(true);
    setDocsError('');
    try {
      const result = await apiFetch('/api/feishu/cli/auth/start', { method: 'POST' });
      if (result.docs) {
        setStatus((current) => ({ ...current, docs: result.docs }));
      }
      if (!result.verificationUrl) {
        throw new Error('没有收到飞书授权地址');
      }
      window.location.assign(result.verificationUrl);
    } catch (error) {
      setDocsError(error.message || '飞书连接失败');
      setDocsBusy(false);
    }
  }

  async function handleDisconnectDocs() {
    if (docsBusy) {
      return;
    }
    setDocsBusy(true);
    setDocsError('');
    try {
      await apiFetch('/api/feishu/cli/auth/logout', { method: 'POST' });
      await loadStatus();
    } catch (error) {
      setDocsError(error.message || '断开飞书失败');
    } finally {
      setDocsBusy(false);
    }
  }

  async function handleRefreshDocs() {
    if (docsBusy) {
      return;
    }
    setDocsBusy(true);
    setDocsError('');
    try {
      await loadStatus();
    } catch (error) {
      setDocsError(error.message || '刷新飞书状态失败');
    } finally {
      setDocsBusy(false);
    }
  }

  function handleOpenDocsHome() {
    const docsUrl = String(status.docs?.homeUrl || 'https://docs.feishu.cn/').trim();
    if (docsUrl) {
      window.location.assign(docsUrl);
    }
  }

  function handleOpenDocsAuth(url) {
    const authUrl = String(url || '').trim();
    if (authUrl) {
      window.location.assign(authUrl);
    }
  }

  const shellClass = useMemo(() => (drawerOpen ? 'app-shell drawer-active' : 'app-shell'), [drawerOpen]);

  if (!authenticated) {
    return <PairingScreen onPaired={bootstrap} />;
  }

  return (
    <div className={shellClass}>
      <TopBar
        selectedProject={selectedProject}
        connectionState={connectionState}
        onMenu={() => setDrawerOpen(true)}
        onOpenDocs={() => setDocsOpen(true)}
      />
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        projects={projects}
        selectedProject={selectedProject}
        selectedSession={selectedSession}
        expandedProjectIds={expandedProjectIds}
        sessionsByProject={sessionsByProject}
        loadingProjectId={loadingProjectId}
        onToggleProject={handleToggleProject}
        onSelectSession={handleSelectSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        onNewConversation={handleNewConversation}
        onSync={handleSync}
        syncing={syncing}
        theme={theme}
        setTheme={setTheme}
      />
      <DocsPanel
        open={docsOpen}
        docs={status.docs}
        busy={docsBusy}
        error={docsError}
        onClose={() => setDocsOpen(false)}
        onConnect={handleConnectDocs}
        onDisconnect={handleDisconnectDocs}
        onOpenHome={handleOpenDocsHome}
        onOpenAuth={handleOpenDocsAuth}
        onRefresh={handleRefreshDocs}
      />
      <ChatPane
        messages={messages}
        selectedSession={selectedSession}
        running={running}
        onPreviewImage={setPreviewImage}
        onDeleteMessage={handleDeleteMessage}
      />
      <VoiceDialogPanel
        open={voiceDialogOpen}
        state={voiceDialogState}
        error={voiceDialogError}
        transcript={voiceDialogTranscript}
        assistantText={voiceDialogAssistantText}
        handoffDraft={voiceDialogHandoffDraft}
        onHandoffDraftChange={setVoiceDialogHandoffDraftValue}
        onHandoffSubmit={submitVoiceHandoffToCodex}
        onHandoffContinue={continueVoiceHandoffCollection}
        onHandoffCancel={cancelVoiceHandoffConfirmation}
        onStart={startVoiceDialogRecording}
        onStop={stopVoiceDialogRecording}
        onClose={closeVoiceDialog}
      />
      <Composer
        input={input}
        setInput={setInput}
        onSubmit={handleSubmit}
        running={running}
        onAbort={handleAbort}
        models={status.models}
        selectedModel={selectedModel}
        onSelectModel={setSelectedModel}
        selectedReasoningEffort={selectedReasoningEffort}
        onSelectReasoningEffort={setSelectedReasoningEffort}
        permissionMode={permissionMode}
        onSelectPermission={setPermissionMode}
        attachments={attachments}
        onUploadFiles={handleUploadFiles}
        onRemoveAttachment={handleRemoveAttachment}
        uploading={uploading}
        onVoiceSubmit={handleVoiceSubmit}
        onOpenVoiceDialog={openVoiceDialog}
        voiceDialogActive={voiceDialogOpen}
      />
      <ImagePreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />
    </div>
  );
}
