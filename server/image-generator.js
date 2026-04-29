import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMobileSessionMessages, registerMobileSession } from './mobile-session-index.js';
import { DEFAULT_OPENAI_COMPATIBLE_BASE_URL, openAICompatibleConfig } from './provider-api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
export const GENERATED_ROOT = path.join(ROOT_DIR, '.codexmobile', 'generated');

const DEFAULT_IMAGE_BASE_URL = DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
const IMAGE_TIMEOUT_MS = Number(process.env.CODEXMOBILE_IMAGE_TIMEOUT_MS || 420000);
const IMAGE_MAX_ATTEMPTS = Math.max(1, Number(process.env.CODEXMOBILE_IMAGE_MAX_ATTEMPTS || 3));
const IMAGE_FALLBACK_MAX_ATTEMPTS = Math.max(1, Number(process.env.CODEXMOBILE_IMAGE_FALLBACK_MAX_ATTEMPTS || 2));
const IMAGE_RETRY_BASE_DELAY_MS = Number(process.env.CODEXMOBILE_IMAGE_RETRY_BASE_DELAY_MS || 1600);

const GENERATE_PATTERNS = [
  /(?:生成|画|绘制|制作|设计|出图|创建|做一张|来一张).*(?:图片|图像|图|照片|海报|宣传图|壁纸|头像|插画|封面|logo)/i,
  /(?:图片|图像|图|照片|海报|宣传图|壁纸|头像|插画|封面|logo).*(?:生成|画|绘制|制作|设计|出图|创建|做)/i,
  /\b(?:generate|create|draw|make)\b.*\b(?:image|photo|picture|poster|wallpaper|avatar|logo)\b/i
];

const EDIT_PATTERNS = [
  /(?:修改|编辑|改|换|去掉|移除|添加|变成|修图|美化|上色|扩图|换背景|抠图)/i,
  /\b(?:edit|modify|change|remove|add|retouch|replace|background)\b/i
];

function safeErrorMessage(error) {
  const message = String(error?.message || error || '图片生成失败').trim();
  return message.replace(/Bearer\s+[A-Za-z0-9._~-]+/g, 'Bearer [hidden]');
}

function isTransientImageError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('stream disconnected') ||
    message.includes('before completion') ||
    message.includes('requesttimeout') ||
    message.includes('timeout') ||
    message.includes('context canceled') ||
    message.includes('internal_server_error') ||
    message.includes('fetch failed') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('502') ||
    message.includes('503') ||
    message.includes('504')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function imageMimeToExt(mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) {
    return 'jpg';
  }
  if (mime.includes('webp')) {
    return 'webp';
  }
  return 'png';
}

function parseDataUrl(value) {
  const match = String(value || '').match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) {
    return null;
  }
  return {
    mimeType: match[1] || 'image/png',
    b64: match[2]
  };
}

function detectImageIntent(message, attachments) {
  const text = String(message || '').trim();
  const imageAttachments = attachments.filter((attachment) => attachment.kind === 'image');
  if (imageAttachments.length && EDIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'edit';
  }
  if (GENERATE_PATTERNS.some((pattern) => pattern.test(text))) {
    return imageAttachments.length ? 'edit' : 'generate';
  }
  if (imageAttachments.length && /(生成|出图|重绘|做成|变成|generate|create|draw|make)/i.test(text)) {
    return 'edit';
  }
  return null;
}

export function isImageRequest(message, attachments = []) {
  return Boolean(detectImageIntent(message, attachments));
}

async function imageApiConfig(config = {}) {
  const providerConfig = await openAICompatibleConfig({
    baseUrl: process.env.CODEXMOBILE_IMAGE_BASE_URL || config.baseUrl,
    defaultBaseUrl: DEFAULT_IMAGE_BASE_URL,
    apiKeys: [process.env.CODEXMOBILE_IMAGE_API_KEY]
  });
  return {
    ...providerConfig,
    model: process.env.CODEXMOBILE_IMAGE_MODEL || DEFAULT_IMAGE_MODEL
  };
}

async function readImageAttachment(attachment) {
  const data = await fs.readFile(attachment.path);
  const mimeType = attachment.mimeType || 'image/png';
  return {
    name: attachment.name || path.basename(attachment.path),
    mimeType,
    data
  };
}

function canFallbackEditToGeneration({ intent, attachments, error }) {
  return intent === 'edit' && attachments.some((attachment) => attachment.kind === 'image') && isTransientImageError(error);
}

