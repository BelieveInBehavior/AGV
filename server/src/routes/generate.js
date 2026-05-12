/**
 * 路由: /api/generate
 * 触发各阶段生成任务
 */

import { Router } from 'express';
import { getDB } from '../utils/db.js';
import { authMiddleware } from '../utils/jwt.js';
import { enqueueTask } from '../queue/task-runner.js';

const router = Router();
router.use(authMiddleware);

// ── POST /api/generate/story — 触发故事分析 ──────────────────────────
router.post('/story', async (req, res) => {
  try {
    const db = getDB();
    const { projectId, episodeId } = req.body;
    if (!projectId || !episodeId) {
      return res.status(400).json({ success: false, message: 'projectId 和 episodeId 必填' });
    }

    // 验证权限
    const project = await db.collection('projects').findOne({ projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    const episode = await db.collection('episodes').findOne({ episodeId, projectId });
    if (!episode) return res.status(404).json({ success: false, message: '剧集不存在' });

    const taskId = await enqueueTask({
      type: 'STORY_ANALYSIS',
      projectId,
      episodeId,
      payload: {},
    });

    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── POST /api/generate/storyboard — 触发分镜生成 ─────────────────────
router.post('/storyboard', async (req, res) => {
  try {
    const db = getDB();
    const { projectId, episodeId, clipIds } = req.body;
    if (!projectId || !episodeId) {
      return res.status(400).json({ success: false, message: 'projectId 和 episodeId 必填' });
    }

    const project = await db.collection('projects').findOne({ projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    const taskId = await enqueueTask({
      type: 'STORYBOARD_GEN',
      projectId,
      episodeId,
      payload: { clipIds: clipIds || [] },
    });

    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── POST /api/generate/images — 触发图像生成 ─────────────────────────
router.post('/images', async (req, res) => {
  try {
    const db = getDB();
    const { projectId, episodeId, panelIds, panelId } = req.body;
    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId 必填' });
    }

    const project = await db.collection('projects').findOne({ projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    const taskId = await enqueueTask({
      type: 'IMAGE_GENERATION',
      projectId,
      episodeId: episodeId || null,
      payload: { panelIds: panelIds || [], panelId: panelId || null },
    });

    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
