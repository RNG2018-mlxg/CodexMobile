import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { CODEX_SESSION_INDEX, CODEX_SESSIONS_DIR, readCodexConfig, readCodexWorkspaceState } from './codex-config.js';
import {
  deleteMobileSession,
  readMobileSessionIndex,
  readMobileSessionMessages,
  readMobileSessions,
  renameMobileSession
} from './mobile-session-index.js';

const DELETED_MESSAGES_PATH = path.join(process.cwd(), '.codexmobile', 'state', 'deleted-messages.json');

let cache = {
  syncedAt: null,
  config: null,
  projects: [],
  projectById: new Map(),
  sessionsByProject: new Map(),
  sessionById: new Map()
};

function emptyDeletedMessagesState() {
  return { version: 1, sessions: {} };
}

async function readDeletedMessagesState() {
  try {
    const raw = await fs.readFile(DELETED_MESSAGES_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      sessions: parsed && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
        ? parsed.sessions
        : {}
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read deleted message state:', error.message);
    }
    return emptyDeletedMessagesState();
  }
}

async function writeDeletedMessagesState(state) {
  await fs.mkdir(path.dirname(DELETED_MESSAGES_PATH), { recursive: true });
  await fs.writeFile(
    DELETED_MESSAGES_PATH,
    JSON.stringify({ version: 1, sessions: state.sessions || {} }, null, 2),
    'utf8'
  );
}

async function readDeletedMessageIds(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) {
    return new Set();
  }
  const state = await readDeletedMessagesState();
  return new Set(Object.keys(state.sessions?.[id] || {}));
}

function filterDeletedMessages(messages, deletedIds) {
  if (!deletedIds.size) {
    return messages;
  }
  return messages.filter((message) => !deletedIds.has(String(message.id || '')));
}

export function normalizeComparablePath(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function projectIdFor(projectPath) {
  return crypto.createHash('sha1').update(normalizeComparablePath(projectPath)).digest('hex').slice(0, 16);
}

function displayNameFor(projectPath) {
  const parsed = path.parse(projectPath);
  return path.basename(projectPath) || parsed.root || projectPath;
}

function isInsideDirectory(filePath, rootDir) {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toPublicProject(entry) {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    trusted: entry.trusted,
    updatedAt: entry.updatedAt,
    sessionCount: entry.sessionCount || 0
  };
}

async function walkJsonlFiles(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('agent-')) {
        files.push(fullPath);
      }
    }
  }
  await walk(dir);
  return files;
}

async function readSessionNameIndex() {
  const index = new Map();
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item.id && item.thread_name) {
          index.set(item.id, {
            title: item.thread_name,
            updatedAt: item.updated_at || null
          });
        }
      } catch {
        // Skip malformed index rows.
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[sessions] Failed to read session index:', error.message);
    }
  }
  return index;
}

async function deleteSessionNameIndexRows(sessionId) {
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
    const nextLines = [];
    let changed = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item?.id === sessionId) {
          changed = true;
          continue;
        }
      } catch {
        // Preserve malformed rows.
      }
      nextLines.push(line);
    }
    if (changed) {
      await fs.writeFile(CODEX_SESSION_INDEX, nextLines.length ? `${nextLines.join('\n')}\n` : '', 'utf8');
    }
    return changed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function renameSessionNameIndexRow(sessionId, title, updatedAt) {
  try {
    const raw = await fs.readFile(CODEX_SESSION_INDEX, 'utf8');
    const nextLines = [];
    let changed = false;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const item = JSON.parse(line);
        if (item?.id === sessionId) {
          item.thread_name = title;
          item.updated_at = item.updated_at || updatedAt || new Date().toISOString();
          nextLines.push(JSON.stringify(item));
          changed = true;
          continue;
        }
      } catch {
        // Preserve malformed rows.
      }
      nextLines.push(line);
    }
    if (!changed) {
      nextLines.push(JSON.stringify({
        id: sessionId,
        thread_name: title,
        updated_at: updatedAt || new Date().toISOString()
      }));
    }
    await fs.writeFile(CODEX_SESSION_INDEX, `${nextLines.join('\n')}\n`, 'utf8');
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(
        CODEX_SESSION_INDEX,
        `${JSON.stringify({
          id: sessionId,
          thread_name: title,
          updated_at: updatedAt || new Date().toISOString()
        })}\n`,
        'utf8'
      );
      return true;
    }
    throw error;
  }
}

