/**
 * API 根路径。
 * - 设置 `VITE_API_ORIGIN`（如 `http://localhost:3011`）时：请求直连该主机下的 `/api`，浏览器 Network 中会显示后端端口，不再经 Vite 的 `/api` 代理。
 * - 未设置时：使用相对路径 `/api`，依赖 dev 代理或生产环境同源反代。
 */
const origin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.trim().replace(/\/$/, '') ?? '';

export const API_BASE = origin ? `${origin}/api` : '/api';
