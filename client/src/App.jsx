import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Folder,
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
  Wifi,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, clearToken, getToken, setToken, websocketUrl } from './api.js';

const DEFAULT_STATUS = {
  connected: false,
  provider: 'cliproxyapi',
  model: 'gpt-5.5',
  modelShort: '5.5 中',
  reasoningEffort: 'xhigh',
  models: [{ value: 'gpt-5.5', label: 'gpt-5.5' }],
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

function statusMessageId(payload) {
  return `status-${payload.turnId || payload.sessionId || 'current'}`;
}

function upsertStatusMessage(current, payload) {
  const id = statusMessageId(payload);
  const existingIndex = current.findIndex((message) => message.id === id);
  const previous = existingIndex >= 0 ? current[existingIndex] : null;
  const detail =
    payload.kind === 'reasoning'
      ? previous?.detail || ''
      : payload.detail || previous?.detail || '';
  const nextMessage = {
    id,
    role: 'activity',
    turnId: payload.turnId || previous?.turnId || null,
    sessionId: payload.sessionId || previous?.sessionId || null,
    content: payload.label || previous?.content || '正在处理',
    label: payload.label || previous?.label || '正在处理',
    detail,
    kind: payload.kind || previous?.kind || 'turn',
    status: payload.status || previous?.status || 'running',
    timestamp: payload.timestamp || previous?.timestamp || new Date().toISOString(),
    activities: previous?.activities || []
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
  const activity = {
    id: payload.messageId || `${id}-${payload.kind || 'activity'}`,
    kind: payload.kind || 'activity',
    label: payload.label || '工具调用',
    status: payload.status || 'running',
    detail: payload.detail || payload.command || payload.output || payload.error || '',
    command: payload.command || '',
    output: payload.output || '',
    error: payload.error || '',
    fileChanges: payload.fileChanges || [],
    timestamp: payload.timestamp || new Date().toISOString()
  };
  const activities = [...(previous?.activities || [])];
  const activityIndex = activities.findIndex((item) => item.id === activity.id);
  if (activityIndex >= 0) {
    activities[activityIndex] = activity;
  } else {
    activities.push(activity);
  }

  const nextMessage = {
    id,
    role: 'activity',
    turnId: payload.turnId || previous?.turnId || null,
    sessionId: payload.sessionId || previous?.sessionId || null,
    content: payload.label || previous?.content || '正在处理',
    label: payload.label || previous?.label || '正在处理',
    detail: payload.detail || previous?.detail || activity.detail || '',
    kind: payload.kind || previous?.kind || 'activity',
    status: payload.status || previous?.status || 'running',
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
  if (hasVisibleAssistantForTurn(current, payload)) {
    return current.filter((message) => message.id !== id);
  }

  return upsertStatusMessage(current, {
    ...payload,
    status: 'completed',
    label: '任务已完成，未返回文本内容',
    detail: payload.usage ? `tokens: ${JSON.stringify(payload.usage)}` : ''
  });
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
                              onClick={() => onSelectSession(session)}
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
              内容同步
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

function TopBar({ selectedProject, connectionState, onMenu }) {
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
    </header>
  );
}

function ActivityMessage({ message }) {
  const [expanded, setExpanded] = useState(false);
  const running = message.status === 'running' || message.status === 'queued';
  const failed = message.status === 'failed';
  const activities = message.activities || [];
  const hasDetails = Boolean(message.detail || activities.length);

  return (
    <div className="message-row is-activity">
      <div className={`message-bubble activity-bubble ${failed ? 'is-failed' : ''}`}>
        <button
          type="button"
          className="activity-summary"
          onClick={() => hasDetails && setExpanded((current) => !current)}
          disabled={!hasDetails}
        >
          {running ? <Loader2 className="spin" size={15} /> : failed ? <X size={15} /> : <Check size={15} />}
          <span>{message.label || message.content || '正在处理'}</span>
          {hasDetails ? <ChevronDown className={expanded ? 'is-expanded' : ''} size={15} /> : null}
        </button>
        {expanded && hasDetails ? (
          <div className="activity-detail">
            {message.detail ? <pre>{message.detail}</pre> : null}
            {activities.map((activity) => (
              <div key={activity.id} className="activity-item">
                <strong>{activity.label}</strong>
                {activity.detail ? <pre>{activity.detail}</pre> : null}
                {activity.command ? <code>{activity.command}</code> : null}
                {activity.output ? <pre>{activity.output}</pre> : null}
                {activity.fileChanges?.length ? (
                  <ul>
                    {activity.fileChanges.map((change, index) => (
                      <li key={`${activity.id}-${index}`}>{`${change.kind || 'update'} ${change.path}`}</li>
                    ))}
                  </ul>
                ) : null}
                {activity.error ? <em>{activity.error}</em> : null}
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
    return <div className="message-content">{text}</div>;
  }

  return (
    <div className="message-content">
      {parts.map((part, index) =>
        part.type === 'image' ? (
          <GeneratedImage key={`${part.url}-${index}`} part={part} onPreviewImage={onPreviewImage} />
        ) : (
          <span key={`text-${index}`}>{part.value}</span>
        )
      )}
    </div>
  );
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
  const hasRunningActivity = messages.some((message) => message.role === 'activity' && message.status === 'running');

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
      {running && !hasRunningActivity ? (
        <div className="message-row is-activity">
          <div className="message-bubble">
            <Loader2 className="spin" size={16} />
            正在处理
          </div>
        </div>
      ) : null}
      <div ref={bottomRef} />
    </section>
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
  onVoiceSubmit
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
        if (activePollsRef.current.size || hasRecentLocalRun) {
          return current;
        }
        let changed = false;
        const next = current.map((message) => {
          if (message.role === 'activity' && (message.status === 'running' || message.status === 'queued')) {
            changed = true;
            return {
              ...message,
              status: 'completed',
              label: '没有正在运行的任务，请重新发送',
              content: '没有正在运行的任务，请重新发送',
              detail: message.detail || '后端当前没有运行中的任务'
            };
          }
          return message;
        });
        return changed ? next : current;
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
      activePollsRef.current.size > 0 || Date.now() - lastLocalRunAtRef.current < 15000;
    setRunningById((current) => {
      const next = shouldPreserveLocalRuns ? { ...current, ...nextRunning } : nextRunning;
      runningByIdRef.current = next;
      return next;
    });
    setMessages((current) => {
      let next = current;
      for (const run of activeRuns) {
        if (payloadMatchesCurrentConversation(run)) {
          next = upsertStatusMessage(next, {
            ...run,
            status: run.status || 'running',
            label: run.label || '正在处理'
          });
        }
      }
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

  async function refreshMessagesForPayload(payload) {
    if (!payload?.sessionId || !payloadMatchesCurrentConversation(payload)) {
      return false;
    }
    try {
      const data = await apiFetch(`/api/sessions/${encodeURIComponent(payload.sessionId)}/messages?limit=120`);
      if (data.messages?.length) {
        setMessages(data.messages);
        return hasVisibleAssistantForTurn(data.messages, payload);
      }
    } catch {
      return false;
    }
    return false;
  }

  useEffect(() => {
    selectedProjectRef.current = selectedProject;
  }, [selectedProject]);

  useEffect(() => {
    selectedSessionRef.current = selectedSession;
  }, [selectedSession]);

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
      const nextSessions = data.sessions || [];
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
        setMessages((current) =>
          upsertStatusMessage(current, {
            ...payload,
            status: 'running',
            label: '正在思考'
          })
        );
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
        setMessages((current) => {
          const existingIndex = current.findIndex((message) => message.id === payload.messageId);
          const nextMessage = {
            id: payload.messageId,
            role: 'assistant',
            content: payload.content,
            timestamp: new Date().toISOString(),
            turnId: payload.turnId || null,
            sessionId: payload.sessionId || null,
            kind: payload.kind
          };
          if (existingIndex >= 0) {
            const next = [...current];
            next[existingIndex] = nextMessage;
            return next;
          }
          return [...current, nextMessage];
        });
        return;
      }
      if (payload.type === 'status-update') {
        if (payload.status === 'running' || payload.status === 'queued') {
          markRun(payload);
        }
        if (!payloadMatchesCurrentConversation(payload)) {
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
          if (payload.hadAssistantText) {
            setMessages((current) =>
              hasVisibleAssistantForTurn(current, payload)
                ? completeStatusMessage(current, payload)
                : upsertStatusMessage(current, {
                    ...payload,
                    status: 'running',
                    label: '正在同步最终回复'
                  })
            );
            refreshMessagesForPayload(payload).then((loaded) => {
              if (!loaded) {
                setMessages((current) => completeStatusMessage(current, payload));
              }
              clearRun(payload);
            });
            return;
          }
          setMessages((current) => completeStatusMessage(current, payload));
          clearRun(payload);
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
              setSessionsByProject((current) => ({ ...current, [project.id]: data.sessions || [] }));
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

  async function handleSelectSession(session) {
    setSelectedSession(session);
    if (isDraftSession(session)) {
      setMessages([]);
      setDrawerOpen(false);
      return;
    }
    const data = await apiFetch(`/api/sessions/${encodeURIComponent(session.id)}/messages?limit=120`);
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
    setProjects(nextProjects);
    setSessionsByProject((current) => ({ ...current, [project.id]: sessionData.sessions || [] }));
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
      `\u6c38\u4e45\u5220\u9664\u7ebf\u7a0b\u201c${title}\u201d\uff1f\u5220\u9664\u540e Codex App \u4e2d\u4e5f\u4e0d\u4f1a\u518d\u663e\u793a\u3002`
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
    if (data.messages?.length) {
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
          const loaded = await loadTurnMessages(realSessionId, turnId, optimisticSessionId, previousSessionId);
          if (!loaded) {
            setMessages((current) =>
              completeStatusMessage(current, {
                type: 'chat-complete',
                sessionId: realSessionId || optimisticSessionId,
                turnId,
                hadAssistantText: turn.hadAssistantText || Boolean(turn.assistantPreview),
                usage: turn.usage || null
              })
            );
          }
          clearRun({ turnId, sessionId: realSessionId || optimisticSessionId, previousSessionId });
          break;
        }

        if (turn.label || turn.detail) {
          setMessages((current) =>
            upsertStatusMessage(current, {
              sessionId: realSessionId || turn.sessionId || optimisticSessionId,
              turnId,
              kind: turn.kind || 'turn',
              status: turn.status || 'running',
              label: turn.label || '正在思考',
              detail: turn.detail || ''
            })
          );
        }
      }
    } finally {
      activePollsRef.current.delete(turnId);
    }
  }

  async function handleSubmit() {
    const message = input.trim();
    if ((!message && !attachments.length) || !selectedProject) {
      return;
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
          label: '正在思考',
          timestamp: new Date().toISOString()
        }
      )
    );
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
          label: '正在思考',
          timestamp: new Date().toISOString()
        }
      )
    );

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

  const shellClass = useMemo(() => (drawerOpen ? 'app-shell drawer-active' : 'app-shell'), [drawerOpen]);

  if (!authenticated) {
    return <PairingScreen onPaired={bootstrap} />;
  }

  return (
    <div className={shellClass}>
      <TopBar selectedProject={selectedProject} connectionState={connectionState} onMenu={() => setDrawerOpen(true)} />
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
      <ChatPane
        messages={messages}
        selectedSession={selectedSession}
        running={running}
        onPreviewImage={setPreviewImage}
        onDeleteMessage={handleDeleteMessage}
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
      />
      <ImagePreviewModal image={previewImage} onClose={() => setPreviewImage(null)} />
    </div>
  );
}
