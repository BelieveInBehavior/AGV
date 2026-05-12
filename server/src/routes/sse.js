/**
 * 路由: /api/sse
 * Server-Sent Events — 订阅 Redis pub/sub，转发给浏览器
 *
 * 流向:
 *   Python Celery Worker
 *     → redis.publish('sse:events', JSON)
 *       → Node.js subscriber.on('message')
 *         → res.write(SSE)
 *           → 浏览器 EventSource
 *
 * 无状态设计: 每个连接独立订阅，断开即释放
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getSubscriber } from '../utils/redis.js';
import { parseToken } from '../utils/jwt.js';

const router = Router();
const SSE_CHANNEL = 'sse:events';

router.get('/', async (req, res) => {
  // 支持 ?token= 参数（EventSource 不支持自定义 header）
  const token = req.query.token;
  if (token) {
    const decoded = parseToken(token);
    if (!decoded) return res.status(401).json({ success: false, message: '无效的 token' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = uuidv4();
  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: Date.now() })}\n\n`);

  // 每个 SSE 连接创建专用 subscriber（Redis subscribe 是独占模式）
  const sub = getSubscriber().duplicate();
  await sub.subscribe(SSE_CHANNEL);

  sub.on('message', (channel, rawMsg) => {
    if (channel !== SSE_CHANNEL) return;
    try {
      const data = JSON.parse(rawMsg);
      const event = data.type || 'message';
      res.write(`event: ${event}\ndata: ${rawMsg}\n\n`);
    } catch {
      // ignore malformed messages
    }
  });

  // 心跳 30s 防止代理超时
  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sub.unsubscribe(SSE_CHANNEL).catch(() => {});
    sub.quit().catch(() => {});
  });
});

export default router;
