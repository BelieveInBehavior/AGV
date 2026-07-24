/**
 * 路由: /api/settings — 用户 AI 模型设置（OpenAI 兼容协议）
 */

import { Router } from 'express';
import { getDB } from '../utils/db.js';
import { authMiddleware } from '../utils/jwt.js';

const router = Router();
router.use(authMiddleware);

const COL = 'user_ai_settings';

function envDefaults() {
  // 设置页默认值：provider 不由环境变量推断，避免覆盖用户显式选择
  const imageProvider = 'none';
  const imageSupportsMultiReference = true;
  const imageMaxReferenceImages = 10;
  return {
    llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
    imageProvider,
    imageBaseUrl: process.env.IMAGE_BASE_URL || process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    imageModel:
      imageProvider === 'openai'
        ? process.env.IMAGE_MODEL || 'gpt-image-1'
        : 'none',
    imageSupportsMultiReference,
    imageMaxReferenceImages,
    videoBaseUrl: process.env.VIDEO_API_BASE_URL || '',
    videoModel: process.env.VIDEO_MODEL || '',
  };
}

function mergeForResponse(doc) {
  const env = envDefaults();
  return {
    llmBaseUrl: doc?.llmBaseUrl || env.llmBaseUrl,
    llmModel: doc?.llmModel || env.llmModel,
    llmApiKeySet: Boolean(doc?.llmApiKey),
    imageProvider: doc?.imageProvider || env.imageProvider,
    imageBaseUrl: doc?.imageBaseUrl || env.imageBaseUrl,
    imageModel: doc?.imageModel || env.imageModel,
    imageSupportsMultiReference:
      typeof doc?.imageSupportsMultiReference === 'boolean'
        ? doc.imageSupportsMultiReference
        : env.imageSupportsMultiReference,
    imageMaxReferenceImages:
      typeof doc?.imageMaxReferenceImages === 'number' && doc.imageMaxReferenceImages >= 1
        ? doc.imageMaxReferenceImages
        : env.imageMaxReferenceImages,
    imageApiKeySet: Boolean(doc?.imageApiKey),
    videoBaseUrl: doc?.videoBaseUrl ?? env.videoBaseUrl,
    videoModel: doc?.videoModel ?? env.videoModel,
    videoApiKeySet: Boolean(doc?.videoApiKey),
  };
}

/** GET /api/settings/ai */
router.get('/ai', async (req, res) => {
  try {
    const db = getDB();
    const doc = await db.collection(COL).findOne({ userId: req.userId });
    res.json({ success: true, settings: mergeForResponse(doc) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/** PUT /api/settings/ai */
router.put('/ai', async (req, res) => {
  try {
    const db = getDB();
    const body = req.body || {};
    const prev = (await db.collection(COL).findOne({ userId: req.userId })) || {};
    const env = envDefaults();

    const next = {
      userId: req.userId,
      updatedAt: new Date(),
      llmBaseUrl:
        typeof body.llmBaseUrl === 'string'
          ? body.llmBaseUrl.trim()
          : prev.llmBaseUrl ?? env.llmBaseUrl,
      llmModel:
        typeof body.llmModel === 'string'
          ? body.llmModel.trim()
          : prev.llmModel ?? env.llmModel,
      llmApiKey: prev.llmApiKey,
      imageProvider: ['openai', 'none'].includes(body.imageProvider)
        ? body.imageProvider
        : prev.imageProvider ?? 'none',
      imageBaseUrl:
        typeof body.imageBaseUrl === 'string'
          ? body.imageBaseUrl.trim()
          : prev.imageBaseUrl ?? env.imageBaseUrl,
      imageModel:
        typeof body.imageModel === 'string'
          ? body.imageModel.trim()
          : prev.imageModel ?? env.imageModel,
      imageApiKey: prev.imageApiKey,
      imageSupportsMultiReference:
        typeof body.imageSupportsMultiReference === 'boolean'
          ? body.imageSupportsMultiReference
          : prev.imageSupportsMultiReference ?? env.imageSupportsMultiReference,
      imageMaxReferenceImages:
        typeof body.imageMaxReferenceImages === 'number' && body.imageMaxReferenceImages >= 1
          ? Math.floor(body.imageMaxReferenceImages)
          : prev.imageMaxReferenceImages ?? env.imageMaxReferenceImages,
      videoBaseUrl:
        typeof body.videoBaseUrl === 'string'
          ? body.videoBaseUrl.trim()
          : prev.videoBaseUrl ?? env.videoBaseUrl,
      videoModel:
        typeof body.videoModel === 'string'
          ? body.videoModel.trim()
          : prev.videoModel ?? env.videoModel,
      videoApiKey: prev.videoApiKey,
    };

    if (typeof body.llmApiKey === 'string' && body.llmApiKey.trim()) {
      next.llmApiKey = body.llmApiKey.trim();
    }
    if (typeof body.imageApiKey === 'string' && body.imageApiKey.trim()) {
      next.imageApiKey = body.imageApiKey.trim();
    }
    if (typeof body.videoApiKey === 'string' && body.videoApiKey.trim()) {
      next.videoApiKey = body.videoApiKey.trim();
    }

    await db.collection(COL).updateOne({ userId: req.userId }, { $set: next }, { upsert: true });

    const saved = await db.collection(COL).findOne({ userId: req.userId });
    res.json({ success: true, settings: mergeForResponse(saved) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
