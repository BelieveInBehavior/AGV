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
  return {
    llmBaseUrl: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
    llmModel: process.env.LLM_MODEL || 'gpt-4o-mini',
    imageProvider: process.env.FAL_API_KEY ? 'fal' : 'none',
    imageModel: process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/schnell',
    imageSupportsMultiReference: false,
    imageMaxReferenceImages: 1,
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
    imageProvider: doc?.imageProvider ?? env.imageProvider,
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
      imageProvider: ['fal', 'none', 'gemini', 'doubao'].includes(body.imageProvider)
        ? body.imageProvider
        : prev.imageProvider ?? env.imageProvider,
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
