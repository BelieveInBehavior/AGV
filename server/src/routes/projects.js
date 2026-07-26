/**
 * 路由: /api/projects
 * 项目 CRUD
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../utils/db.js';
import { authMiddleware } from '../utils/jwt.js';
import { generateLibraryReferenceImage } from '../utils/reference-image-fal.js';
import { isOssConfigured, signMediaUrl, uploadImageDataUrlToOss } from '../utils/oss.js';

const router = Router();

const USER_AI_COL = 'user_ai_settings';

async function getUserImageConfig(db, userId) {
  const doc = await db.collection(USER_AI_COL).findOne({ userId });
  const envOpenAiKey = (process.env.IMAGE_API_KEY || '').trim();
  const envFalKey = (process.env.FAL_API_KEY || '').trim();
  const provider = doc?.imageProvider ?? (envOpenAiKey ? 'openai' : envFalKey ? 'fal' : 'none');
  const apiKey = (doc?.imageApiKey || (provider === 'openai' ? envOpenAiKey : envFalKey) || '').trim();
  const modelId = (
    doc?.imageModel
    || (provider === 'openai' ? process.env.IMAGE_MODEL : process.env.FAL_IMAGE_MODEL)
    || (provider === 'openai' ? 'gpt-image-1' : 'fal-ai/flux/schnell')
  ).trim();
  const baseUrl = (
    doc?.imageBaseUrl
    || process.env.IMAGE_BASE_URL
    || process.env.LLM_BASE_URL
    || 'https://api.openai.com/v1'
  ).trim();
  return {
    provider,
    apiKey,
    modelId,
    baseUrl,
    enabled: provider !== 'none' && Boolean(apiKey),
  };
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value.trim());
}

function sanitizeVideoReferenceAssets(value) {
  const src = value && typeof value === 'object' ? value : {};
  const normalize = (items) =>
    Array.isArray(items)
      ? items
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
      : [];
  return {
    videoUrls: normalize(src.videoUrls),
    audioUrls: normalize(src.audioUrls),
  };
}

function validateVideoReferenceAssets(value) {
  const assets = sanitizeVideoReferenceAssets(value);
  const invalidVideo = assets.videoUrls.filter((url) => !isHttpUrl(url));
  if (invalidVideo.length > 0) {
    throw new Error('videoReferenceAssets.videoUrls 仅支持 http/https URL');
  }
  const invalidAudio = assets.audioUrls.filter((url) => !isHttpUrl(url));
  if (invalidAudio.length > 0) {
    throw new Error('videoReferenceAssets.audioUrls 仅支持 http/https URL');
  }
  return assets;
}

function sanitizeStoryboardPlanV2(plan) {
  const src = plan && typeof plan === 'object' ? plan : {};
  const normalizeFrame = (frame) => {
    const fr = frame && typeof frame === 'object' ? frame : {};
    return {
      description: typeof fr.description === 'string' ? fr.description : '',
      scene_prompt: typeof fr.scene_prompt === 'string' ? fr.scene_prompt : '',
      characters: Array.isArray(fr.characters) ? fr.characters : [],
      characterImageUrls:
        fr.characterImageUrls && typeof fr.characterImageUrls === 'object' ? fr.characterImageUrls : {},
      imageUrl: fr.imageUrl ?? null,
      continuityImageUrl: fr.continuityImageUrl ?? null,
      continuitySourceClipId: fr.continuitySourceClipId ?? null,
      imagePromptUsed: typeof fr.imagePromptUsed === 'string' ? fr.imagePromptUsed : undefined,
      imageError: typeof fr.imageError === 'string' ? fr.imageError : undefined,
      status: typeof fr.status === 'string' ? fr.status : undefined,
    };
  };

  return {
    video_prompt: typeof src.video_prompt === 'string' ? src.video_prompt : '',
    transition_from_prev: typeof src.transition_from_prev === 'string' ? src.transition_from_prev : '',
    included_character_ids: Array.isArray(src.included_character_ids) ? src.included_character_ids : [],
    first_frame: normalizeFrame(src.first_frame),
    last_frame: normalizeFrame(src.last_frame),
    referenceStale: Boolean(src.referenceStale),
  };
}

function sanitizeClipVideoReferenceAssets(clip) {
  if (!clip || typeof clip !== 'object') return { videoUrls: [], audioUrls: [] };
  return sanitizeVideoReferenceAssets(clip.videoReferenceAssets);
}

function signUrlValue(value) {
  return typeof value === 'string' ? signMediaUrl(value) : value ?? null;
}

function signUrlMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([key, url]) => [key, signUrlValue(url)]),
  );
}

function signStoryboardFrame(frame) {
  if (!frame || typeof frame !== 'object') return frame;
  return {
    ...frame,
    imageUrl: signUrlValue(frame.imageUrl),
    continuityImageUrl: signUrlValue(frame.continuityImageUrl),
    characterImageUrls: signUrlMap(frame.characterImageUrls),
  };
}

function signStoryboardPlan(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  return {
    ...plan,
    first_frame: signStoryboardFrame(plan.first_frame),
    last_frame: signStoryboardFrame(plan.last_frame),
  };
}

function signPanelMedia(panel) {
  if (!panel || typeof panel !== 'object') return panel;
  return {
    ...panel,
    imageUrl: signUrlValue(panel.imageUrl),
    videoUrl: signUrlValue(panel.videoUrl),
  };
}

function signClipMedia(clip) {
  if (!clip || typeof clip !== 'object') return clip;
  const overrides = clip.referenceOverrides && typeof clip.referenceOverrides === 'object'
    ? clip.referenceOverrides
    : null;
  return {
    ...clip,
    videoUrl: signUrlValue(clip.videoUrl),
    storyboardPlan: signStoryboardPlan(clip.storyboardPlan),
    panels: Array.isArray(clip.panels) ? clip.panels.map(signPanelMedia) : clip.panels,
    referenceOverrides: overrides
      ? {
        ...overrides,
        locationImage: signUrlValue(overrides.locationImage),
        characterImages: signUrlMap(overrides.characterImages),
      }
      : overrides,
  };
}

function signProjectMedia(project) {
  if (!project || typeof project !== 'object') return project;
  return {
    ...project,
    characters: Array.isArray(project.characters)
      ? project.characters.map((character) => ({
        ...character,
        referenceImageUrl: signUrlValue(character?.referenceImageUrl),
      }))
      : project.characters,
    locations: Array.isArray(project.locations)
      ? project.locations.map((location) => ({
        ...location,
        referenceImageUrl: signUrlValue(location?.referenceImageUrl),
      }))
      : project.locations,
  };
}

async function markEpisodeReferenceStale(db, projectId, episodeId) {
  await db.collection('clips').updateMany(
    {
      projectId,
      episodeId,
      storyboardPlan: { $ne: null },
    },
    { $set: { 'storyboardPlan.referenceStale': true, updatedAt: new Date() } },
  );
}

// 所有路由都需要认证
router.use(authMiddleware);

// ── GET /api/projects — 获取当前用户的项目列表 ──────────────────────
// 首页只用到元数据与角色/场景数量；beeseen 等项目里可能含大段 description、参考图 URL，
// 全量 toArray + JSON 序列化会在弱网或超大文档下长时间无响应（浏览器一直「加载中」）。
router.get('/', async (req, res) => {
  try {
    const db = getDB();
    const uid = req.userId;
    const projects = await db
      .collection('projects')
      .aggregate(
        [
          { $match: { userId: uid } },
          { $sort: { updatedAt: -1 } },
          { $limit: 50 },
          {
            $addFields: {
              _cl: { $size: { $ifNull: ['$characters', []] } },
              _ll: { $size: { $ifNull: ['$locations', []] } },
            },
          },
          {
            $project: {
              projectId: 1,
              userId: 1,
              name: 1,
              artStyle: 1,
              imageModel: 1,
              videoModel: 1,
              videoRatio: 1,
              language: 1,
              createdAt: 1,
              updatedAt: 1,
              description: {
                $cond: {
                  if: { $gt: [{ $strLenCP: { $ifNull: ['$description', ''] } }, 8000] },
                  then: {
                    $concat: [{ $substrCP: [{ $ifNull: ['$description', ''] }, 0, 8000] }, '…'],
                  },
                  else: { $ifNull: ['$description', ''] },
                },
              },
              characters: {
                $map: {
                  input: { $range: [0, '$_cl'] },
                  as: 'i',
                  in: { name: '', description: '', role: 'supporting' },
                },
              },
              locations: {
                $map: {
                  input: { $range: [0, '$_ll'] },
                  as: 'i',
                  in: { name: '', description: '' },
                },
              },
            },
          },
        ],
        { maxTimeMS: 25_000 },
      )
      .toArray();

    res.json({ success: true, projects });
  } catch (error) {
    const msg = error?.message || String(error);
    if (msg.includes('MaxTimeMSExpired') || error?.codeName === 'MaxTimeMSExpired') {
      return res.status(504).json({
        success: false,
        message: '项目列表查询超时，请稍后重试或联系管理员检查 Mongo 索引与 projects 文档体积',
      });
    }
    res.status(500).json({ success: false, message: msg });
  }
});

// ── POST /api/projects — 创建新项目 ──────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const db = getDB();
    const {
      name,
      description = '',
      artStyle = 'cinematic',
      imageModel = 'fal-ai/flux/schnell',
      videoRatio = '16:9',
      language = 'zh',
    } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: '项目名称不能为空' });
    }

    const projectId = `proj_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

    const project = {
      projectId,
      userId: req.userId,
      name: name.trim(),
      description,
      artStyle,
      imageModel,
      videoModel: '',
      videoRatio,
      language,
      characters: [],
      locations: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection('projects').insertOne(project);
    res.status(201).json({ success: true, project });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── 以下含多段路径的路由须先于 `GET|PATCH|DELETE /:projectId` 单段路由，避免误匹配 ──

// ── PATCH /api/projects/:projectId/references — 角色/场景参考图 URL ──
router.patch('/:projectId/references', async (req, res) => {
  try {
    const db = getDB();
    const { projectId } = req.params;
    const { characters: charPatches, locations: locPatches, episodeId } = req.body || {};

    const project = await db
      .collection('projects')
      .findOne({ projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    let nextChars = [...(project.characters || [])];
    let nextLocs = [...(project.locations || [])];

    if (Array.isArray(charPatches)) {
      for (const p of charPatches) {
        const name = typeof p?.name === 'string' ? p.name.trim() : '';
        if (!name) continue;
        const idx = nextChars.findIndex((c) => (c.name || '').trim() === name);
        if (idx < 0) continue;
        if (p.referenceImageUrl !== undefined) {
          const url =
            p.referenceImageUrl === null || p.referenceImageUrl === ''
              ? null
              : String(p.referenceImageUrl).trim();
          nextChars[idx] = { ...nextChars[idx], referenceImageUrl: url || null };
        }
        if (typeof p.imagePrompt === 'string') {
          nextChars[idx] = { ...nextChars[idx], imagePrompt: p.imagePrompt };
        }
      }
    }

    if (Array.isArray(locPatches)) {
      for (const p of locPatches) {
        const name = typeof p?.name === 'string' ? p.name.trim() : '';
        if (!name) continue;
        const idx = nextLocs.findIndex((l) => (l.name || '').trim() === name);
        if (idx < 0) continue;
        if (p.referenceImageUrl !== undefined) {
          const url =
            p.referenceImageUrl === null || p.referenceImageUrl === ''
              ? null
              : String(p.referenceImageUrl).trim();
          nextLocs[idx] = { ...nextLocs[idx], referenceImageUrl: url || null };
        }
        if (typeof p.imagePrompt === 'string') {
          nextLocs[idx] = { ...nextLocs[idx], imagePrompt: p.imagePrompt };
        }
      }
    }

    const updated = await db.collection('projects').findOneAndUpdate(
      { projectId, userId: req.userId },
      { $set: { characters: nextChars, locations: nextLocs, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    const doc = updated?.value ?? updated;
    if (episodeId && typeof episodeId === 'string') {
      await markEpisodeReferenceStale(db, projectId, episodeId);
    }

    res.json({ success: true, project: signProjectMedia(doc) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── POST /api/projects/:projectId/uploads/image — 上传图片到 OSS ───────
router.post('/:projectId/uploads/image', async (req, res) => {
  try {
    const db = getDB();
    const { projectId } = req.params;
    const { dataUrl, fileName = '', scope = 'project-reference', episodeId = '', clipId = '' } = req.body || {};

    const project = await db.collection('projects').findOne({ projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    let subDir = `project-references/${req.userId}/${projectId}`;
    if (scope === 'clip-reference') {
      subDir = `clip-references/${req.userId}/${projectId}/${episodeId || 'common'}/${clipId || 'common'}`;
    } else if (scope !== 'project-reference') {
      return res.status(400).json({ success: false, message: 'scope 仅支持 project-reference 或 clip-reference' });
    }

    const uploaded = await uploadImageDataUrlToOss({
      dataUrl,
      fileName,
      subDir,
    });

    res.status(201).json({ success: true, url: uploaded.url, objectKey: uploaded.objectKey });
  } catch (error) {
    const message = error?.message || '上传失败';
    const badRequestMessages = ['图片数据格式无效', '仅支持 jpg、png、webp、gif 图片', '图片内容为空'];
    const status = badRequestMessages.includes(message)
      ? 400
      : message.startsWith('OSS 未配置')
        ? 503
        : 500;
    res.status(status).json({ success: false, message });
  }
});

// ── POST /api/projects/:projectId/references/generate — AI 生成单张参考图 ──
router.post('/:projectId/references/generate', async (req, res) => {
  try {
    const db = getDB();
    const { projectId } = req.params;
    const { kind, name, episodeId } = req.body || {};

    const project = await db
      .collection('projects')
      .findOne({ projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    if (kind !== 'character' && kind !== 'location') {
      return res.status(400).json({ success: false, message: 'kind 须为 character 或 location' });
    }
    const entityName = typeof name === 'string' ? name.trim() : '';
    if (!entityName) {
      return res.status(400).json({ success: false, message: 'name 必填' });
    }

    const { provider, apiKey, modelId, baseUrl, enabled } = await getUserImageConfig(db, req.userId);
    if (!enabled) {
      return res.status(400).json({ success: false, message: '未配置可用的生图 Provider，请在 AI 设置中填写图片模型配置' });
    }

    let description = '';
    let imagePrompt = '';
    if (kind === 'character') {
      const c = (project.characters || []).find((x) => (x.name || '').trim() === entityName);
      if (!c) return res.status(404).json({ success: false, message: '角色不存在' });
      description = c.description || '';
      imagePrompt = c.imagePrompt || '';
    } else {
      const l = (project.locations || []).find((x) => (x.name || '').trim() === entityName);
      if (!l) return res.status(404).json({ success: false, message: '场景不存在' });
      description = l.description || '';
      imagePrompt = l.imagePrompt || '';
    }

    const imageUrl = await generateLibraryReferenceImage({
      provider,
      baseUrl,
      apiKey,
      modelId,
      artStyle: project.artStyle || 'cinematic',
      videoRatio: project.videoRatio || '16:9',
      kind,
      name: entityName,
      description,
      imagePrompt,
    });

    if (!imageUrl) {
      return res.status(502).json({ success: false, message: '图片 Provider 未返回图片结果' });
    }
    const persistedImageUrl =
      imageUrl.startsWith('data:image/') && isOssConfigured()
        ? (await uploadImageDataUrlToOss({
          dataUrl: imageUrl,
          fileName: `${kind}-${entityName}.jpg`,
          subDir: `projects/${projectId}/references`,
        })).url
        : imageUrl;

    let nextChars = [...(project.characters || [])];
    let nextLocs = [...(project.locations || [])];

    if (kind === 'character') {
      const idx = nextChars.findIndex((c) => (c.name || '').trim() === entityName);
      if (idx >= 0) nextChars[idx] = { ...nextChars[idx], referenceImageUrl: persistedImageUrl };
    } else {
      const idx = nextLocs.findIndex((l) => (l.name || '').trim() === entityName);
      if (idx >= 0) nextLocs[idx] = { ...nextLocs[idx], referenceImageUrl: persistedImageUrl };
    }

    const updated = await db.collection('projects').findOneAndUpdate(
      { projectId, userId: req.userId },
      { $set: { characters: nextChars, locations: nextLocs, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );

    const doc = updated?.value ?? updated;
    if (episodeId && typeof episodeId === 'string') {
      await markEpisodeReferenceStale(db, projectId, episodeId);
    }

    res.json({
      success: true,
      project: signProjectMedia(doc),
      imageUrl: signUrlValue(persistedImageUrl),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── PATCH /api/projects/:projectId/episodes/:episodeId/clips/:clipId ──
router.patch('/:projectId/episodes/:episodeId/clips/:clipId', async (req, res) => {
  try {
    const db = getDB();
    const { projectId, episodeId, clipId } = req.params;
    const { referenceOverrides, beatPrompts, videoReferenceAssets } = req.body || {};

    const project = await db
      .collection('projects')
      .findOne({ projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    const clip = await db.collection('clips').findOne({ clipId, projectId, episodeId });
    if (!clip) return res.status(404).json({ success: false, message: '情节不存在' });

    const $set = { updatedAt: new Date() };

    if (referenceOverrides !== undefined) {
      if (referenceOverrides === null) {
        $set.referenceOverrides = null;
      } else if (typeof referenceOverrides === 'object') {
        const prev = clip.referenceOverrides || {};
        const incoming = referenceOverrides.characterImages;
        const mergedChars =
          typeof incoming === 'object' && incoming !== null
            ? { ...(prev.characterImages || {}), ...incoming }
            : { ...(prev.characterImages || {}) };
        $set.referenceOverrides = {
          characterImages: mergedChars,
          locationImage:
            referenceOverrides.locationImage === undefined
              ? prev.locationImage ?? null
              : referenceOverrides.locationImage || null,
        };
      }
    }

    if (beatPrompts && typeof beatPrompts === 'object') {
      const { video_prompt, first_frame, last_frame } = beatPrompts;
      const ff = first_frame && typeof first_frame === 'object' ? first_frame : null;
      const lf = last_frame && typeof last_frame === 'object' ? last_frame : null;

      const v2Ff =
        ff &&
        (typeof ff.scene_prompt === 'string' ||
          Array.isArray(ff.characters) ||
          typeof ff.description === 'string');
      const v2Lf =
        lf &&
        (typeof lf.scene_prompt === 'string' ||
          Array.isArray(lf.characters) ||
          typeof lf.description === 'string');
      if (!v2Ff && !v2Lf && typeof video_prompt !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'beatPrompts 需提供 video_prompt 或 first_frame / last_frame 的 scene_prompt、description 或 characters',
        });
      }
      const nextPlan = sanitizeStoryboardPlanV2(clip.storyboardPlan);
      if (typeof video_prompt === 'string') nextPlan.video_prompt = video_prompt;
      if (v2Ff) {
        if (typeof ff.scene_prompt === 'string') nextPlan.first_frame.scene_prompt = ff.scene_prompt;
        if (typeof ff.description === 'string') nextPlan.first_frame.description = ff.description;
        if (Array.isArray(ff.characters)) nextPlan.first_frame.characters = ff.characters;
      }
      if (v2Lf) {
        if (typeof lf.scene_prompt === 'string') nextPlan.last_frame.scene_prompt = lf.scene_prompt;
        if (typeof lf.description === 'string') nextPlan.last_frame.description = lf.description;
        if (Array.isArray(lf.characters)) nextPlan.last_frame.characters = lf.characters;
      }
      $set.storyboardPlan = nextPlan;
    }

    if (videoReferenceAssets !== undefined) {
      $set.videoReferenceAssets =
        videoReferenceAssets === null
          ? { videoUrls: [], audioUrls: [] }
          : validateVideoReferenceAssets(videoReferenceAssets);
    }

    await db.collection('clips').updateOne({ clipId, projectId, episodeId }, { $set });

    if (referenceOverrides !== undefined) {
      await markEpisodeReferenceStale(db, projectId, episodeId);
    }

    const panels = await db
      .collection('panels')
      .find({ clipId })
      .sort({ panelIndex: 1 })
      .toArray();
    const fresh = await db.collection('clips').findOne({ clipId });

    res.json({
      success: true,
      clip: signClipMedia({
        ...fresh,
        panels,
        videoReferenceAssets: sanitizeClipVideoReferenceAssets(fresh),
      }),
    });
  } catch (error) {
    const message = error?.message || '保存失败';
    const status = message.includes('videoReferenceAssets.') ? 400 : 500;
    res.status(status).json({ success: false, message });
  }
});

// ── GET /api/projects/:projectId — 获取项目详情 ──────────────────────
router.get('/:projectId', async (req, res) => {
  try {
    const db = getDB();
    const project = await db
      .collection('projects')
      .findOne({ projectId: req.params.projectId, userId: req.userId });

    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    res.json({ success: true, project: signProjectMedia(project) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── PATCH /api/projects/:projectId — 更新项目 ────────────────────────
router.patch('/:projectId', async (req, res) => {
  try {
    const db = getDB();
    const allowed = ['name', 'description', 'artStyle', 'imageModel', 'videoRatio', 'language'];
    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    updates.updatedAt = new Date();

    const result = await db.collection('projects').findOneAndUpdate(
      { projectId: req.params.projectId, userId: req.userId },
      { $set: updates },
      { returnDocument: 'after' }
    );

    if (!result) return res.status(404).json({ success: false, message: '项目不存在' });
    res.json({ success: true, project: signProjectMedia(result) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── DELETE /api/projects/:projectId — 删除项目 ───────────────────────
router.delete('/:projectId', async (req, res) => {
  try {
    const db = getDB();
    const { projectId } = req.params;

    await Promise.all([
      db.collection('projects').deleteOne({ projectId, userId: req.userId }),
      db.collection('episodes').deleteMany({ projectId }),
      db.collection('clips').deleteMany({ projectId }),
      db.collection('panels').deleteMany({ projectId }),
      db.collection('tasks').deleteMany({ projectId }),
    ]);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET /api/projects/:projectId/episodes — 获取剧集列表 ────────────
router.get('/:projectId/episodes', async (req, res) => {
  try {
    const db = getDB();
    const project = await db
      .collection('projects')
      .findOne({ projectId: req.params.projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    const episodes = await db
      .collection('episodes')
      .find({ projectId: req.params.projectId })
      .sort({ episodeNumber: 1 })
      .toArray();

    res.json({ success: true, episodes });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── POST /api/projects/:projectId/episodes — 创建剧集 ───────────────
router.post('/:projectId/episodes', async (req, res) => {
  try {
    const db = getDB();
    const project = await db
      .collection('projects')
      .findOne({ projectId: req.params.projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    const { title = '', novelText = '' } = req.body;
    if (!novelText?.trim()) {
      return res.status(400).json({ success: false, message: '故事文本不能为空' });
    }

    const count = await db.collection('episodes').countDocuments({ projectId: req.params.projectId });
    const episodeId = `ep_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

    const episode = {
      episodeId,
      projectId: req.params.projectId,
      episodeNumber: count + 1,
      title: title || `第 ${count + 1} 集`,
      novelText: novelText.trim(),
      status: 'draft',
      clipIds: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await db.collection('episodes').insertOne(episode);
    res.status(201).json({ success: true, episode });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET /api/projects/:projectId/episodes/:episodeId/clips — 获取情节片段 ──
router.get('/:projectId/episodes/:episodeId/clips', async (req, res) => {
  try {
    const db = getDB();
    const clips = await db
      .collection('clips')
      .find({ episodeId: req.params.episodeId, projectId: req.params.projectId, isActive: { $ne: false } })
      .sort({ clipIndex: 1 })
      .toArray();

    // 为每个 clip 附带 panels
    const clipsWithPanels = await Promise.all(
      clips.map(async (clip) => {
        const panels = await db
          .collection('panels')
          .find({ clipId: clip.clipId, isActive: { $ne: false } })
          .sort({ panelIndex: 1 })
          .toArray();
        return {
          ...clip,
          panels,
          videoReferenceAssets: sanitizeClipVideoReferenceAssets(clip),
        };
      })
    );

    res.json({ success: true, clips: clipsWithPanels.map(signClipMedia) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
