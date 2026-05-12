/**
 * Task Publisher — 创建任务并发布到 Celery Redis Broker
 *
 * 职责:
 *   1. 在 MongoDB 中记录任务元数据（冷数据，永久保存）
 *   2. 在 Redis 中初始化任务热状态（TTL 24h）
 *   3. 向 Celery Redis Broker 发布任务消息
 *
 * 注意: 本模块不再做轮询！
 *       任务由 Python Celery Worker 消费和执行。
 */

import { v4 as uuidv4 } from 'uuid';
import { getDB } from '../utils/db.js';
import { setTaskHot } from '../utils/redis.js';
import { CeleryTasks } from '../utils/celery-publisher.js';

/**
 * 创建并发布任务
 *
 * @param {{
 *   type: 'STORY_ANALYSIS'|'STORYBOARD_GEN'|'IMAGE_GENERATION',
 *   projectId: string,
 *   episodeId?: string,
 *   payload?: object
 * }} params
 * @returns {Promise<string>} taskId
 */
export async function enqueueTask({ type, projectId, episodeId, payload = {} }) {
  const taskId = `task_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
  const now = new Date();

  // ── 1. 冷数据: MongoDB 任务记录（审计、历史查询） ────────────────
  await getDB().collection('tasks').insertOne({
    taskId,
    type,
    status: 'pending',
    projectId,
    episodeId: episodeId || null,
    payload,
    progress: 0,
    message: '等待 Worker 处理...',
    error: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  });

  // ── 2. 热数据: Redis 任务状态（实时进度，TTL 24h） ───────────────
  await setTaskHot(taskId, {
    status: 'pending',
    progress: 0,
    message: '等待 Worker 处理...',
    type,
    projectId,
  });

  // ── 3. 发布到 Celery Redis Broker ────────────────────────────────
  try {
    switch (type) {
      case 'STORY_ANALYSIS':
        await CeleryTasks.analyzeStory({
          taskId,
          episodeId,
          projectId,
        });
        break;

      case 'STORYBOARD_GEN':
        await CeleryTasks.generateStoryboard({
          taskId,
          episodeId,
          projectId,
          clipIds: payload.clipIds || [],
        });
        break;

      case 'IMAGE_GENERATION':
        await CeleryTasks.generateImages({
          taskId,
          projectId,
          episodeId: episodeId || null,
          panelIds: payload.panelIds || [],
          panelId: payload.panelId || null,
        });
        break;

      default:
        throw new Error(`Unknown task type: ${type}`);
    }
  } catch (error) {
    const message = `任务投递失败: ${error.message}`;
    await Promise.all([
      getDB().collection('tasks').updateOne(
        { taskId },
        { $set: { status: 'failed', message, error: error.message, updatedAt: new Date() } },
      ),
      setTaskHot(taskId, { status: 'failed', progress: 0, message, error: error.message }),
    ]);
    throw error;
  }

  await Promise.all([
    getDB().collection('tasks').updateOne(
      { taskId },
      { $set: { status: 'queued', message: '任务已进入 Celery 队列', updatedAt: new Date() } },
    ),
    setTaskHot(taskId, { status: 'queued', progress: 0, message: '任务已进入 Celery 队列' }),
  ]);

  return taskId;
}

// 兼容旧接口：startTaskRunner 变为空操作（任务由 Celery 消费）
export function startTaskRunner() {
  console.log('[TaskRunner] Celery mode: tasks dispatched to Redis broker');
}
