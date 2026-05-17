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
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_, res) => {
  res.json({ success: true, message: 'ok' });
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

async function bootstrap() {
  try {
    await connectDB();
    startTaskRunner();
    app.listen(config.port, () => {
      console.log(`[agv-server] running on http://localhost:${config.port}`);
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
