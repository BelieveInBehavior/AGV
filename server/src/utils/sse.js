/**
 * SSE Manager — 管理服务端推送连接
 * 无状态服务：每个连接存储在内存 Map 中，但 agent 本身不持有状态
 */

/** @type {Map<string, import('express').Response>} */
const clients = new Map();

/**
 * 注册新的 SSE 客户端连接
 * @param {string} clientId
 * @param {import('express').Response} res
 */
export function registerClient(clientId, res) {
  clients.set(clientId, res);
}

/**
 * 移除 SSE 客户端连接
 * @param {string} clientId
 */
export function removeClient(clientId) {
  clients.delete(clientId);
}

/**
 * 向所有连接的客户端广播事件
 * @param {string} event - 事件名称
 * @param {object} data - 事件数据
 */
export function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const [clientId, res] of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(clientId);
    }
  }
}

/**
 * 广播任务进度更新
 * @param {string} taskId
 * @param {number} progress - 0-100
 * @param {string} message
 * @param {string} [stage]
 */
export function broadcastTaskProgress(taskId, progress, message, stage) {
  broadcast('task.progress', { taskId, progress, message, stage, timestamp: Date.now() });
}

/**
 * 广播任务完成
 * @param {string} taskId
 * @param {object} [result]
 */
export function broadcastTaskComplete(taskId, result) {
  broadcast('task.completed', { taskId, result, timestamp: Date.now() });
}

/**
 * 广播任务失败
 * @param {string} taskId
 * @param {string} error
 */
export function broadcastTaskError(taskId, error) {
  broadcast('task.error', { taskId, error, timestamp: Date.now() });
}
