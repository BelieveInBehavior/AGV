/**
 * Celery Publisher — 从 Node.js 向 Celery Redis Broker 发布任务
 *
 * Celery 使用 Redis list 作为队列，消息格式为 Celery AMQP 协议 JSON。
 * 本模块封装序列化逻辑，Node.js 可直接触发 Python Celery worker。
 *
 * 消息结构:
 *   LPUSH {queue} {celery_json_message}
 *
 * Celery Redis 协议参考:
 *   https://docs.celeryq.dev/en/stable/internals/protocol.html
 */

import { v4 as uuidv4 } from 'uuid';
import { getRedis } from './redis.js';

/**
 * 发布 Celery 任务到 Redis Broker
 *
 * @param {object} options
 * @param {string} options.taskName   - Python 任务名称，如 'tasks.story_task.analyze_story'
 * @param {object} options.kwargs     - 任务关键字参数（对应 Python 函数 kwargs）
 * @param {string} [options.queue]    - 队列名称，默认 'celery'
 * @param {string} [options.taskId]   - 自定义 task ID（可选，默认 uuid4）
 * @returns {Promise<string>}         - taskId
 */
export async function publishCeleryTask({ taskName, kwargs, queue = 'celery', taskId }) {
  const id = taskId || uuidv4();

  // Celery body: [args, kwargs, options]
  const body = Buffer.from(
    JSON.stringify([
      [],              // positional args（全用 kwargs，保持幂等）
      kwargs,          // keyword args
      {                // task options
        callbacks: null,
        errbacks: null,
        chain: null,
        chord: null,
      },
    ])
  ).toString('base64');

  const message = JSON.stringify({
    body,
    'content-encoding': 'utf-8',
    'content-type': 'application/json',
    headers: {
      lang: 'py',
      task: taskName,
      id,
      root_id: id,
      parent_id: null,
      group: null,
      meth: null,
      shadow: null,
      eta: null,
      expires: null,
      retries: 0,
      timelimit: [null, null],
      argsrepr: '[]',
      kwargsrepr: JSON.stringify(kwargs),
      origin: 'node@agv-server',
    },
    properties: {
      correlation_id: id,
      reply_to: '',
      delivery_mode: 2,                  // persistent
      delivery_info: {
        exchange: '',
        routing_key: queue,
      },
      priority: 0,
      body_encoding: 'base64',
      delivery_tag: uuidv4(),
    },
  });

  // LPUSH 到对应队列（Celery 用 RPOP/BRPOP 消费）
  await getRedis().lpush(queue, message);

  return id;
}

/**
 * 封装三种任务的快捷发布方法
 */
export const CeleryTasks = {
  async analyzeStory({ taskId, episodeId, projectId }) {
    return publishCeleryTask({
      taskName: 'tasks.story_task.analyze_story',
      kwargs: { task_id: taskId, episode_id: episodeId, project_id: projectId },
      queue: 'story',
      taskId,
    });
  },

  async generateStoryboard({ taskId, episodeId, projectId, clipIds = [] }) {
    return publishCeleryTask({
      taskName: 'tasks.storyboard_task.generate_storyboard',
      kwargs: { task_id: taskId, episode_id: episodeId, project_id: projectId, clip_ids: clipIds },
      queue: 'storyboard',
      taskId,
    });
  },

  async generateImages({ taskId, projectId, episodeId, panelIds = [], panelId = null }) {
    return publishCeleryTask({
      taskName: 'tasks.image_task.generate_images',
      kwargs: {
        task_id: taskId,
        project_id: projectId,
        episode_id: episodeId || null,
        panel_ids: panelIds,
        panel_id: panelId,
      },
      queue: 'image',
      taskId,
    });
  },
};
