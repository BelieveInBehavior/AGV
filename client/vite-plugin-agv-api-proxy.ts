import type { Plugin } from 'vite';

const AGV_HEALTH_PATH = '/health';

async function probeAgvApi(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}${AGV_HEALTH_PATH}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  const text = await res.text();
  let body: { success?: boolean; message?: string; service?: string };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `端口 ${port} 不是 AGV API（/health 返回非 JSON，可能被其它项目占用）。\n` +
        `响应开头: ${text.slice(0, 120)}\n` +
        `请先启动本仓库 server，或执行: lsof -ti :${port} | xargs kill -9`,
    );
  }
  const ok =
    body.success === true &&
    body.message === 'ok' &&
    (body.service === 'agv-api' || res.headers.get('x-agv-api') === '1');
  if (!ok) {
    throw new Error(
      `端口 ${port} 的 /health 不是 AGV（收到 ${text.slice(0, 160)}）。\n` +
        '请用 VS Code「API (Node)」或 `cd server && npm run dev` 启动 AGV。',
    );
  }
}

/** 开发时校验 Vite /api 代理目标，避免 3001 被其它服务占用导致 POST /api/projects 404 */
export function agvApiProxyGuard(apiPort: number): Plugin {
  return {
    name: 'agv-api-proxy-guard',
    async configureServer() {
      try {
        await probeAgvApi(apiPort);
        console.log(`[vite] /api → http://127.0.0.1:${apiPort} （AGV API 已确认）`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`\n[vite] ❌ 拒绝启动：${msg}\n`);
        throw e;
      }
    },
  };
}
