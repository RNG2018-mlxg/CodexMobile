import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL, normalizeBaseUrl, readCliProxyApiKeys } from './provider-api.js';
import { Converter } from 'opencc-js';

const LOCAL_TRANSCRIBE_BASE_URL = 'http://127.0.0.1:8000/v1';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_LOCAL_TRANSCRIBE_MODEL = 'iic/SenseVoiceSmall';
const DEFAULT_OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const FALLBACK_OPENAI_TRANSCRIBE_MODEL = 'whisper-1';
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.CODEXMOBILE_TRANSCRIBE_TIMEOUT_MS || 120000);
const toSimplified = Converter({ from: 'tw', to: 'cn' });

function normalizeTranscriptText(value) {
  return toSimplified(String(value || ''))
    .replace(/\bcode ex\b/gi, 'Codex')
    .replace(/\bcodex mobile\b/gi, 'CodexMobile')
    .replace(/\bcli proxy api\b/gi, 'CLIProxyAPI')
    .replace(/\bclip proxy api\b/gi, 'cliproxyapi')
    .replace(/预设权限/g, '默认权限')
    .replace(/档案/g, '文件')
    .replace(/专案/g, '项目')
    .replace(/执行绪/g, '线程')
    .replace(/智慧强度/g, '智能强度')
    .replace(/传送/g, '发送')
    .trim();
}

function truthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function safeProviderMessage(value) {
  return String(value || '语音转写失败')
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [hidden]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[hidden]')
    .replace(/sk-\[hidden\][A-Za-z0-9*._-]*/g, 'sk-[hidden]')
    .replace(/Incorrect API key provided:[\s\S]*?(?:\.|$)/i, 'OpenAI API key 无效。')
    .slice(0, 500);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function isOpenAIBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname === 'api.openai.com';
  } catch {
    return false;
  }
}

function providerLabel(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.hostname === 'api.openai.com') {
      return 'openai';
    }
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      if (parsed.port === '8000') {
        return 'sensevoice';
      }
      return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    }
    return parsed.hostname || 'custom';
  } catch {
    return 'custom';
  }
}

function providerHost(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.host || 'unknown';
  } catch {
    return 'unknown';
  }
}

function defaultModelForBaseUrl(baseUrl) {
  return isOpenAIBaseUrl(baseUrl) ? DEFAULT_OPENAI_TRANSCRIBE_MODEL : DEFAULT_LOCAL_TRANSCRIBE_MODEL;
}

function keysForBaseUrl(baseUrl) {
  if (isOpenAIBaseUrl(baseUrl)) {
    return uniqueValues([process.env.CODEXMOBILE_TRANSCRIBE_API_KEY, process.env.OPENAI_API_KEY]);
  }
  return uniqueValues([process.env.CODEXMOBILE_LOCAL_TRANSCRIBE_API_KEY, process.env.CODEXMOBILE_TRANSCRIBE_API_KEY]);
}

function parseTranscriptionText(rawText) {
  const text = String(rawText || '');
  if (!text.trim()) {
    return '';
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.text === 'string') {
      return normalizeTranscriptText(parsed.text);
    }
    if (typeof parsed?.message === 'string') {
      return normalizeTranscriptText(parsed.message);
    }
  } catch {
    // OpenAI-compatible local services may return plain text when response_format=text.
  }
  return normalizeTranscriptText(text);
}

function languageForProvider(config) {
  if (process.env.CODEXMOBILE_TRANSCRIBE_LANGUAGE) {
    return process.env.CODEXMOBILE_TRANSCRIBE_LANGUAGE;
  }
  if (config?.source === 'local') {
    return 'auto';
  }
  return 'zh';
}

function parseErrorText(rawText, response) {
  try {
    const parsed = rawText ? JSON.parse(rawText) : null;
    return parsed?.error?.message || parsed?.error || parsed?.message || `转写接口返回 ${response.status}`;
  } catch {
    return rawText || `转写接口返回 ${response.status}`;
  }
}

