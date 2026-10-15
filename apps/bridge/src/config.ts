import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BridgeConfig {
  /** Pasta de dados do app: banco, segredos, sessão. */
  home: string;
  host: '127.0.0.1';
  port: number;
  /** Origens do navegador aceitas (o Vite em dev e o próprio bridge em produção). */
  allowedOrigins: string[];
  /** Pasta com o build do front-end, servida pelo bridge quando existir. */
  webDist: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const home = env.AGENT_CANVAS_HOME || join(homedir(), '.agent-canvas');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const port = Number(env.AGENT_CANVAS_PORT || 4317);
  const webPort = Number(env.AGENT_CANVAS_WEB_PORT || 5173);
  const extra = (env.AGENT_CANVAS_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  const dist = new URL('../../web/dist', import.meta.url).pathname;
  return {
    home,
    host: '127.0.0.1',
    port,
    allowedOrigins: [
      `http://127.0.0.1:${webPort}`,
      `http://localhost:${webPort}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      ...extra,
    ],
    webDist: existsSync(join(dist, 'index.html')) ? dist : null,
  };
}
