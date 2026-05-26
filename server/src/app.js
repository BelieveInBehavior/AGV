import './tracing.js';
import cors from 'cors';
import express from 'express';
import config from './config/index.js';
import authRouter from './routes/auth.js';
import projectsRouter from './routes/projects.js';
import generateRouter from './routes/generate.js';
import tasksRouter from './routes/tasks.js';
import sseRouter from './routes/sse.js';
import settingsRouter from './routes/settings.js';
import { connectDB } from './utils/db.js';
import { closeRedis, pingRedis } from './utils/redis.js';
import { startTaskRunner } from './queue/task-runner.js';

const app = express();

/** 前端 dev（如 :3003）直连 API 端口时需 CORS；生产可设 CORS_ORIGIN 逗号分隔列表 */
const corsOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (corsOrigins.length > 0) {
      return callback(null, corsOrigins.includes(origin));
    }
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
});

app.use(corsMiddleware);
/** Express 5 路由会对 OPTIONS 自行响应且不带 CORS 头；全局预检须优先结束 */
app.options(/.*/, corsMiddleware);

app.use((req, res, next) => {
  res.setHeader('X-AGV-API', '1');
  next();
});

app.use(express.json({ limit: '10mb' }));

app.get('/health', (_, res) => {
  res.json({ success: true, message: 'ok', service: 'agv-api' });
});

app.get('/ready', async (_, res) => {
  try {
    await pingRedis();
    res.json({ success: true, checks: { redis: 'ok', mongo: 'ok' } });
  } catch (error) {
    res.status(503).json({
      success: false,
      message: 'service not ready',
      error: error.message,
    });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/generate', generateRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/sse', sseRouter);
app.use('/api/settings', settingsRouter);

app.use('/api', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'API route not found',
    service: 'agv-api',
    method: req.method,
    path: req.originalUrl,
  });
});

async function bootstrap() {
  try {
    await connectDB();
    startTaskRunner();
    const server = app.listen(config.port, () => {
      console.log(`[agv-server] running on http://localhost:${config.port}`);
      console.log(`[agv-server] health: http://127.0.0.1:${config.port}/health (service=agv-api)`);
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[agv-server] 端口 ${config.port} 已被占用。其它 Node 项目可能正在使用该端口，导致前端代理到错误服务（POST /api/projects → 404）。`,
        );
        console.error(`[agv-server] 释放端口: lsof -ti :${config.port} | xargs kill -9`);
        console.error('[agv-server] 然后重新启动本仓库的 API (Node) 调试配置。');
      } else {
        console.error('[agv-server] listen failed:', err);
      }
      process.exit(1);
    });
  } catch (error) {
    console.error('server start failed:', error);
    process.exit(1);
  }
}

bootstrap();

async function shutdown(signal) {
  console.log(`[agv-server] received ${signal}, shutting down`);
  await closeRedis();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
