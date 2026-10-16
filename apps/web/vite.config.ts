import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

const home = process.env.AGENT_CANVAS_HOME || join(homedir(), '.agent-canvas');
const bridgePort = Number(process.env.AGENT_CANVAS_PORT || 4317);
const webPort = Number(process.env.AGENT_CANVAS_WEB_PORT || 5173);

/**
 * Em dev, injeta no index.html o token de sessão que o bridge publicou em <home>/session.json.
 * Só a própria página consegue ler esse HTML (outras origens não leem respostas sem CORS).
 */
function sessionToken(): Plugin {
  return {
    name: 'agent-canvas-session',
    transformIndexHtml() {
      const file = join(home, 'session.json');
      if (!existsSync(file)) return [];
      const { token } = JSON.parse(readFileSync(file, 'utf8')) as { token: string };
      return [{ tag: 'meta', attrs: { name: 'agent-canvas-token', content: token }, injectTo: 'head' }];
    },
  };
}

export default defineConfig({
  plugins: [react(), sessionToken()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${bridgePort}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${bridgePort}`, ws: true, changeOrigin: true },
    },
  },
  // app local: um bundle só é o suficiente
  build: { chunkSizeWarningLimit: 1500 },
  test: { name: 'web', environment: 'jsdom' },
});
