const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

function ensureHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value.trim());
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function toRoleItem(url, type, role) {
  if (!ensureHttpUrl(url)) return null;
  return {
    type,
    [type]: { url: url.trim() },
    role,
  };
}

export function buildArkContentFromShorthand({
  prompt,
  referenceImageUrls = [],
  referenceVideoUrl,
  referenceAudioUrl,
}) {
  const content = [];
  const text = cleanText(prompt);
  if (text) {
    content.push({ type: 'text', text });
  }

  for (const url of referenceImageUrls) {
    const item = toRoleItem(url, 'image_url', 'reference_image');
    if (item) content.push(item);
  }

  const refVideo = toRoleItem(referenceVideoUrl, 'video_url', 'reference_video');
  if (refVideo) content.push(refVideo);

  const refAudio = toRoleItem(referenceAudioUrl, 'audio_url', 'reference_audio');
  if (refAudio) content.push(refAudio);

  return content;
}

function normalizeArkContentItem(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'text') {
    const text = cleanText(item.text);
    if (!text) return null;
    return { type: 'text', text };
  }

  if (item.type === 'image_url' && ensureHttpUrl(item?.image_url?.url)) {
    return {
      type: 'image_url',
      image_url: { url: item.image_url.url.trim() },
      role: cleanText(item.role) || 'reference_image',
    };
  }
  if (item.type === 'video_url' && ensureHttpUrl(item?.video_url?.url)) {
    return {
      type: 'video_url',
      video_url: { url: item.video_url.url.trim() },
      role: cleanText(item.role) || 'reference_video',
    };
  }
  if (item.type === 'audio_url' && ensureHttpUrl(item?.audio_url?.url)) {
    return {
      type: 'audio_url',
      audio_url: { url: item.audio_url.url.trim() },
      role: cleanText(item.role) || 'reference_audio',
    };
  }
  return null;
}

export function normalizeArkContent(content) {
  if (!Array.isArray(content)) return [];
  const normalized = [];
  for (const item of content) {
    const v = normalizeArkContentItem(item);
    if (v) normalized.push(v);
  }
  return normalized;
}

function buildArkTaskUrl(baseUrl, taskId = '') {
  const safeBase = cleanText(baseUrl) || DEFAULT_ARK_BASE_URL;
  const root = safeBase.replace(/\/$/, '');
  const suffix = taskId ? `/${encodeURIComponent(taskId)}` : '';
  return `${root}/contents/generations/tasks${suffix}`;
}

function assertOkResponse(payload, status) {
  if (status >= 200 && status < 300) return;
  const msg = payload?.error?.message || payload?.message || `Ark request failed (${status})`;
  const err = new Error(msg);
  err.status = status;
  err.payload = payload;
  throw err;
}

async function requestArk(url, { method = 'GET', apiKey, body } = {}) {
  if (!cleanText(apiKey)) {
    throw new Error('Ark API key is required');
  }
  const headers = {
    Authorization: `Bearer ${apiKey.trim()}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  assertOkResponse(payload, response.status);
  return payload;
}

export async function submitArkVideoGenerationTask({
  baseUrl,
  apiKey,
  model,
  content,
  generateAudio = true,
  ratio = '16:9',
  duration = 11,
  watermark = false,
}) {
  const safeModel = cleanText(model);
  const safeContent = normalizeArkContent(content);
  if (!safeModel) {
    throw new Error('Ark model is required');
  }
  if (safeContent.length === 0) {
    throw new Error('Ark content is required');
  }
  const taskPayload = {
    model: safeModel,
    content: safeContent,
    generate_audio: Boolean(generateAudio),
    ratio: cleanText(ratio) || '16:9',
    duration: Number(duration) > 0 ? Number(duration) : 11,
    watermark: Boolean(watermark),
  };
  return requestArk(buildArkTaskUrl(baseUrl), {
    method: 'POST',
    apiKey,
    body: taskPayload,
  });
}

export async function queryArkVideoGenerationTask({ baseUrl, apiKey, taskId }) {
  const id = cleanText(taskId);
  if (!id) {
    throw new Error('Ark taskId is required');
  }
  return requestArk(buildArkTaskUrl(baseUrl, id), {
    method: 'GET',
    apiKey,
  });
}