function shouldFallbackOpenAIModel(status, message) {
  const normalized = String(message || '').toLowerCase();
  return (
    [400, 404, 422].includes(status) ||
    normalized.includes('model') ||
    normalized.includes('unsupported') ||
    normalized.includes('not found')
  );
}

function isNetworkFailure(error) {
  const text = `${error?.message || ''} ${error?.cause?.code || ''}`.toLowerCase();
  return (
    text.includes('fetch failed') ||
    text.includes('econnrefused') ||
    text.includes('enotfound') ||
    text.includes('etimedout') ||
    text.includes('terminated')
  );
}

function providerMessage(error, providerConfig) {
  const message = String(error?.message || '');
  const localProvider = providerConfig?.source === 'local' || providerConfig?.provider?.startsWith('127.0.0.1');

  if (localProvider && isNetworkFailure(error)) {
    return '本地语音转写服务未启动，请先在电脑上运行 npm run asr:start';
  }
  if (error?.status === 401 || /incorrect api key|invalid api key|unauthorized/i.test(message)) {
    return isOpenAIBaseUrl(providerConfig?.baseUrl)
      ? 'OpenAI API key 无效，请在电脑上更新 CODEXMOBILE_TRANSCRIBE_API_KEY 或 OPENAI_API_KEY'
      : '本地语音转写服务认证失败，请检查 CODEXMOBILE_LOCAL_TRANSCRIBE_API_KEY';
  }
  if (error?.status === 404 || /404|not found|page not found/i.test(message)) {
    return '当前语音转写服务未配置或不支持 /audio/transcriptions';
  }
  return safeProviderMessage(message || '语音转写失败');
}

function statusForError(error, providerConfig) {
  if (providerConfig?.source === 'local' && isNetworkFailure(error)) {
    return 503;
  }
  return error?.status || 502;
}

export async function voiceTranscriptionConfig(codexConfig = {}) {
  const explicitBaseUrl = process.env.CODEXMOBILE_TRANSCRIBE_BASE_URL;
  if (explicitBaseUrl) {
    const baseUrl = normalizeBaseUrl(explicitBaseUrl, OPENAI_BASE_URL);
    return {
      baseUrl,
      apiKeys: keysForBaseUrl(baseUrl),
      model: process.env.CODEXMOBILE_TRANSCRIBE_MODEL || defaultModelForBaseUrl(baseUrl),
      provider: providerLabel(baseUrl),
      configured: true,
      source: 'explicit'
    };
  }

  if (truthyEnv(process.env.CODEXMOBILE_TRANSCRIBE_USE_OPENAI)) {
    return {
      baseUrl: OPENAI_BASE_URL,
      apiKeys: keysForBaseUrl(OPENAI_BASE_URL),
      model: process.env.CODEXMOBILE_TRANSCRIBE_MODEL || DEFAULT_OPENAI_TRANSCRIBE_MODEL,
      provider: 'openai',
      configured: Boolean(process.env.CODEXMOBILE_TRANSCRIBE_API_KEY || process.env.OPENAI_API_KEY),
      source: 'openai'
    };
  }

  if (truthyEnv(process.env.CODEXMOBILE_TRANSCRIBE_USE_CODEX_PROVIDER)) {
    const baseUrl = normalizeBaseUrl(codexConfig.baseUrl || DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
    return {
      baseUrl,
      apiKeys: await readCliProxyApiKeys([]),
      model: process.env.CODEXMOBILE_TRANSCRIBE_MODEL || defaultModelForBaseUrl(baseUrl),
      provider: providerLabel(baseUrl),
      configured: false,
      source: 'codex-provider'
    };
  }

  const baseUrl = normalizeBaseUrl(process.env.CODEXMOBILE_LOCAL_TRANSCRIBE_BASE_URL || LOCAL_TRANSCRIBE_BASE_URL);
  return {
    baseUrl,
    apiKeys: keysForBaseUrl(baseUrl),
    model: process.env.CODEXMOBILE_TRANSCRIBE_MODEL || DEFAULT_LOCAL_TRANSCRIBE_MODEL,
    provider: providerLabel(baseUrl),
    configured: true,
    source: 'local'
  };
}

export function publicVoiceTranscriptionStatus(codexConfig = {}) {
  const explicitBaseUrl = process.env.CODEXMOBILE_TRANSCRIBE_BASE_URL;
  const useOpenAI = truthyEnv(process.env.CODEXMOBILE_TRANSCRIBE_USE_OPENAI);
  const useCodexProvider = truthyEnv(process.env.CODEXMOBILE_TRANSCRIBE_USE_CODEX_PROVIDER);
  const baseUrl = explicitBaseUrl ||
    (useOpenAI
      ? OPENAI_BASE_URL
      : (useCodexProvider ? codexConfig.baseUrl || DEFAULT_OPENAI_COMPATIBLE_BASE_URL : process.env.CODEXMOBILE_LOCAL_TRANSCRIBE_BASE_URL || LOCAL_TRANSCRIBE_BASE_URL));

  return {
    configured: true,
    provider: providerLabel(baseUrl),
    model: process.env.CODEXMOBILE_TRANSCRIBE_MODEL || defaultModelForBaseUrl(baseUrl)
  };
}

async function requestTranscription({ audio, config, apiKey, model }) {
  const form = new FormData();
  if (model) {
    form.append('model', model);
  }
  form.append('language', languageForProvider(config));
  if (isOpenAIBaseUrl(config.baseUrl) && process.env.CODEXMOBILE_TRANSCRIBE_PROMPT) {
    form.append('prompt', process.env.CODEXMOBILE_TRANSCRIBE_PROMPT);
  }
  form.append('response_format', 'json');
  if (isOpenAIBaseUrl(config.baseUrl)) {
    form.append('temperature', '0');
  }
  form.append('file', new Blob([audio.data], { type: audio.mimeType }), audio.fileName);

  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS)
  });
  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error(safeProviderMessage(parseErrorText(bodyText, response)));
    error.status = response.status;
    throw error;
  }
  return parseTranscriptionText(bodyText);
}

