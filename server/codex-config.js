import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const CODEX_CONFIG_PATH = path.join(CODEX_HOME, 'config.toml');
export const CODEX_GLOBAL_STATE_PATH = path.join(CODEX_HOME, '.codex-global-state.json');
export const CODEX_MODELS_CACHE_PATH = path.join(CODEX_HOME, 'models_cache.json');
export const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
export const CODEX_SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');

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

function shortModelName(model) {
  if (!model) {
    return '5.5 中';
  }
  return model
    .replace(/^gpt-/i, '')
    .replace(/-codex.*$/i, '')
    .replace(/-mini$/i, ' mini') + ' 中';
}

function publicModel(entry) {
  if (!entry?.slug) {
    return null;
  }
  if (entry.visibility && entry.visibility !== 'list') {
    return null;
  }
  return {
    value: entry.slug,
    label: entry.display_name || entry.slug
  };
}

export async function readCodexModels(currentModel = 'gpt-5.5') {
  const models = new Map();

  try {
    const raw = await fs.readFile(CODEX_MODELS_CACHE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed.models) ? parsed.models : [];
    for (const entry of entries) {
      const model = publicModel(entry);
      if (model && !models.has(model.value)) {
        models.set(model.value, model);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[config] Failed to read Codex model cache:', error.message);
    }
  }

  if (currentModel && !models.has(currentModel)) {
    models.set(currentModel, { value: currentModel, label: currentModel });
  }

  return [...models.values()];
}

export async function readCodexWorkspaceState() {
  try {
    const raw = await fs.readFile(CODEX_GLOBAL_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const labels = parsed['electron-workspace-root-labels'] || {};
    const orderedRoots = [
      ...(Array.isArray(parsed['project-order']) ? parsed['project-order'] : []),
      ...(Array.isArray(parsed['electron-saved-workspace-roots']) ? parsed['electron-saved-workspace-roots'] : [])
    ];
    const seen = new Set();
    const projects = [];

    for (const root of orderedRoots) {
      if (!root || typeof root !== 'string') {
        continue;
      }
      const key = process.platform === 'win32' ? root.toLowerCase() : root;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      projects.push({
        path: root,
        label: typeof labels[root] === 'string' ? labels[root] : null
      });
    }

    return { projects };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[config] Failed to read Codex workspace state:', error.message);
    }
    return { projects: [] };
  }
}

export async function readCodexConfig() {
  const fallback = {
    provider: 'codex',
    model: 'gpt-5.5',
    modelShort: '5.5 中',
    reasoningEffort: null,
    baseUrl: null,
    models: [{ value: 'gpt-5.5', label: 'gpt-5.5' }],
    projects: []
  };

  let raw;
  try {
    raw = await fs.readFile(CODEX_CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[config] Failed to read Codex config:', error.message);
    }
    fallback.models = await readCodexModels(fallback.model);
    return fallback;
  }

  const config = {
    ...fallback,
    projects: []
  };
  const projectMap = new Map();
  const providerBaseUrls = new Map();
  let currentProject = null;
  let currentProvider = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const projectMatch = line.match(/^\[projects\.(?:'([^']+)'|"([^"]+)")\]$/);
    if (projectMatch) {
      currentProject = stripQuotes(projectMatch[1] || projectMatch[2]);
      currentProvider = null;
      if (!projectMap.has(currentProject)) {
        projectMap.set(currentProject, { path: currentProject, trustLevel: null });
      }
      continue;
    }

    const providerMatch = line.match(/^\[model_providers\.(?:'([^']+)'|"([^"]+)"|([^\]]+))\]$/);
    if (providerMatch) {
      currentProject = null;
      currentProvider = stripQuotes(providerMatch[1] || providerMatch[2] || providerMatch[3]);
      continue;
    }

    if (line.startsWith('[')) {
      currentProject = null;
      currentProvider = null;
      continue;
    }

    const assignment = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!assignment) {
      continue;
    }

    const key = assignment[1];
    const value = stripQuotes(assignment[2]);

    if (currentProject) {
      if (key === 'trust_level') {
        projectMap.get(currentProject).trustLevel = value;
      }
      continue;
    }

    if (currentProvider) {
      if (key === 'base_url') {
        providerBaseUrls.set(currentProvider, value);
      }
      continue;
    }

    if (key === 'model_provider') {
      config.provider = value;
    } else if (key === 'model') {
      config.model = value;
    } else if (key === 'model_reasoning_effort') {
      config.reasoningEffort = value;
    }
  }

  const cwd = process.cwd();
  if (!projectMap.has(cwd)) {
    projectMap.set(cwd, { path: cwd, trustLevel: 'trusted' });
  }

  config.modelShort = shortModelName(config.model);
  config.baseUrl = providerBaseUrls.get(config.provider) || (config.provider === 'cliproxyapi' ? 'http://127.0.0.1:8317/v1' : null);
  config.models = await readCodexModels(config.model);
  config.projects = [...projectMap.values()];
  return config;
}