function isVisibleUserMessage(payload) {
  return (
    payload?.type === 'user_message' &&
    (!payload.kind || payload.kind === 'plain') &&
    typeof payload.message === 'string' &&
    payload.message.trim().length > 0
  );
}

function extractContent(content) {
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
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function parseSessionMetadata(filePath, sessionIndex, mobileSessionIndex) {
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let meta = null;
  let lastTimestamp = null;
  let lastUserMessage = '';
  let messageCount = 0;

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        lastTimestamp = entry.timestamp;
      }
      if (entry.type === 'session_meta' && entry.payload?.id) {
        meta = {
          id: entry.payload.id,
          cwd: entry.payload.cwd,
          model: entry.payload.model || null,
          provider: entry.payload.model_provider || null,
          timestamp: entry.timestamp || entry.payload.timestamp || null
        };
      }
      if (entry.type === 'event_msg' && isVisibleUserMessage(entry.payload)) {
        messageCount += 1;
        lastUserMessage = entry.payload.message;
      }
      if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
        messageCount += 1;
      }
    } catch {
      // Skip malformed or partial rows.
    }
  }

  if (!meta?.id || !meta.cwd) {
    return null;
  }
  const indexedSession = sessionIndex.get(meta.id);
  const mobileSession = mobileSessionIndex.get(meta.id);
  if (!indexedSession && !mobileSession) {
    return null;
  }
  const indexEntry = indexedSession || mobileSession;
  const mobileMessages = Array.isArray(mobileSession?.messages) ? mobileSession.messages : [];
  const mobileUpdatedAt = mobileSession?.updatedAt || null;
  const updatedAt =
    mobileUpdatedAt && (!lastTimestamp || new Date(mobileUpdatedAt) > new Date(lastTimestamp))
      ? mobileUpdatedAt
      : lastTimestamp || meta.timestamp;

  return {
    id: meta.id,
    cwd: meta.cwd,
    projectId: projectIdFor(meta.cwd),
    title: mobileSession?.title || indexEntry.title || (lastUserMessage ? lastUserMessage.slice(0, 52) : '新对话'),
    summary: mobileSession?.summary || lastUserMessage || indexEntry.summary || indexEntry.title || 'Codex 会话',
    model: meta.model,
    provider: meta.provider,
    messageCount: messageCount + mobileMessages.length,
    updatedAt,
    source: indexedSession ? 'codex-app' : 'codexmobile',
    filePath
  };
}

function upsertProject(projectMap, projectPath, trustLevel = null, label = null) {
  const normalized = normalizeComparablePath(projectPath);
  if (!normalized) {
    return null;
  }
  const id = projectIdFor(projectPath);
  const existing = projectMap.get(id);
  if (existing) {
    if (trustLevel) {
      existing.trusted = trustLevel === 'trusted';
    }
    if (label) {
      existing.name = label;
    }
    return existing;
  }
  const entry = {
    id,
    name: label || displayNameFor(projectPath),
    path: path.resolve(projectPath),
    trusted: trustLevel === 'trusted',
    updatedAt: null,
    sessionCount: 0
  };
  projectMap.set(id, entry);
  return entry;
}

