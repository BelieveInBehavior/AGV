import { randomUUID } from 'crypto';
import path from 'path';
import OSS from 'ali-oss';
import config from '../config/index.js';

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const ALLOWED_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

let ossClient = null;

function getOssConfig() {
  return config.oss || {};
}

export function isOssConfigured() {
  const { accessKeyId, accessKeySecret, bucket, endpoint } = getOssConfig();
  return Boolean(accessKeyId && accessKeySecret && bucket && endpoint);
}

function getOssClient() {
  if (ossClient) return ossClient;
  const { accessKeyId, accessKeySecret, bucket, endpoint } = getOssConfig();
  if (!accessKeyId || !accessKeySecret || !bucket || !endpoint) {
    throw new Error('OSS 未配置，请设置 OSS_ACCESS_KEY_ID/OSS_ACCESS_KEY_SECRET/OSS_BUCKET/OSS_ENDPOINT');
  }
  ossClient = new OSS({
    accessKeyId,
    accessKeySecret,
    bucket,
    endpoint: `https://${endpoint}`,
    region: endpoint.replace(/^oss-/, ''),
    secure: true,
  });
  return ossClient;
}

function encodeObjectKeyForUrl(key) {
  return key
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function toOssUrl(objectKey) {
  const { bucket, endpoint } = getOssConfig();
  return `https://${bucket}.${endpoint}/${encodeObjectKeyForUrl(objectKey)}`;
}

function decodePathname(pathname) {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function isCurrentBucketOssUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const { bucket, endpoint } = getOssConfig();
  if (!bucket || !endpoint) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname === `${bucket}.${endpoint}`;
  } catch {
    return false;
  }
}

export function signMediaUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  if (!isCurrentBucketOssUrl(rawUrl)) return rawUrl;

  const client = getOssClient();
  try {
    const parsed = new URL(rawUrl);
    const objectKey = decodePathname(parsed.pathname);
    if (!objectKey) return rawUrl;
    const expires = Number(getOssConfig().signExpiresSeconds || 3600);
    return client.signatureUrl(objectKey, { expires });
  } catch (err) {
    console.warn('[oss] 签名失败，回退原链接:', err?.message || err);
    return rawUrl;
  }
}

function decodeDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    throw new Error('图片数据格式无效');
  }
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) {
    throw new Error('图片数据格式无效');
  }
  const [, contentType, base64] = match;
  const normalizedType = contentType.toLowerCase();
  if (!MIME_TO_EXT[normalizedType]) {
    throw new Error('仅支持 jpg、png、webp、gif 图片');
  }
  return {
    contentType: normalizedType,
    ext: MIME_TO_EXT[normalizedType],
    buffer: Buffer.from(base64, 'base64'),
  };
}

function pickFileExt(fileName, fallbackExt) {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  if (ALLOWED_EXTS.has(ext)) return ext === '.jpeg' ? '.jpg' : ext;
  return fallbackExt;
}

function normalizeSegments(parts) {
  return parts
    .map((part) => String(part || '').trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

export async function uploadImageDataUrlToOss({
  dataUrl,
  fileName = '',
  subDir = 'uploads',
  folder = getOssConfig().folder || 'AGV',
}) {
  const { buffer, contentType, ext } = decodeDataUrl(dataUrl);
  if (!buffer.length) {
    throw new Error('图片内容为空');
  }

  const objectKey = normalizeSegments([
    folder,
    subDir,
    `${Date.now()}_${randomUUID().slice(0, 8)}${pickFileExt(fileName, ext)}`,
  ]).join('/');

  const client = getOssClient();
  await client.put(objectKey, buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000',
    },
  });

  return {
    objectKey,
    url: signMediaUrl(toOssUrl(objectKey)),
  };
}
