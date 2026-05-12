/**
 * 路由: /api/projects
 * 项目 CRUD
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../utils/db.js';
import { authMiddleware } from '../utils/jwt.js';

const router = Router();

// 所有路由都需要认证
router.use(authMiddleware);

// ── GET /api/projects — 获取当前用户的项目列表 ──────────────────────
router.get('/', async (req, res) => {
  try {
    const db = getDB();
    const projects = await db
      .collection('projects')
      .find({ userId: req.userId })
      .sort({ updatedAt: -1 })
      .limit(50)
      .toArray();

    res.json({ success: true, projects });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
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

// ── GET /api/projects/:projectId — 获取项目详情 ──────────────────────
router.get('/:projectId', async (req, res) => {
  try {
    const db = getDB();
    const project = await db
      .collection('projects')
      .findOne({ projectId: req.params.projectId, userId: req.userId });

    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    res.json({ success: true, project });
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
    res.json({ success: true, project: result });
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
      .find({ episodeId: req.params.episodeId, projectId: req.params.projectId })
      .sort({ clipIndex: 1 })
      .toArray();

    // 为每个 clip 附带 panels
    const clipsWithPanels = await Promise.all(
      clips.map(async (clip) => {
        const panels = await db
          .collection('panels')
          .find({ clipId: clip.clipId })
          .sort({ panelIndex: 1 })
          .toArray();
        return { ...clip, panels };
      })
    );

    res.json({ success: true, clips: clipsWithPanels });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
