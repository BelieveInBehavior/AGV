/**
 * 路由: /api/tasks
 * 查询任务状态
 */

import { Router } from 'express';
import { getDB } from '../utils/db.js';
import { authMiddleware } from '../utils/jwt.js';
import { getTaskHot, getRedis } from '../utils/redis.js';

const router = Router();
router.use(authMiddleware);

/** Celery Redis 队列名（与 server/src/utils/celery-publisher.js、worker 一致） */
const CELERY_QUEUE_BY_TYPE = {
  STORY_ANALYSIS: 'story',
  STORYBOARD_GEN: 'storyboard',
  IMAGE_GENERATION: 'image',
};

async function getCeleryQueueHint(taskType) {
  const queue = CELERY_QUEUE_BY_TYPE[taskType];
  if (!queue) return null;
  try {
    const backlog = await getRedis().llen(queue);
    return { queue, backlog };
  } catch {
    return { queue, backlog: null };
  }
}

function mergeTaskState(task, hotState = {}) {
  const hasHotState = hotState && Object.keys(hotState).length > 0;
  return {
    taskId: task.taskId,
    type: hotState.type || task.type,
    status: hotState.status || task.status,
    progress: Number(hotState.progress ?? task.progress ?? 0),
    message: hotState.message || task.message,
    error: hotState.error || task.error,
    result: task.result,
    projectId: task.projectId,
    episodeId: task.episodeId ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    source: hasHotState ? 'redis+mongo' : 'mongo',
  };
}

// ── GET /api/tasks/:taskId — 查询任务状态 ────────────────────────────
router.get('/:taskId', async (req, res) => {
  try {
    const db = getDB();
    const task = await db.collection('tasks').findOne({ taskId: req.params.taskId });
    if (!task) return res.status(404).json({ success: false, message: '任务不存在' });

    // 验证任务属于当前用户的项目
    const project = await db.collection('projects').findOne({
      projectId: task.projectId,
      userId: req.userId,
    });
    if (!project) return res.status(403).json({ success: false, message: '无权限' });

    const hotState = await getTaskHot(task.taskId);
    const merged = mergeTaskState(task, hotState);
    const nonRunning = ['pending', 'queued'].includes(merged.status);
    const celeryQueue = nonRunning ? await getCeleryQueueHint(merged.type) : null;

    res.json({ success: true, task: { ...merged, celeryQueue } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── GET /api/tasks?projectId=xxx — 查询项目的任务列表 ───────────────
router.get('/', async (req, res) => {
  try {
    const db = getDB();
    const { projectId, status, limit = 20 } = req.query;
    if (!projectId) return res.status(400).json({ success: false, message: 'projectId 必填' });

    const project = await db.collection('projects').findOne({ projectId, userId: req.userId });
    if (!project) return res.status(404).json({ success: false, message: '项目不存在' });

    const query = { projectId };
    if (status) query.status = status;

    const tasks = await db
      .collection('tasks')
      .find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .project({
        taskId: 1,
        type: 1,
        status: 1,
        progress: 1,
        message: 1,
        error: 1,
        result: 1,
        projectId: 1,
        episodeId: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .toArray();

    const tasksWithHotState = await Promise.all(
      tasks.map(async (task) => mergeTaskState(task, await getTaskHot(task.taskId))),
    );

    res.json({ success: true, tasks: tasksWithHotState });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
