#!/usr/bin/env node
/**
 * 确认 CWEI_PORT 上是 AGV API，而不是其它占用 3001 的 Node 服务。
 * 用于 client `npm run dev` 启动前校验，避免 Vite 代理到错误进程导致 404 / HTML。
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadPort() {
  const fromEnv = Number(process.env.CWEI_PORT);
  if (fromEnv > 0) return fromEnv;

  for (const rel of ['client/.env.development.local', 'client/.env.development']) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^\s*CWEI_PORT\s*=\s*(\d+)/m);
    if (m) return Number(m[1]);
  }
  return 3001;
}

const port = loadPort();
const url = `http://127.0.0.1:${port}/health`;

function fail(msg) {
  console.error('\n[AGV] ❌', msg);
  console.error(`[AGV] 期望: http://127.0.0.1:${port}/health → { success: true, service: "agv-api" }`);
  console.error('[AGV] 请先在本仓库启动 API：VS Code「API (Node)」或 `cd server && CWEI_PORT=' + port + ' npm run dev`');
  console.error('[AGV] 若 3001 被其它项目占用：`lsof -ti :' + port + ' | xargs kill -9` 后再启动 AGV API\n');
  process.exit(1);
}

try {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    fail(`端口 ${port} 返回的不是 AGV JSON（可能是其它项目的前端/接口）。响应开头: ${text.slice(0, 120)}`);
  }

  const isAgv =
    body?.success === true &&
    body?.message === 'ok' &&
    (body?.service === 'agv-api' || res.headers.get('x-agv-api') === '1');

  if (!isAgv) {
    fail(`端口 ${port} 上的 /health 不是 AGV API。收到: ${text.slice(0, 200)}`);
  }

  console.log(`[AGV] ✅ API 已就绪: http://127.0.0.1:${port} （Vite 将把 /api 代理到此端口）`);
} catch (e) {
  fail(`无法连接 ${url}：${e.message}`);
}