function buildFallbackGenerationPrompt(prompt, attachments, error) {
  const imageNames = attachments
    .filter((attachment) => attachment.kind === 'image')
    .map((attachment) => attachment.name)
    .filter(Boolean)
    .join(', ');
  const reason = safeErrorMessage(error);
  return [
    'Create a new image as a fallback because the image editing API disconnected.',
    imageNames ? `The user attached reference image file(s): ${imageNames}. Use the user request as the main visual direction.` : '',
    `User request: ${prompt}`,
    `Previous edit error: ${reason}`,
    'Do not mention the technical failure in the image. Produce a polished final image that best matches the request.'
  ].filter(Boolean).join('\n');
}

async function requestImageGeneration({ prompt, attachments, config, forceGenerate = false }) {
  const intent = forceGenerate ? 'generate' : detectImageIntent(prompt, attachments) || 'generate';
  const imageConfig = await imageApiConfig(config);
  const imageAttachments = forceGenerate ? [] : attachments.filter((attachment) => attachment.kind === 'image');
  const imageFiles = [];
  for (const attachment of imageAttachments) {
    imageFiles.push(await readImageAttachment(attachment));
  }

  async function sendRequest(apiKey) {
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const timeoutSignal = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
    if (intent === 'edit' && imageFiles.length) {
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('model', imageConfig.model);
      form.append('response_format', 'b64_json');
      form.append('size', '1024x1024');
      for (const image of imageFiles) {
        form.append('image', new Blob([image.data], { type: image.mimeType }), image.name);
      }
      return fetch(`${imageConfig.baseUrl}/images/edits`, {
        method: 'POST',
        headers,
        body: form,
        signal: timeoutSignal
      });
    }

    return fetch(`${imageConfig.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...headers
      },
      body: JSON.stringify({
        model: imageConfig.model,
        prompt,
        n: 1,
        size: '1024x1024',
        response_format: 'b64_json'
      }),
      signal: timeoutSignal
    });
  }

  const apiKeys = imageConfig.apiKeys.length ? imageConfig.apiKeys : [''];
  let response = null;
  let text = '';
  let lastError = null;

  for (let index = 0; index < apiKeys.length; index += 1) {
    response = await sendRequest(apiKeys[index]);
    text = await response.text();
    if (response.ok) {
      break;
    }

    let errorMessage = text;
    try {
      const parsed = text ? JSON.parse(text) : null;
      errorMessage = parsed?.error?.message || parsed?.error || parsed?.message || text;
    } catch {
      // Keep the raw text.
    }
    lastError = new Error(errorMessage || `图片接口返回 ${response.status}`);
    const invalidKey = /invalid api key|incorrect api key|unauthorized|401/i.test(errorMessage || '') || response.status === 401;
    if (!invalidKey || index === apiKeys.length - 1) {
      break;
    }
    console.warn(`[image] API key #${index + 1} failed, trying next key.`);
  }

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || lastError?.message || text || `图片接口返回 ${response.status}`;
    throw new Error(message);
  }

  const items = Array.isArray(data?.data) ? data.data : [];
  const images = items
    .map((item) => {
      if (item.b64_json) {
        return {
          b64: item.b64_json,
          mimeType: data?.output_format ? `image/${data.output_format}` : 'image/png',
          revisedPrompt: item.revised_prompt || ''
        };
      }
      const parsed = parseDataUrl(item.url);
      return parsed ? { ...parsed, revisedPrompt: item.revised_prompt || '' } : null;
    })
    .filter(Boolean);

  if (!images.length) {
    throw new Error('图片接口没有返回图片内容');
  }

  return {
    intent,
    model: imageConfig.model,
    images,
    usage: data?.usage || null
  };
}

async function saveGeneratedImages(images) {
  const folder = GENERATED_ROOT;
  await fs.mkdir(folder, { recursive: true });

  const saved = [];
  for (const image of images) {
    const mimeType = image.mimeType || 'image/png';
    const ext = imageMimeToExt(mimeType);
    const id = crypto.randomUUID();
    const fileName = `${id}.${ext}`;
    const filePath = path.join(folder, fileName);
    const buffer = Buffer.from(String(image.b64 || '').replace(/\s/g, ''), 'base64');
    await fs.writeFile(filePath, buffer);
    saved.push({
      id,
      mimeType,
      path: filePath,
      url: `/generated/${fileName}`,
      revisedPrompt: image.revisedPrompt || ''
    });
  }
  return saved;
}