function candidateModels(providerConfig, requestedModel) {
  if (providerConfig.source === 'openai' || isOpenAIBaseUrl(providerConfig.baseUrl)) {
    return requestedModel === FALLBACK_OPENAI_TRANSCRIBE_MODEL
      ? [requestedModel]
      : [requestedModel, FALLBACK_OPENAI_TRANSCRIBE_MODEL];
  }
  return [requestedModel];
}

export async function transcribeAudio(audio, codexConfig = {}) {
  const providerConfig = await voiceTranscriptionConfig(codexConfig);
  const requestedModel = providerConfig.model || defaultModelForBaseUrl(providerConfig.baseUrl);
  const models = candidateModels(providerConfig, requestedModel);
  const apiKeys = providerConfig.apiKeys.length ? providerConfig.apiKeys : [''];
  let lastError = null;

  for (const model of models) {
    for (let index = 0; index < apiKeys.length; index += 1) {
      try {
        const text = await requestTranscription({
          audio,
          config: providerConfig,
          apiKey: apiKeys[index],
          model
        });
        return { text, model, provider: providerConfig.provider };
      } catch (error) {
        lastError = error;
        const invalidKey = error.status === 401 || /invalid api key|incorrect api key|unauthorized/i.test(error.message || '');
        if (invalidKey && index < apiKeys.length - 1) {
          console.warn(`[voice] API key #${index + 1} failed, trying next key.`);
          continue;
        }
        if (
          isOpenAIBaseUrl(providerConfig.baseUrl) &&
          model !== FALLBACK_OPENAI_TRANSCRIBE_MODEL &&
          shouldFallbackOpenAIModel(error.status, error.message)
        ) {
          break;
        }
        const nextError = new Error(providerMessage(error, providerConfig));
        nextError.status = statusForError(error, providerConfig);
        nextError.provider = providerConfig.provider;
        nextError.providerHost = providerHost(providerConfig.baseUrl);
        throw nextError;
      }
    }
  }

  const finalError = new Error(providerMessage(lastError, providerConfig));
  finalError.status = statusForError(lastError, providerConfig);
  finalError.provider = providerConfig.provider;
  finalError.providerHost = providerHost(providerConfig.baseUrl);
  throw finalError;
}