export async function refreshCodexCache() {
  const config = await readCodexConfig();
  const workspaceState = await readCodexWorkspaceState();
  const sessionIndex = await readSessionNameIndex();
  const mobileSessionIndex = await readMobileSessionIndex();
  const mobileSessions = await readMobileSessions();
  const projectById = new Map();
  const sessionsByProject = new Map();
  const sessionById = new Map();

  const visibleProjects = workspaceState.projects.length
    ? workspaceState.projects.map((project) => ({
      path: project.path,
      trustLevel: config.projects.find(
        (entry) => normalizeComparablePath(entry.path) === normalizeComparablePath(project.path)
      )?.trustLevel || 'trusted',
      label: project.label
    }))
    : config.projects.map((project) => ({ ...project, label: null }));
  const visibleProjectIds = new Set();

  for (const project of visibleProjects) {
    const entry = upsertProject(projectById, project.path, project.trustLevel, project.label);
    if (entry) {
      visibleProjectIds.add(entry.id);
    }
  }

  const files = await walkJsonlFiles(CODEX_SESSIONS_DIR);
  for (const file of files) {
    const session = await parseSessionMetadata(file, sessionIndex, mobileSessionIndex);
    if (!session) {
      continue;
    }
    if (!visibleProjectIds.has(session.projectId)) {
      continue;
    }
    const project = projectById.get(session.projectId);
    if (!project) {
      continue;
    }
    if (!sessionsByProject.has(project.id)) {
      sessionsByProject.set(project.id, []);
    }
    sessionsByProject.get(project.id).push(session);
    sessionById.set(session.id, session);
  }

  for (const mobileSession of mobileSessions) {
    if (!mobileSession?.id || !mobileSession.projectPath || sessionById.has(mobileSession.id)) {
      continue;
    }
    const projectId = projectIdFor(mobileSession.projectPath);
    if (!visibleProjectIds.has(projectId)) {
      continue;
    }
    const project = projectById.get(projectId);
    if (!project) {
      continue;
    }
    const messages = Array.isArray(mobileSession.messages) ? mobileSession.messages : [];
    const session = {
      id: mobileSession.id,
      cwd: path.resolve(mobileSession.projectPath),
      projectId,
      title: mobileSession.title || mobileSession.summary?.slice(0, 52) || '新对话',
      summary: mobileSession.summary || mobileSession.title || 'CodexMobile 对话',
      model: mobileSession.model || null,
      provider: mobileSession.provider || null,
      messageCount: messages.length,
      updatedAt: mobileSession.updatedAt || null,
      source: mobileSession.source || 'codexmobile',
      filePath: null,
      mobileOnly: true
    };
    if (!sessionsByProject.has(project.id)) {
      sessionsByProject.set(project.id, []);
    }
    sessionsByProject.get(project.id).push(session);
    sessionById.set(session.id, session);
  }

  for (const [projectId, sessions] of sessionsByProject.entries()) {
    sessions.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
    const project = projectById.get(projectId);
    if (project) {
      project.sessionCount = sessions.length;
      project.updatedAt = sessions[0]?.updatedAt || project.updatedAt;
    }
  }

  const projectOrder = new Map(visibleProjects.map((project, index) => [projectIdFor(project.path), index]));
  const projects = [...projectById.values()].sort((a, b) => {
    const orderA = projectOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const orderB = projectOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB || a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  cache = {
    syncedAt: new Date().toISOString(),
    config,
    projects,
    projectById,
    sessionsByProject,
    sessionById
  };

  return getCacheSnapshot();
}

export function getCacheSnapshot() {
  return {
    syncedAt: cache.syncedAt,
    config: cache.config,
    projects: cache.projects.map(toPublicProject)
  };
}

export function listProjects() {
  return cache.projects.map(toPublicProject);
}

export function getProject(projectId) {
  return cache.projectById.get(projectId) || null;
}

export function listProjectSessions(projectId) {
  return (cache.sessionsByProject.get(projectId) || []).map((session) => ({
    id: session.id,
    title: session.title,
    summary: session.summary,
    model: session.model,
    provider: session.provider,
    source: session.source,
    messageCount: session.messageCount,
    updatedAt: session.updatedAt
  }));
}

export function getSession(sessionId) {
  return cache.sessionById.get(sessionId) || null;
}

export async function renameSession(sessionId, projectId, title) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  const nextTitle = String(title || '').trim().slice(0, 52);
  if (!nextTitle) {
    const error = new Error('Title is required');
    error.statusCode = 400;
    throw error;
  }

  if (session.filePath) {
    await renameSessionNameIndexRow(session.id, nextTitle, session.updatedAt);
  }
  await renameMobileSession({
    id: session.id,
    projectPath: session.cwd,
    title: nextTitle,
    updatedAt: session.updatedAt
  });

  return { ...session, title: nextTitle };
}

export async function deleteSession(sessionId, projectId) {
  const session = getSession(sessionId);
  if (!session) {
    const error = new Error('Session not found');
    error.statusCode = 404;
    throw error;
  }
  if (projectId && session.projectId !== projectId) {
    const error = new Error('Session not found in project');
    error.statusCode = 404;
    throw error;
  }

  let deletedFile = false;
  let deletedIndexRows = false;
  if (session.filePath) {
    if (!isInsideDirectory(session.filePath, CODEX_SESSIONS_DIR)) {
      const error = new Error('Refusing to delete session outside Codex sessions directory');
      error.statusCode = 500;
      throw error;
    }
    try {
      await fs.unlink(session.filePath);
      deletedFile = true;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    try {
      deletedIndexRows = await deleteSessionNameIndexRows(sessionId);
    } catch (error) {
      console.warn('[sessions] Failed to remove session index rows:', error.message);
    }
  }

  const deletedMobileRecord = await deleteMobileSession(sessionId);

  return {
    deletedSessionId: sessionId,
    projectId: session.projectId,
    deletedFile,
    deletedIndexRows,
    deletedMobileRecord
  };
}

export async function hideSessionMessage(sessionId, messageId) {
  const id = String(sessionId || '').trim();
  const itemId = String(messageId || '').trim();
  if (!id || !itemId) {
    const error = new Error('sessionId and messageId are required');
    error.statusCode = 400;
    throw error;
  }

  const state = await readDeletedMessagesState();
  if (!state.sessions[id] || typeof state.sessions[id] !== 'object' || Array.isArray(state.sessions[id])) {
    state.sessions[id] = {};
  }
  const existing = state.sessions[id][itemId];
  const deletedAt = existing?.deletedAt || new Date().toISOString();
  state.sessions[id][itemId] = { deletedAt };
  await writeDeletedMessagesState(state);
  return { sessionId: id, messageId: itemId, deletedAt };
}

async function findSessionFile(sessionId) {
  const cached = cache.sessionById.get(sessionId)?.filePath;
  if (cached) {
    return cached;
  }
  const files = await walkJsonlFiles(CODEX_SESSIONS_DIR);
  return files.find((file) => path.basename(file).includes(sessionId)) || null;
}

function paginateMessages(messages, { limit = 120, offset = null, latest = true } = {}) {
  const total = messages.length;
  const count = Number(limit) || 0;
  const hasOffset = offset !== null && offset !== undefined;
  const start = hasOffset
    ? Math.max(0, Number(offset) || 0)
    : latest && count
      ? Math.max(0, total - count)
      : 0;
  const end = count ? start + count : undefined;
  return {
    messages: messages.slice(start, end),
    total,
    offset: start,
    hasMore: end ? end < total : false,
    hasMoreBefore: start > 0
  };
}

export async function readSessionMessages(sessionId, { limit = 120, offset = null, latest = true } = {}) {
  const filePath = await findSessionFile(sessionId);
  const mobileMessages = await readMobileSessionMessages(sessionId);
  const deletedIds = await readDeletedMessageIds(sessionId);
  if (!filePath) {
    return paginateMessages(filterDeletedMessages(mobileMessages, deletedIds), { limit, offset, latest });
  }

  const messages = [];
  const stream = fsSync.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      const timestamp = entry.timestamp || null;

      if (entry.type === 'event_msg' && isVisibleUserMessage(entry.payload)) {
        messages.push({
          id: `${entry.timestamp || messages.length}-user`,
          role: 'user',
          content: entry.payload.message,
          timestamp
        });
      }

      if (entry.type === 'response_item' && entry.payload?.type === 'message' && entry.payload.role === 'assistant') {
        const content = extractContent(entry.payload.content);
        if (content.trim()) {
          messages.push({
            id: entry.payload.id || `${entry.timestamp || messages.length}-assistant`,
            role: entry.payload.role || 'assistant',
            content,
            timestamp
          });
        }
      }

    } catch {
      // Skip malformed rows.
    }
  }

  for (const message of mobileMessages) {
    if (!messages.some((item) => item.id === message.id)) {
      messages.push(message);
    }
  }
  messages.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  return paginateMessages(filterDeletedMessages(messages, deletedIds), { limit, offset, latest });
}

export function getHostName() {
  return os.hostname();
}
