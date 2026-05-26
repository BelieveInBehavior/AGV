/**
 * API 根路径（开发环境务必走相对路径 `/api`）。
 *
 * - 默认 `API_BASE = '/api'`：浏览器访问 :3003，由 Vite 代理到 `CWEI_PORT`（默认 3001）上的 AGV API，无 CORS。
 * - 勿设置 `VITE_API_ORIGIN` 直连 :3001，除非确认该端口只有 AGV 且已配置 CORS。
 * - `npm run dev` 启动前会校验 :3001 是否为 AGV（/health 含 service=agv-api）。
 */
const origin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.trim().replace(/\/$/, '') ?? '';

if (import.meta.env.DEV && origin) {
  console.warn(
    '[AGV] 已设置 VITE_API_ORIGIN，将跨域直连后端。开发推荐删除该变量，使用 /api 代理到 CWEI_PORT。',
  );
}

export const API_BASE = origin ? `${origin}/api` : '/api';