function buildAssistantContent(savedImages) {
  const lines = savedImages.flatMap((image, index) => [
    `![生成图片 ${index + 1}](${image.url})`,
    image.revisedPrompt ? `优化提示词：${image.revisedPrompt}` : ''
  ]).filter(Boolean);
  return `已生成图片：\n\n${lines.join('\n\n')}`;
}

function emitStatus(emit, { sessionId, turnId, kind, status = 'running', label, detail = '' }) {
  emit({
    type: 'status-update',
    sessionId,
    turnId,
    kind,
    status,
    label,
    detail,
    timestamp: new Date().toISOString()
  });
}

async function appendMobileMessages({ sessionId, projectPath, title, summary, updatedAt, messages }) {
  const existingMessages = await readMobileSessionMessages(sessionId);
  const merged = [...existingMessages];
  for (const message of messages) {
    if (!merged.some((item) => item.id === message.id)) {
      merged.push(message);
    }
  }
  await registerMobileSession({
    id: sessionId,
    projectPath,
    title,
    summary,
    updatedAt,
    messages: merged
  });
}

export async function runImageTurn({
  sessionId,
  previousSessionId,
  projectPath,
  message,
  attachments = [],
  config,
  turnId,
  persistMobileSession = false
}, emit) {
  const finalSessionId = sessionId || `mobile-image-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();

  if (previousSessionId && previousSessionId !== finalSessionId) {
    emit({
      type: 'thread-started',
      sessionId: finalSessionId,
      previousSessionId,
      turnId,
      projectPath,
      startedAt
    });
  }

  emit({
    type: 'chat-started',
    sessionId: finalSessionId,
    previousSessionId,
    turnId,
    projectPath,
    startedAt
  });
  emitStatus(emit, {
    sessionId: finalSessionId,
    turnId,
    kind: 'image_generation_call',
    status: 'running',
    label: attachments.some((attachment) => attachment.kind === 'image') ? '正在编辑图片' : '正在生成图片',
    detail: ''
  });

  if (persistMobileSession) {
    await appendMobileMessages({
      sessionId: finalSessionId,
      projectPath,
      title: message.slice(0, 52) || 'Image task',
      summary: message || 'Image task',
      updatedAt: startedAt,
      messages: [
        {
          id: `user-${turnId}`,
          role: 'user',
          content: message,
          timestamp: startedAt
        }
      ]
    });
  }

  try {
    const primaryIntent = detectImageIntent(message, attachments) || 'generate';
    let result = null;
    let lastError = null;
    for (let attempt = 1; attempt <= IMAGE_MAX_ATTEMPTS; attempt += 1) {
      try {
        result = await requestImageGeneration({ prompt: message, attachments, config });
        break;
      } catch (error) {
        lastError = error;
        const canFallback = canFallbackEditToGeneration({ intent: primaryIntent, attachments, error });
        if (attempt >= IMAGE_MAX_ATTEMPTS && canFallback) {
          break;
        }
        if (attempt >= IMAGE_MAX_ATTEMPTS || !isTransientImageError(error)) {
          throw error;
        }
        const detail = safeErrorMessage(error);
        emitStatus(emit, {
          sessionId: finalSessionId,
          turnId,
          kind: 'image_generation_call',
          status: 'running',
          label: `图片接口断流，正在重试 ${attempt + 1}/${IMAGE_MAX_ATTEMPTS}`,
          detail
        });
        emit({
          type: 'activity-update',
          sessionId: finalSessionId,
          turnId,
          messageId: `retry-${turnId}-${attempt}`,
          kind: 'image_generation_call',
          label: `图片接口断流，正在重试 ${attempt + 1}/${IMAGE_MAX_ATTEMPTS}`,
          status: 'running',
          detail,
          timestamp: new Date().toISOString()
        });
        await sleep(IMAGE_RETRY_BASE_DELAY_MS * attempt);
      }
    }
    if (!result && canFallbackEditToGeneration({ intent: primaryIntent, attachments, error: lastError })) {
      const fallbackPrompt = buildFallbackGenerationPrompt(message, attachments, lastError);
      const fallbackDetail = safeErrorMessage(lastError);
      emitStatus(emit, {
        sessionId: finalSessionId,
        turnId,
        kind: 'image_generation_call',
        status: 'running',
        label: '图片编辑接口断流，正在改为重绘出图',
        detail: fallbackDetail
      });
      emit({
        type: 'activity-update',
        sessionId: finalSessionId,
        turnId,
        messageId: `fallback-${turnId}`,
        kind: 'image_generation_call',
        label: '图片编辑接口断流，正在改为重绘出图',
        status: 'running',
        detail: fallbackDetail,
        timestamp: new Date().toISOString()
      });

      for (let attempt = 1; attempt <= IMAGE_FALLBACK_MAX_ATTEMPTS; attempt += 1) {
        try {
          result = await requestImageGeneration({
            prompt: fallbackPrompt,
            attachments: [],
            config,
            forceGenerate: true
          });
          result.fallbackFromEdit = true;
          result.originalError = fallbackDetail;
          break;
        } catch (error) {
          lastError = error;
          if (attempt >= IMAGE_FALLBACK_MAX_ATTEMPTS || !isTransientImageError(error)) {
            throw error;
          }
          const detail = safeErrorMessage(error);
          emitStatus(emit, {
            sessionId: finalSessionId,
            turnId,
            kind: 'image_generation_call',
            status: 'running',
            label: `重绘出图断流，正在重试 ${attempt + 1}/${IMAGE_FALLBACK_MAX_ATTEMPTS}`,
            detail
          });
          await sleep(IMAGE_RETRY_BASE_DELAY_MS * attempt);
        }
      }
    }
    if (!result) {
      throw lastError || new Error('图片生成失败');
    }
    const savedImages = await saveGeneratedImages(result.images);
    let assistantContent = buildAssistantContent(savedImages);
    if (result.fallbackFromEdit) {
      assistantContent = `图片编辑接口连续断流，已自动改为重绘出图。\n\n${assistantContent}`;
    }
    const completedAt = new Date().toISOString();

    emit({
      type: 'activity-update',
      sessionId: finalSessionId,
      turnId,
      messageId: `activity-${turnId}`,
      kind: 'image_generation_call',
      label: result.fallbackFromEdit ? '重绘出图完成' : result.intent === 'edit' ? '图片编辑完成' : '图片生成完成',
      status: 'completed',
      detail: `model: ${result.model}`,
      timestamp: completedAt
    });
    emit({
      type: 'assistant-update',
      sessionId: finalSessionId,
      previousSessionId,
      turnId,
      messageId: `assistant-${turnId}`,
      role: 'assistant',
      kind: 'image_generation_result',
      content: assistantContent,
      done: true
    });

    if (persistMobileSession) {
      const existingMessages = await readMobileSessionMessages(finalSessionId);
      await registerMobileSession({
        id: finalSessionId,
        projectPath,
        title: message.slice(0, 52) || '图片生成',
        summary: message || '图片生成',
        updatedAt: completedAt,
        messages: [
          ...existingMessages,
          {
            id: `user-${turnId}`,
            role: 'user',
            content: message,
            timestamp: startedAt
          },
          {
            id: `assistant-${turnId}`,
            role: 'assistant',
            content: assistantContent,
            timestamp: completedAt
          }
        ]
      });
    }

    emit({
      type: 'chat-complete',
      sessionId: finalSessionId,
      previousSessionId,
      turnId,
      usage: result.usage,
      hadAssistantText: true,
      completedAt
    });
  } catch (error) {
    const messageText = safeErrorMessage(error);
    console.error('[image] Generation failed:', messageText);
    if (persistMobileSession) {
      const failedAt = new Date().toISOString();
      await appendMobileMessages({
        sessionId: finalSessionId,
        projectPath,
        title: message.slice(0, 52) || 'Image task',
        summary: message || 'Image task',
        updatedAt: failedAt,
        messages: [
          {
            id: `assistant-${turnId}`,
            role: 'assistant',
            content: `Image task failed: ${messageText}`,
            timestamp: failedAt
          }
        ]
      });
    }
    emit({
      type: 'activity-update',
      sessionId: finalSessionId,
      turnId,
      messageId: `activity-${turnId}`,
      kind: 'image_generation_call',
      label: '图片生成失败',
      status: 'failed',
      detail: messageText,
      error: messageText,
      timestamp: new Date().toISOString()
    });
    emitStatus(emit, {
      sessionId: finalSessionId,
      turnId,
      kind: 'image_generation_call',
      status: 'failed',
      label: '图片生成失败',
      detail: messageText
    });
    emit({
      type: 'chat-error',
      sessionId: finalSessionId,
      previousSessionId,
      turnId,
      error: messageText
    });
  }

  return finalSessionId;
}
