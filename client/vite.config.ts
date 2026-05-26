import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { agvApiProxyGuard } from './vite-plugin-agv-api-proxy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  const apiPort = Number(env.CWEI_PORT || process.env.CWEI_PORT || 3001);

  return {
    plugins: [react(), agvApiProxyGuard(apiPort)],
    server: {
      port: 3003,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: true,
          configure(proxy) {
            proxy.on('proxyRes', (proxyRes, req) => {
              if (
                proxyRes.statusCode === 404 &&
                req.url?.startsWith('/api/') &&
                proxyRes.headers['x-agv-api'] !== '1'
              ) {
                console.warn(
                  `\n[vite] ⚠️ ${req.method} ${req.url} → ${apiPort} 返回 404，且响应无 X-AGV-API。\n` +
                    `       3001 上可能不是 AGV API。请重启「API (Node)」并确认 /health 含 service=agv-api。\n`,
                );
              }
            });
          },
        },
      },
    },
  };
});
